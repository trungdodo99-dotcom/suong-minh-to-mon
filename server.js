const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const ACCOUNTS_FILE = path.join(__dirname, 'prison_accounts.json');

const VALID_ROLES = ['Tù Thường', 'Trưởng Buồng', 'Quản Tù'];

// Tọa độ hồi sinh mặc định trong không gian 3D (X, Z)
function getSpawnPoint(role, cell) {
  if (role === 'Quản Tù') {
    return { x: 0, z: 3.4, yaw: 0 }; // Trước bàn Quản Tù nhìn thẳng vào 2 buồng
  }
  if (cell === 2) {
    return {
      x: 3.8 + (Math.random() - 0.5) * 2.2,
      z: -4.0 + (Math.random() - 0.5) * 1.6,
      yaw: Math.PI
    };
  }
  return {
    x: -3.8 + (Math.random() - 0.5) * 2.2,
    z: -4.0 + (Math.random() - 0.5) * 1.6,
    yaw: Math.PI
  };
}

let accounts = {};

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch (e) {
    accounts = {};
  }

  // Tài khoản Quản Tù mặc định: Trung / 123456
  const adminKey = 'trung';
  if (!accounts[adminKey]) {
    accounts[adminKey] = {
      usernameKey: adminKey,
      name: 'Trung',
      password: '123456',
      role: 'Quản Tù',
      cell: 0,
      points: 9999,
      isAdmin: true,
      createdAt: Date.now()
    };
    saveAccounts();
  } else {
    accounts[adminKey].name = 'Trung';
    accounts[adminKey].password = '123456';
    accounts[adminKey].role = 'Quản Tù';
    accounts[adminKey].isAdmin = true;
    saveAccounts();
  }
}

function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  } catch (e) {}
}

loadAccounts();

const prisonState = {
  cells: {
    1: { locked: true, name: 'Buồng 1' },
    2: { locked: true, name: 'Buồng 2' }
  },
  alarmActive: false,
  chatHistory: []
};

const onlinePlayers = {};

function getPublicAccountsList() {
  return Object.values(accounts).map((acc) => ({
    usernameKey: acc.usernameKey,
    name: acc.name,
    role: acc.role,
    cell: acc.cell,
    points: acc.points || 0,
    isAdmin: Boolean(acc.isAdmin)
  }));
}

function pushChat(item) {
  prisonState.chatHistory.push(item);
  if (prisonState.chatHistory.length > 60) prisonState.chatHistory.shift();
  io.emit('chat_message', item);
}

function syncAccountPoints(player) {
  if (player && player.usernameKey && accounts[player.usernameKey]) {
    accounts[player.usernameKey].points = player.points;
    saveAccounts();
  }
}

function findNearestPlayer(actor, maxDist = 3.6, filterFn = null) {
  let nearest = null;
  let bestDist = maxDist;
  Object.values(onlinePlayers).forEach((p) => {
    if (p.id === actor.id) return;
    if (filterFn && !filterFn(p)) return;
    const d = Math.hypot(p.x - actor.x, p.z - actor.z);
    if (d <= bestDist) {
      bestDist = d;
      nearest = p;
    }
  });
  return nearest;
}

// Hồi máu nhẹ tự động theo thời gian
setInterval(() => {
  let changed = false;
  Object.values(onlinePlayers).forEach((p) => {
    if (p.hp < p.maxHp) {
      p.hp = Math.min(p.maxHp, p.hp + 2);
      changed = true;
    }
  });
  if (changed) io.emit('players_sync', onlinePlayers);
}, 15000);

io.on('connection', (socket) => {
  socket.emit('init_state', {
    prisonState,
    players: onlinePlayers,
    accountsList: getPublicAccountsList()
  });

  // 1. ĐĂNG KÝ TÙ NHÂN MỚI
  socket.on('register_account', (data, cb) => {
    const cleanName = (data.name || '').trim().replace(/\s+/g, ' ');
    const password = (data.password || '').trim();
    const cell = Number(data.cell) === 2 ? 2 : 1;

    if (!cleanName || cleanName.length < 2 || cleanName.length > 20) {
      return cb({ ok: false, msg: 'Tên nhân vật phải từ 2 đến 20 ký tự!' });
    }
    if (!password || password.length < 3) {
      return cb({ ok: false, msg: 'Mật khẩu phải từ 3 ký tự trở lên!' });
    }

    const key = cleanName.toLowerCase();
    if (accounts[key]) {
      return cb({ ok: false, msg: `Hồ sơ "${cleanName}" đã tồn tại!` });
    }

    accounts[key] = {
      usernameKey: key,
      name: cleanName,
      password,
      role: 'Tù Thường',
      cell,
      points: 100,
      isAdmin: false,
      createdAt: Date.now()
    };
    saveAccounts();
    io.emit('accounts_updated', getPublicAccountsList());

    pushChat({
      name: 'HỆ THỐNG TRẠI GIAM',
      role: 'SYSTEM',
      text: `⛓️ Phạm nhân mới "${cleanName}" đã nhập hồ sơ vào Buồng ${cell}!`,
      isSystem: true
    });

    return cb({
      ok: true,
      name: cleanName,
      msg: `Tạo hồ sơ "${cleanName}" thành công (Buồng ${cell} - Tù Thường). Bạn có thể đăng nhập ngay!`
    });
  });

  // 2. ĐĂNG NHẬP VÀO TRẠI
  socket.on('login_account', (data, cb) => {
    const cleanName = (data.name || '').trim().replace(/\s+/g, ' ');
    const password = (data.password || '').trim();
    const key = cleanName.toLowerCase();
    const acc = accounts[key];

    if (!acc) {
      return cb({ ok: false, msg: `Không tìm thấy hồ sơ "${cleanName}". Hãy đăng ký trước!` });
    }
    if (acc.password !== password) {
      return cb({ ok: false, msg: 'Mật khẩu không đúng!' });
    }

    // Đăng xuất phiên cũ nếu đăng nhập trùng tài khoản
    for (const [sid, pl] of Object.entries(onlinePlayers)) {
      if (pl.usernameKey === key && sid !== socket.id) {
        delete onlinePlayers[sid];
        io.to(sid).emit('force_logout', 'Tài khoản vừa đăng nhập trên thiết bị khác!');
      }
    }

    const spawn = getSpawnPoint(acc.role, acc.cell);
    onlinePlayers[socket.id] = {
      id: socket.id,
      usernameKey: acc.usernameKey,
      name: acc.name,
      role: acc.role,
      cell: acc.role === 'Quản Tù' ? 0 : (acc.cell || 1),
      isAdmin: Boolean(acc.isAdmin || acc.role === 'Quản Tù'),
      hp: 100,
      maxHp: 100,
      points: acc.points || 100,
      x: spawn.x,
      z: spawn.z,
      yaw: spawn.yaw,
      actionAnim: null,
      lastActionAt: 0
    };

    io.emit('players_sync', onlinePlayers);

    pushChat({
      name: 'LOA TRẠI GIAM',
      role: 'SYSTEM',
      text: `📢 [${acc.role}] ${acc.name} đã vào trại${acc.role === 'Quản Tù' ? ' (Khu vực trực ban)' : ` (Buồng ${acc.cell})`}!`,
      isSystem: true
    });

    return cb({
      ok: true,
      player: onlinePlayers[socket.id],
      prisonState,
      accountsList: getPublicAccountsList()
    });
  });

  // 3. ĐỒNG BỘ DI CHUYỂN & GÓC NHÌN 3D
  socket.on('player_transform', ({ x, z, yaw }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    if (typeof x === 'number') p.x = Math.max(-7.6, Math.min(7.6, x));
    if (typeof z === 'number') p.z = Math.max(-6.6, Math.min(5.6, z));
    if (typeof yaw === 'number') p.yaw = yaw;

    socket.broadcast.emit('player_moved', {
      id: socket.id,
      x: p.x,
      z: p.z,
      yaw: p.yaw
    });
  });

  // 4. KHÓA / MỞ CỬA SONG SẮT (CHỈ QUẢN TÙ)
  socket.on('toggle_cell_lock', ({ cellId }) => {
    const p = onlinePlayers[socket.id];
    if (!p || p.role !== 'Quản Tù') {
      socket.emit('toast_notice', { text: '⛔ Chỉ Quản Tù mới có chìa khóa mở/khóa buồng!', color: '#ef4444' });
      return;
    }
    const cell = prisonState.cells[cellId];
    if (!cell) return;

    cell.locked = !cell.locked;
    io.emit('prison_state_sync', prisonState);
    io.emit('sound_event', { type: 'door_lock', cellId, locked: cell.locked });

    pushChat({
      name: `👑 QUẢN TÙ ${p.name}`,
      role: 'SYSTEM',
      text: cell.locked
        ? `🔐 Đã KHÓA CHẶT cửa song sắt Buồng ${cellId}!`
        : `🔓 Đã MỞ KHÓA cửa song sắt Buồng ${cellId}!`,
      isSystem: true
    });
  });

  // 5. BẬT / TẮT CÒI BÁO ĐỘNG (CHỈ QUẢN TÙ)
  socket.on('toggle_alarm', () => {
    const p = onlinePlayers[socket.id];
    if (!p || p.role !== 'Quản Tù') return;

    prisonState.alarmActive = !prisonState.alarmActive;
    io.emit('prison_state_sync', prisonState);
    io.emit('sound_event', { type: 'alarm', active: prisonState.alarmActive });

    pushChat({
      name: '🚨 BÁO ĐỘNG TRẠI GIAM',
      role: 'SYSTEM',
      text: prisonState.alarmActive
        ? `🚨 Quản Tù ${p.name} đã KÍCH HOẠT BÁO ĐỘNG ĐỎ! Toàn bộ phạm nhân giữ nguyên vị trí!`
        : `✅ Quản Tù ${p.name} đã tắt còi báo động.`,
      isSystem: true
    });
  });

  // 6. ĐIỂM DANH & NHỐT VỀ BUỒNG (CHỈ QUẢN TÙ)
  socket.on('roll_call', () => {
    const p = onlinePlayers[socket.id];
    if (!p || p.role !== 'Quản Tù') return;

    prisonState.cells[1].locked = true;
    prisonState.cells[2].locked = true;

    Object.values(onlinePlayers).forEach((pl) => {
      if (pl.role !== 'Quản Tù') {
        const sp = getSpawnPoint(pl.role, pl.cell || 1);
        pl.x = sp.x;
        pl.z = sp.z;
        pl.yaw = sp.yaw;
        io.to(pl.id).emit('force_teleport', { x: pl.x, z: pl.z, yaw: pl.yaw, msg: '📢 Quản Tù gọi điểm danh! Bạn đã bị đưa về buồng và khóa cửa!' });
      }
    });

    io.emit('prison_state_sync', prisonState);
    io.emit('players_sync', onlinePlayers);
    io.emit('sound_event', { type: 'door_lock', locked: true });

    pushChat({
      name: `👑 QUẢN TÙ ${p.name}`,
      role: 'SYSTEM',
      text: '📢 ĐIỂM DANH KHẨN CẤP! Toàn bộ phạm nhân đã bị áp giải về buồng và khóa song sắt!',
      isSystem: true
    });
  });

  // 7. CÁC HÀNH ĐỘNG THEO CẤP ĐỘ NHÂN VẬT
  socket.on('role_action', ({ action, targetId }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;

    const now = Date.now();
    if (now - (p.lastActionAt || 0) < 1200) return;
    p.lastActionAt = now;

    // Xác định mục tiêu: ưu tiên target đang chọn nếu đủ gần, không thì lấy người gần nhất
    let target = targetId && onlinePlayers[targetId] && targetId !== p.id ? onlinePlayers[targetId] : null;
    if (target && Math.hypot(target.x - p.x, target.z - p.z) > 4.2) {
      target = null;
    }
    if (!target) {
      target = findNearestPlayer(p, 3.8);
    }

    // --- HÀNH ĐỘNG QUẢN TÙ: TRẤN ÁP DÙI CUI ---
    if (action === 'baton_strike') {
      if (p.role !== 'Quản Tù') return;
      io.emit('player_anim', { id: p.id, anim: 'attack' });
      if (!target) {
        socket.emit('toast_notice', { text: '⚡ Không có phạm nhân nào trong tầm vung dùi cui!', color: '#fbbf24' });
        return;
      }
      const dmg = 25;
      target.hp = Math.max(0, target.hp - dmg);
      const penalty = Math.min(15, target.points);
      target.points -= penalty;
      p.points += 10;
      syncAccountPoints(target);
      syncAccountPoints(p);

      io.emit('sound_event', { type: 'taser' });
      io.to(target.id).emit('toast_notice', { text: `⚡ Bị Quản Tù ${p.name} trấn áp! -${dmg} HP, -${penalty} điểm!`, color: '#ef4444' });
      socket.emit('toast_notice', { text: `⚡ Trấn áp [${target.role}] ${target.name} thành công (-${dmg} HP)!`, color: '#38bdf8' });

      if (target.hp <= 0) {
        target.hp = 100;
        const sp = getSpawnPoint(target.role, target.cell || 1);
        target.x = sp.x;
        target.z = sp.z;
        io.to(target.id).emit('force_teleport', { x: sp.x, z: sp.z, yaw: sp.yaw, msg: '💀 Bạn bị đánh ngất và bị tống lại vào buồng giam!' });
        pushChat({
          name: 'KỶ LUẬT TRẠI',
          role: 'SYSTEM',
          text: `⚡ Quản Tù ${p.name} đã hạ gục và áp giải ${target.name} về Buồng ${target.cell || 1}!`,
          isSystem: true
        });
      }
    }

    // --- HÀNH ĐỘNG ĐẤM (TRƯỞNG BUỒNG -20 HP | TÙ THƯỜNG -10 HP) ---
    else if (action === 'punch') {
      io.emit('player_anim', { id: p.id, anim: 'attack' });
      if (!target) {
        socket.emit('toast_notice', { text: '👊 Đấm vào không khí! Hãy tiến sát người khác hơn.', color: '#fbbf24' });
        return;
      }
      const dmg = p.role === 'Trưởng Buồng' ? 20 : 10;
      target.hp = Math.max(0, target.hp - dmg);
      io.emit('sound_event', { type: 'punch' });

      io.to(target.id).emit('toast_notice', { text: `👊 Bị [${p.role}] ${p.name} đấm (-${dmg} HP)!`, color: '#ef4444' });
      socket.emit('toast_notice', { text: `👊 Bạn vừa đấm ${target.name} (-${dmg} HP)!`, color: '#f97316' });

      if (target.hp <= 0) {
        target.hp = 100;
        const loot = Math.min(20, target.points);
        target.points -= loot;
        p.points += loot;
        syncAccountPoints(target);
        syncAccountPoints(p);
        const sp = getSpawnPoint(target.role, target.cell || 1);
        target.x = sp.x;
        target.z = sp.z;
        io.to(target.id).emit('force_teleport', { x: sp.x, z: sp.z, yaw: sp.yaw, msg: `💀 Bạn bị ${p.name} hạ đo ván (-${loot} điểm)!` });
        pushChat({
          name: 'ẨU ĐẢ TRONG BUỒNG',
          role: 'SYSTEM',
          text: `💥 [${p.role}] ${p.name} vừa đấm gục [${target.role}] ${target.name} (cướp ${loot} điểm)!`,
          isSystem: true
        });
      }
    }

    // --- TRƯỞNG BUỒNG: THU PHẾ BUỒNG ---
    else if (action === 'collect_tax') {
      if (p.role !== 'Trưởng Buồng') return;
      let totalCollected = 0;
      let count = 0;
      Object.values(onlinePlayers).forEach((other) => {
        if (other.id !== p.id && other.role === 'Tù Thường' && other.cell === p.cell) {
          const take = Math.min(10, other.points);
          if (take > 0) {
            other.points -= take;
            totalCollected += take;
            count++;
            syncAccountPoints(other);
            io.to(other.id).emit('toast_notice', { text: `🚬 Trưởng Buồng ${p.name} thu phế -${take} điểm!`, color: '#f59e0b' });
          }
        }
      });

      if (count === 0) {
        socket.emit('toast_notice', { text: '🚬 Không có Tù Thường nào còn điểm trong buồng để thu phế!', color: '#fbbf24' });
      } else {
        p.points += totalCollected;
        syncAccountPoints(p);
        pushChat({
          name: p.name,
          role: p.role,
          text: `🚬 Vừa đi một vòng thu phế Buồng ${p.cell}, hốt gọn +${totalCollected} điểm cải tạo!`,
          isSystem: false
        });
      }
    }

    // --- TRƯỞNG BUỒNG: CHIA CƠM BẢO KÊ ---
    else if (action === 'share_food') {
      if (p.role !== 'Trưởng Buồng') return;
      p.hp = Math.min(100, p.hp + 20);
      let healed = 0;
      Object.values(onlinePlayers).forEach((other) => {
        if (other.id !== p.id && other.cell === p.cell && other.role !== 'Quản Tù') {
          other.hp = Math.min(100, other.hp + 20);
          healed++;
          io.to(other.id).emit('toast_notice', { text: `🍱 Được Trưởng Buồng ${p.name} chia cơm (+20 HP)!`, color: '#4ade80' });
        }
      });
      socket.emit('toast_notice', { text: `🍱 Chia cơm bảo kê Buồng ${p.cell} (+20 HP cho bạn & ${healed} anh em)!`, color: '#4ade80' });
    }

    // --- TÙ THƯỜNG & TRƯỞNG BUỒNG: TẬP THỂ DỤC / HÍT ĐẤT CẢI TẠO ---
    else if (action === 'workout') {
      p.points += 10;
      p.hp = Math.min(100, p.hp + 8);
      syncAccountPoints(p);
      io.emit('player_anim', { id: p.id, anim: 'workout' });
      socket.emit('toast_notice', { text: '💪 Hít đất cải tạo: +10 Điểm, +8 HP!', color: '#4ade80' });
    }

    // --- TÙ THƯỜNG: NỘP PHẾ / ĐÚT LÓT ---
    else if (action === 'bribe') {
      if (p.points < 10) {
        socket.emit('toast_notice', { text: '⚠️ Cần ít nhất 10 điểm cải tạo để nộp phế/đút lót!', color: '#ef4444' });
        return;
      }
      const receiver = findNearestPlayer(p, 4.5, (pl) => pl.role === 'Trưởng Buồng' || pl.role === 'Quản Tù');
      if (!receiver) {
        socket.emit('toast_notice', { text: '🙏 Hãy lại gần Trưởng Buồng hoặc Quản Tù để nộp phế/đút lót!', color: '#fbbf24' });
        return;
      }
      p.points -= 10;
      p.hp = Math.min(100, p.hp + 15);
      receiver.points += 10;
      syncAccountPoints(p);
      syncAccountPoints(receiver);

      io.to(receiver.id).emit('toast_notice', { text: `🚬 ${p.name} vừa kính biếu bạn +10 điểm!`, color: '#fde047' });
      pushChat({
        name: p.name,
        role: p.role,
        text: `🙏 Kính biếu [${receiver.role}] ${receiver.name} 10 điểm lấy lòng (+15 HP)!`,
        isSystem: false
      });
    }

    // --- GÕ SONG SẮT GỌI QUẢN TÙ ---
    else if (action === 'clang_bars') {
      io.emit('sound_event', { type: 'bar_clang' });
      io.emit('player_anim', { id: p.id, anim: 'attack' });
      pushChat({
        name: p.name,
        role: p.role,
        text: p.role === 'Trưởng Buồng'
          ? `🔔 *KENG KENG* Cán bộ Quản Tù đâu rồi! Ra mở Buồng ${p.cell} cho anh em hít khí trời cái!`
          : `🙏 *KENG KENG* Cán bộ ơi cho em xin ân xá ra ngoài Buồng ${p.cell} với!`,
        isSystem: false
      });
    }

    // --- TÙ THƯỜNG: LỤC SOÁT BUỒNG ---
    else if (action === 'scavenge') {
      const roll = Math.random();
      if (roll < 0.4) {
        p.points += 15;
        syncAccountPoints(p);
        socket.emit('toast_notice', { text: '🔍 Lục gầm giường thấy gói thuốc lá lậu! (+15 Điểm)', color: '#fde047' });
      } else if (roll < 0.78) {
        p.hp = Math.min(100, p.hp + 15);
        socket.emit('toast_notice', { text: '🔍 Tìm thấy mẩu bánh mì giấu kỹ! (+15 HP)', color: '#4ade80' });
      } else {
        const loss = Math.min(8, p.points);
        p.points -= loss;
        syncAccountPoints(p);
        socket.emit('toast_notice', { text: `📹 Camera an ninh bắt gặp bạn lục đồ! (-${loss} Điểm)`, color: '#ef4444' });
      }
    }

    io.emit('players_sync', onlinePlayers);
    io.emit('accounts_updated', getPublicAccountsList());
  });

  // 8. QUẢN LÝ HỒ SƠ TRẠI (CHỈ QUẢN TÙ TRUNG HOẶC QUẢN TÙ ĐƯỢC PHONG)
  socket.on('admin_manage', (payload, cb) => {
    const me = onlinePlayers[socket.id];
    const isMasterPass = payload && payload.adminPass === '123456';
    if ((!me || me.role !== 'Quản Tù') && !isMasterPass) {
      return cb && cb({ ok: false, msg: 'Chỉ Quản Tù mới có quyền thao tác Sổ Quản Lý!' });
    }

    const { actionType, targetKey, newRole, newCell, pointsDelta } = payload;
    const acc = accounts[targetKey];
    if (!acc) return cb && cb({ ok: false, msg: 'Không tìm thấy hồ sơ!' });

    if (actionType === 'update') {
      if (acc.usernameKey === 'trung' && newRole && newRole !== 'Quản Tù') {
        return cb && cb({ ok: false, msg: 'Không thể giáng chức Quản Tù tối cao Trung!' });
      }
      if (VALID_ROLES.includes(newRole)) acc.role = newRole;
      if (acc.role === 'Quản Tù') {
        acc.cell = 0;
        acc.isAdmin = true;
      } else {
        acc.cell = Number(newCell) === 2 ? 2 : 1;
        acc.isAdmin = false;
      }

      if (typeof pointsDelta === 'number' && pointsDelta !== 0) {
        acc.points = Math.max(0, (acc.points || 0) + pointsDelta);
      }
      saveAccounts();

      Object.values(onlinePlayers).forEach((pl) => {
        if (pl.usernameKey === targetKey) {
          const oldCell = pl.cell;
          const oldRole = pl.role;
          pl.role = acc.role;
          pl.cell = acc.cell;
          pl.isAdmin = acc.isAdmin;
          pl.points = acc.points;

          // Nếu bị chuyển buồng hoặc đổi vai trò -> dịch chuyển vào vị trí mới
          if (oldCell !== pl.cell || oldRole !== pl.role) {
            const sp = getSpawnPoint(pl.role, pl.cell);
            pl.x = sp.x;
            pl.z = sp.z;
            pl.yaw = sp.yaw;
            io.to(pl.id).emit('force_teleport', {
              x: sp.x,
              z: sp.z,
              yaw: sp.yaw,
              msg: `📋 Quản Tù vừa điều chuyển bạn: [${pl.role}]${pl.cell ? ` - Buồng ${pl.cell}` : ''}!`
            });
          }
        }
      });

      io.emit('players_sync', onlinePlayers);
      io.emit('accounts_updated', getPublicAccountsList());
      pushChat({
        name: '📋 QUYẾT ĐỊNH QUẢN TÙ',
        role: 'SYSTEM',
        text: `⚖️ Hồ sơ "${acc.name}" đã cập nhật: Cấp [${acc.role}]${acc.cell ? ` • Buồng ${acc.cell}` : ''} • ${acc.points} điểm!`,
        isSystem: true
      });
      return cb && cb({ ok: true });
    }

    if (actionType === 'delete') {
      if (acc.usernameKey === 'trung') {
        return cb && cb({ ok: false, msg: 'Không thể xóa tài khoản Quản Tù Trung!' });
      }
      const deletedName = acc.name;
      delete accounts[targetKey];
      for (const [sid, pl] of Object.entries(onlinePlayers)) {
        if (pl.usernameKey === targetKey) {
          delete onlinePlayers[sid];
          io.to(sid).emit('force_logout', 'Bạn đã bị Quản Tù trục xuất khỏi trại!');
        }
      }
      saveAccounts();
      io.emit('players_sync', onlinePlayers);
      io.emit('accounts_updated', getPublicAccountsList());
      return cb && cb({ ok: true, msg: `Đã xóa hồ sơ ${deletedName}` });
    }
  });

  // 9. CHAT TRONG TRẠI
  socket.on('chat', ({ text }) => {
    const p = onlinePlayers[socket.id];
    if (!p || !text || !text.trim()) return;
    const clean = text.trim().slice(0, 180);
    pushChat({
      id: p.id,
      name: p.name,
      role: p.role,
      cell: p.cell,
      text: clean,
      isSystem: false
    });
  });

  // 10. ĐĂNG XUẤT / NGẮT KẾT NỐI
  socket.on('logout_prison', () => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    syncAccountPoints(p);
    const oldName = p.name;
    const oldRole = p.role;
    delete onlinePlayers[socket.id];
    io.emit('players_sync', onlinePlayers);
    pushChat({
      name: 'LOA TRẠI GIAM',
      role: 'SYSTEM',
      text: `🚪 [${oldRole}] ${oldName} đã rời khỏi khu giam.`,
      isSystem: true
    });
  });

  socket.on('disconnect', () => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    syncAccountPoints(p);
    const oldName = p.name;
    const oldRole = p.role;
    delete onlinePlayers[socket.id];
    io.emit('players_sync', onlinePlayers);
    pushChat({
      name: 'LOA TRẠI GIAM',
      role: 'SYSTEM',
      text: `💨 [${oldRole}] ${oldName} đã ngắt kết nối.`,
      isSystem: true
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⛓️  TRẠI GIAM ONLINE 3D đang chạy tại: http://localhost:${PORT}`);
  console.log(`👑 Tài khoản Quản Tù mặc định: Trung / 123456`);
});

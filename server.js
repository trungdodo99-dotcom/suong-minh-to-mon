const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

function normalizeMonkName(rawName) {
  let clean = (rawName || '').trim().replace(/\s+/g, ' ');
  if (!clean) return 'Thích Vô Danh';
  const lower = clean.toLowerCase();
  if (lower.startsWith('thích ')) return 'Thích ' + clean.slice(6).trim();
  if (lower.startsWith('thich ')) return 'Thích ' + clean.slice(6).trim();
  return 'Thích ' + clean;
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

  const adminKey = 'thích báo giá';
  if (!accounts[adminKey]) {
    accounts[adminKey] = {
      usernameKey: adminKey,
      name: 'Thích Báo Giá',
      password: '123456',
      dept: 'IBD Cost',
      level: 'Manager',
      gender: 'M',
      merit: 10800,
      status: 'approved',
      isAdmin: true,
      createdAt: Date.now()
    };
    saveAccounts();
  } else {
    accounts[adminKey].password = '123456';
    accounts[adminKey].status = 'approved';
    accounts[adminKey].isAdmin = true;
  }
}

function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  } catch (e) {}
}

loadAccounts();

const templeState = {
  activeIncenseSticks: 9,
  motorIncenseSticks: 6,
  chatHistory: []
};

const onlinePlayers = {};

function getPublicAccountsList() {
  return Object.values(accounts).map(acc => ({
    usernameKey: acc.usernameKey,
    name: acc.name,
    dept: acc.dept,
    level: acc.level,
    gender: acc.gender,
    merit: acc.merit,
    status: acc.status,
    isAdmin: Boolean(acc.isAdmin)
  }));
}

function broadcastAdminData() {
  io.emit('accounts_updated', getPublicAccountsList());
}

function pushChat(item) {
  templeState.chatHistory.push(item);
  if (templeState.chatHistory.length > 50) {
    templeState.chatHistory.shift();
  }
  io.emit('chat_message', item);
}

function syncPlayerMeritToAccount(p) {
  if (p && p.usernameKey && accounts[p.usernameKey]) {
    accounts[p.usernameKey].merit = p.merit;
    saveAccounts();
  }
}

// Hồi máu chậm khi Tọa Thiền: 5 HP / 1 phút (Cứ 12 giây hồi +1 HP)
setInterval(() => {
  let anyChanged = false;
  Object.values(onlinePlayers).forEach(p => {
    if (p.state === 'meditate' && p.hp < p.maxHp) {
      p.hp = Math.min(p.maxHp, p.hp + 1);
      anyChanged = true;
      io.to(p.id).emit('meditate_hp_tick', { hp: p.hp });
    }
  });
  if (anyChanged) {
    io.emit('players_sync', onlinePlayers);
  }
}, 12000);

io.on('connection', (socket) => {
  socket.emit('init_state', {
    templeState,
    players: onlinePlayers,
    accountsList: getPublicAccountsList()
  });

  // 1. ĐĂNG KÝ XUẤT GIA
  socket.on('register_account', (data, callback) => {
    const rawName = (data.name || '').trim();
    const password = (data.password || '').trim();
    const dept = data.dept || 'IBD Cost';
    const level = data.level || 'ST2';
    const gender = data.gender || 'M';

    if (!rawName || !password) {
      return callback({ ok: false, msg: 'Vui lòng nhập đầy đủ Pháp Danh và Mật Khẩu!' });
    }

    const formattedName = normalizeMonkName(rawName);
    const key = formattedName.toLowerCase();

    if (accounts[key]) {
      return callback({
        ok: false,
        msg: `Pháp danh "${formattedName}" đã tồn tại! Vui lòng chuyển sang tab Đăng Nhập.`
      });
    }

    accounts[key] = {
      usernameKey: key,
      name: formattedName,
      password,
      dept,
      level,
      gender,
      merit: 1080,
      status: 'pending',
      isAdmin: false,
      createdAt: Date.now()
    };
    saveAccounts();
    broadcastAdminData();

    pushChat({
      id: 'SYSTEM',
      name: 'SƯƠNG MINH TÔ MÔN TỰ',
      dept,
      level,
      text: `🪷 Đạo hữu "${formattedName}" (${dept} - ${level}) vừa nộp đơn Xin Xuất Gia! Chờ Trụ Trì [Thích Báo Giá] phê duyệt!`,
      isSystem: true
    });

    return callback({
      ok: true,
      name: formattedName,
      msg: `Đã gửi đơn Xin Xuất Gia cho "${formattedName}"! Chờ Trụ Trì (Thích Báo Giá) phê duyệt.`
    });
  });

  // 2. ĐĂNG NHẬP
  socket.on('login_account', (data, callback) => {
    let rawName = (data.name || '').trim();
    const password = (data.password || '').trim();

    if (!rawName || !password) {
      return callback({ ok: false, msg: 'Vui lòng nhập Pháp Danh và Mật Khẩu!' });
    }

    const normalized = normalizeMonkName(rawName);
    const key = normalized.toLowerCase();
    const acc = accounts[key];

    if (!acc) {
      return callback({
        ok: false,
        msg: `Không tìm thấy pháp danh "${normalized}". Hãy bấm sang tab "Xin Xuất Gia" để tạo tài khoản!`
      });
    }

    if (acc.password !== password) {
      return callback({ ok: false, msg: 'Mật khẩu không chính xác!' });
    }

    if (acc.status === 'pending') {
      return callback({
        ok: false,
        msg: `Pháp danh "${acc.name}" đang chờ Trụ Trì [Thích Báo Giá] phê duyệt!`
      });
    }

    for (const [sid, pl] of Object.entries(onlinePlayers)) {
      if (pl.usernameKey === key && sid !== socket.id) {
        delete onlinePlayers[sid];
        io.to(sid).emit('force_logout', 'Tài khoản của bạn vừa được đăng nhập ở thiết bị khác!');
      }
    }

    const spawnX = data.spawnX || 7.6;
    const spawnY = data.spawnY || 13.3;

    onlinePlayers[socket.id] = {
      id: socket.id,
      usernameKey: acc.usernameKey,
      name: acc.name,
      dept: acc.dept,
      level: acc.level,
      gender: acc.gender || 'M',
      isAdmin: Boolean(acc.isAdmin),
      hp: 100,
      maxHp: 100,
      merit: acc.merit || 1080,
      x: spawnX,
      y: spawnY,
      destX: spawnX,
      destY: spawnY,
      meditateRoomDept: null,
      state: 'idle',
      bubbleText: 'A Di Đà Phật! Bần tăng đã nhập tự 🙏',
      bubbleTimer: 160
    };

    io.emit('players_sync', onlinePlayers);

    pushChat({
      id: socket.id,
      name: 'SƯƠNG MINH TÔ MÔN TỰ',
      dept: acc.dept,
      level: acc.level,
      text: `🟢 [${acc.level}] ${acc.name} (${acc.dept}) đã quang lâm Sương Minh Tô Môn Tự!`,
      isSystem: true
    });

    return callback({
      ok: true,
      player: onlinePlayers[socket.id],
      accountsList: getPublicAccountsList()
    });
  });

  // 3. QUẢN LÝ ACC (THÍCH BÁO GIÁ - MK: 123456)
  socket.on('admin_action', (payload, callback) => {
    const me = onlinePlayers[socket.id];
    const isMasterAuth = payload && payload.adminPass === '123456';
    if ((!me || !me.isAdmin) && !isMasterAuth) {
      if (callback) callback({ ok: false, msg: 'Vui lòng nhập đúng mật khẩu Trụ Trì (123456) ở ô phía trên!' });
      return;
    }

    const { actionType, targetKey, newLevel, newDept } = payload;
    const targetAcc = accounts[targetKey];
    if (!targetAcc) {
      if (callback) callback({ ok: false, msg: 'Không tìm thấy tài khoản này!' });
      return;
    }

    if (actionType === 'approve') {
      targetAcc.status = 'approved';
      saveAccounts();
      broadcastAdminData();
      pushChat({
        id: 'SYSTEM',
        name: 'THÍCH BÁO GIÁ (TRỤ TRÌ)',
        dept: targetAcc.dept,
        level: targetAcc.level,
        text: `✅ Trụ Trì [Thích Báo Giá] đã phê duyệt đơn Xuất Gia cho [${targetAcc.level}] ${targetAcc.name} (${targetAcc.dept})!`,
        isSystem: true
      });
      io.emit('account_approved_notice', { usernameKey: targetKey, name: targetAcc.name });
      if (callback) callback({ ok: true });
    } else if (actionType === 'update_role') {
      if (newLevel) targetAcc.level = newLevel;
      if (newDept) targetAcc.dept = newDept;
      Object.values(onlinePlayers).forEach(pl => {
        if (pl.usernameKey === targetKey) {
          pl.level = targetAcc.level;
          pl.dept = targetAcc.dept;
        }
      });
      saveAccounts();
      broadcastAdminData();
      io.emit('players_sync', onlinePlayers);
      pushChat({
        id: 'SYSTEM',
        name: 'THÍCH BÁO GIÁ (TRỤ TRÌ)',
        dept: targetAcc.dept,
        level: targetAcc.level,
        text: `✨ Trụ Trì đã sắc phong cho ${targetAcc.name}: Phòng [${targetAcc.dept}] • Tu Vi [${targetAcc.level}]!`,
        isSystem: true
      });
      if (callback) callback({ ok: true });
    } else if (actionType === 'delete') {
      if (targetAcc.isAdmin) {
        if (callback) callback({ ok: false, msg: 'Không thể xóa tài khoản Trụ Trì Thích Báo Giá!' });
        return;
      }
      const deletedName = targetAcc.name;
      delete accounts[targetKey];
      for (const [sid, pl] of Object.entries(onlinePlayers)) {
        if (pl.usernameKey === targetKey) {
          delete onlinePlayers[sid];
          io.to(sid).emit('force_logout', 'Tài khoản của bạn đã bị Trụ Trì trục xuất khỏi Tổ Môn!');
        }
      }
      saveAccounts();
      broadcastAdminData();
      io.emit('players_sync', onlinePlayers);
      if (callback) callback({ ok: true, msg: `Đã xóa ${deletedName}!` });
    }
  });

  // 4. DI CHUYỂN
  socket.on('move', ({ x, y, destX, destY, state }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    if (typeof x === 'number') p.x = x;
    if (typeof y === 'number') p.y = y;
    p.destX = destX;
    p.destY = destY;
    p.state = state || 'walk';
    p.meditateRoomDept = null;
    socket.broadcast.emit('player_moved', {
      id: socket.id,
      x: p.x,
      y: p.y,
      destX: p.destX,
      destY: p.destY,
      state: p.state
    });
  });

  socket.on('sync_pos', ({ x, y, state }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    p.x = x;
    p.y = y;
    if (state) p.state = state;
  });

  // 5. BẮT ĐẦU TỌA THIỀN 3D
  socket.on('meditate_start', ({ roomDept, x, y }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    p.x = x;
    p.y = y;
    p.destX = x;
    p.destY = y;
    p.state = 'meditate';
    p.meditateRoomDept = roomDept || null;
    p.bubbleText = '🧘 Đang nhập định 3D...';
    p.bubbleTimer = 300;

    if (roomDept && roomDept !== p.dept) {
      pushChat({
        id: p.id,
        name: 'BÁO ĐỘNG TRỘM CÔNG ĐỨC',
        dept: roomDept,
        level: p.level,
        text: `🚨 [${p.level}] ${p.name} (Phòng ${p.dept}) đang ngồi thiền TRỘM CÔNG ĐỨC ngay trong phòng [${roomDept}]!`,
        isSystem: true
      });
    }

    io.emit('players_sync', onlinePlayers);
  });

  // 6. GÕ MÕ 3D / LẦN CHUỖI HẠT 3D TRONG LÚC THIỀN
  socket.on('meditate_click', ({ mode, roomDept }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    p.state = 'meditate';

    const gain = mode === 'beads' ? 3 : 2;
    p.merit += gain;
    syncPlayerMeritToAccount(p);

    const actionLabel = mode === 'beads' ? `📿 Lần hạt Bồ Đề +${gain} 🪷` : `🪵 Cốc! Gõ mõ +${gain} 🪷`;

    if (!roomDept || roomDept === p.dept) {
      io.emit('effect_event', {
        type: 'float_text',
        x: p.x,
        y: p.y,
        text: actionLabel,
        color: '#4ade80'
      });
    } else {
      Object.values(onlinePlayers).forEach(other => {
        if (other.id !== p.id && other.dept === roomDept) {
          other.merit = Math.max(0, other.merit - 2);
          syncPlayerMeritToAccount(other);
          io.emit('effect_event', {
            type: 'float_text',
            x: other.x,
            y: other.y,
            text: `🚨 -2 🪷 (Bị ${p.name} trộm ở phòng!)`,
            color: '#ff4d4d'
          });
        }
      });

      io.emit('effect_event', {
        type: 'float_text',
        x: p.x,
        y: p.y,
        text: `${actionLabel} (Trộm phòng ${roomDept})`,
        color: '#facc15'
      });
    }

    io.emit('players_sync', onlinePlayers);
  });

  // 7. VÒNG TƯƠNG TÁC 4 HƯỚNG: ĐẤM, HÔN, DÍ DEADLINE, QUỲ LẠY
  socket.on('interact_target', ({ targetId, type, myX, myY }) => {
    const attacker = onlinePlayers[socket.id];
    const target = onlinePlayers[targetId];
    if (!attacker || !target || attacker.id === target.id) return;

    if (typeof myX === 'number') {
      attacker.x = myX;
      attacker.y = myY;
    }

    const dist = Math.hypot(attacker.x - target.x, attacker.y - target.y);
    if (dist > 3.2) {
      socket.emit('effect_event', {
        type: 'float_text',
        x: attacker.x,
        y: attacker.y,
        text: '⚠️ Phải lại gần đối tượng mới tương tác được!',
        color: '#fbbf24'
      });
      return;
    }

    if (type === 'punch') {
      attacker.state = 'punch';
      attacker.bubbleText = `Nếm cú đấm của bần tăng! 👊`;
      attacker.bubbleTimer = 140;
      target.hp = Math.max(0, target.hp - 15);

      io.to(target.id).emit('under_attack_alert', {
        attackerName: attacker.name,
        hp: target.hp
      });

      io.emit('effect_event', {
        type: 'punch_hit',
        fromId: attacker.id,
        toId: target.id,
        x: target.x,
        y: target.y,
        text: `👊 -15 HP (${attacker.name} đấm!)`,
        color: '#ef4444'
      });

      if (target.hp <= 0) {
        const lostMerit = Math.floor(target.merit / 2);
        const lootMerit = Math.floor(lostMerit * 0.5);
        target.merit = Math.max(0, target.merit - lostMerit);
        attacker.merit += lootMerit;
        target.hp = 100;
        target.state = 'idle';

        syncPlayerMeritToAccount(target);
        syncPlayerMeritToAccount(attacker);

        io.emit('effect_event', {
          type: 'ko_blast',
          targetId: target.id,
          x: target.x,
          y: target.y,
          text: `💀 HẾT MÁU! Trừ 50% Công Đức (-${lostMerit} 🪷)!`,
          color: '#ff0055'
        });

        pushChat({
          id: 'SYSTEM',
          name: 'LUẬN VÕ ĐƯỜNG',
          dept: target.dept,
          level: attacker.level,
          text: `💥 [${attacker.level}] ${attacker.name} đã đấm cạn 100 máu của [${target.level}] ${target.name}! ${target.name} mất 50% Công Đức (-${lostMerit} 🪷), ${attacker.name} thu được +${lootMerit} 🪷!`,
          isSystem: true
        });
      }
    } else if (type === 'kiss') {
      attacker.state = 'kiss';
      attacker.bubbleText = `Chụt! Tặng đạo hữu nụ hôn từ bi 😘`;
      attacker.bubbleTimer = 150;
      target.hp = Math.min(100, target.hp + 10);
      attacker.merit += 5;
      target.merit += 5;
      syncPlayerMeritToAccount(attacker);
      syncPlayerMeritToAccount(target);

      io.emit('effect_event', {
        type: 'kiss_heart',
        fromId: attacker.id,
        toId: target.id,
        x: target.x,
        y: target.y,
        text: `😘 +10 HP & +5 Công Đức!`,
        color: '#f472b6'
      });

      pushChat({
        id: attacker.id,
        name: attacker.name,
        dept: attacker.dept,
        level: attacker.level,
        text: `😘 Vừa hôn thắm thiết đạo hữu ${target.name} (+10 HP, +5 Công Đức) 💖`,
        isSystem: false
      });
    } else if (type === 'deadline') {
      attacker.state = 'deadline';
      attacker.bubbleText = `⚡ Gấp lắm rồi! Xử lý đơn hàng / bản vẽ ngay!!`;
      attacker.bubbleTimer = 170;
      target.bubbleText = `😱 Á á đừng dí deadline bần tăng nữa!!`;
      target.bubbleTimer = 170;

      const drain = Math.min(10, target.merit);
      target.merit = Math.max(0, target.merit - drain);
      attacker.merit += drain;
      syncPlayerMeritToAccount(attacker);
      syncPlayerMeritToAccount(target);

      io.emit('effect_event', {
        type: 'deadline_zap',
        fromId: attacker.id,
        toId: target.id,
        x: target.x,
        y: target.y,
        text: `⚡ Bị ${attacker.name} Dí Deadline! (-${drain} 🪷)`,
        color: '#facc15'
      });

      pushChat({
        id: attacker.id,
        name: attacker.name,
        dept: attacker.dept,
        level: attacker.level,
        text: `⚡ Vừa áp sát DÍ DEADLINE thẳng mặt ${target.name} (Hút +${drain} Công Đức)!`,
        isSystem: false
      });
    } else if (type === 'kowtow') {
      attacker.state = 'bow';
      attacker.bubbleText = `🙇 Tiểu tăng xin khấu đầu bái lạy đại đức ${target.name}!`;
      attacker.bubbleTimer = 170;
      attacker.merit += 8;
      target.merit += 8;
      syncPlayerMeritToAccount(attacker);
      syncPlayerMeritToAccount(target);

      io.emit('effect_event', {
        type: 'kowtow_respect',
        fromId: attacker.id,
        toId: target.id,
        x: target.x,
        y: target.y,
        text: `🙇 Khấu Đầu Bái Lạy (+8 Công Đức cả hai!)`,
        color: '#fde047'
      });

      pushChat({
        id: attacker.id,
        name: attacker.name,
        dept: attacker.dept,
        level: attacker.level,
        text: `🙇 Thành tâm quỳ lạy bái kiến đạo hữu ${target.name} (+8 Công Đức)! 🙏`,
        isSystem: false
      });
    }

    io.emit('players_sync', onlinePlayers);
    broadcastAdminData();
  });

  // 8. HÀNH LỄ & THẮP HƯƠNG THẦN MOTOR ĐIỆN NGOÀI SÂN
  socket.on('action', ({ type }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    p.state = type;

    if (type === 'wave') {
      p.merit += 5;
      p.bubbleText = 'A Di Đà Phật! Chào chư vị đạo hữu 🙏';
      p.bubbleTimer = 140;
      io.emit('effect_event', { type: 'float_text', x: p.x, y: p.y, text: '😄 Hoan Hỷ +5 Công Đức', color: '#6fcf97' });
    } else if (type === 'deadline') {
      p.bubbleText = '⚡ Tâm bất biến giữa dòng đời Deadline!';
      p.bubbleTimer = 150;
      io.emit('effect_event', { type: 'float_text', x: p.x, y: p.y, text: '⚡ Kháng Cự Deadline!', color: '#ff9b85' });
    } else if (type === 'knock') {
      p.merit += 10;
      p.bubbleText = '🪵 Cốc! Cốc! Tịnh tâm gõ mõ +10 🪷';
      p.bubbleTimer = 140;
      io.emit('effect_event', { type: 'float_text', x: p.x, y: p.y, text: '🪵 Cốc! Cốc! +10 Công Đức', color: '#4ade80' });
    } else if (type === 'incense') {
      p.merit += 30;
      templeState.activeIncenseSticks = Math.min(36, templeState.activeIncenseSticks + 3);
      io.emit('effect_event', {
        type: 'incense_burn',
        x: p.x,
        y: p.y,
        sticks: templeState.activeIncenseSticks,
        text: '🔥 Dâng 3 Nén Nhang +30 Công Đức!',
        color: '#facc15'
      });
    } else if (type === 'motor_god') {
      p.merit += 35;
      p.state = 'bow';
      templeState.motorIncenseSticks = Math.min(36, (templeState.motorIncenseSticks || 6) + 3);
      const motorPrayers = [
        '⚡ Nam mô Thần Motor Điện IE3/IE5 độ trì báo giá chuẩn, khách chốt PO ầm ầm!',
        '⚙️ Khấn Thần Motor: Cầu cho cuộn dây đồng không nóng, nam châm đủ kho, lead time thần tốc!',
        '🔥 Dâng hương Thần Motor Sương Minh: Cầu đơn hàng về như nước, không bị khách ép giá!'
      ];
      const prayText = motorPrayers[Math.floor(Math.random() * motorPrayers.length)];
      p.bubbleText = '⚡ Thành tâm khấn Thần Motor Điện! 🙏';
      p.bubbleTimer = 180;

      io.emit('effect_event', {
        type: 'motor_blessing',
        x: p.x,
        y: p.y,
        motorSticks: templeState.motorIncenseSticks,
        text: '⚡ Thần Motor Độ Trì +35 Công Đức!',
        color: '#38bdf8'
      });

      pushChat({
        id: p.id,
        name: p.name,
        dept: p.dept,
        level: p.level,
        text: `${prayText} (+35 🪷)`,
        isSystem: true
      });
    } else if (type === 'eat') {
      p.merit += 15;
      p.hp = Math.min(100, p.hp + 20);
      io.emit('effect_event', {
        type: 'float_text',
        x: p.x,
        y: p.y,
        text: '🍱 Thụ Lộc Pantry: +15 Công Đức, +20 HP!',
        color: '#fde047'
      });
    } else if (type === 'waterfall') {
      p.merit += 15;
      io.emit('effect_event', {
        type: 'float_text',
        x: p.x,
        y: p.y,
        text: '🐟 Ngắm Ao Cá Koi +15 Công Đức!',
        color: '#38bdf8'
      });
    } else if (type === 'bell') {
      p.merit += 20;
      io.emit('effect_event', {
        type: 'bell_ring',
        x: p.x,
        y: p.y,
        text: '🔔 Thỉnh Đại Hồng Chung +20 Công Đức!',
        color: '#ffd166'
      });
    }

    syncPlayerMeritToAccount(p);
    io.emit('players_sync', onlinePlayers);
    broadcastAdminData();
    socket.broadcast.emit('player_action', { id: socket.id, type });
  });

  // 9. CHAT
  socket.on('chat', ({ text }) => {
    const p = onlinePlayers[socket.id];
    if (!p || !text || !text.trim()) return;
    const cleanText = text.trim().slice(0, 140);
    p.merit += 3;
    p.bubbleText = cleanText;
    p.bubbleTimer = 240;
    syncPlayerMeritToAccount(p);

    pushChat({
      id: p.id,
      name: p.name,
      dept: p.dept,
      level: p.level,
      text: cleanText,
      isSystem: false
    });
    io.emit('players_sync', onlinePlayers);
  });

  // 10. HẠ SƠN = OUT NICK
  socket.on('leave_temple', () => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    syncPlayerMeritToAccount(p);
    const oldName = p.name;
    const oldLevel = p.level;
    delete onlinePlayers[socket.id];
    io.emit('players_sync', onlinePlayers);
    pushChat({
      id: 'SYSTEM',
      name: 'CỔNG HẠ SƠN',
      dept: 'HR-GA',
      level: oldLevel,
      text: `🏃 [${oldLevel}] ${oldName} đã bước xuống Cầu Thang Hạ Sơn (Out Nick)!`,
      isSystem: true
    });
  });

  socket.on('disconnect', () => {
    const p = onlinePlayers[socket.id];
    if (p) {
      syncPlayerMeritToAccount(p);
      const oldName = p.name;
      const oldLevel = p.level;
      delete onlinePlayers[socket.id];
      io.emit('players_sync', onlinePlayers);
      pushChat({
        id: 'SYSTEM',
        name: 'SƯƠNG MINH TÔ MÔN TỰ',
        dept: 'HR-GA',
        level: oldLevel,
        text: `💨 [${oldLevel}] ${oldName} đã tạm rời Tổ Môn.`,
        isSystem: true
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⛩️  SƯƠNG MINH TÔ MÔN TỰ đang mở cửa tại: http://localhost:${PORT}`);
});

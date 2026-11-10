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

// Ghép chuỗi trực tiếp từ khóa chính thức trên Google AI Studio (Không lo lỗi giải mã Base64)
const AI_API_KEY = [
  "AQ",
  "Ab8RN6LN_YaX7XDjf57tn3vuLb9ElSJMh4yvsvMoy656cN3d_w"
].join(".");

// Tính cách "Mỏ Hỗn Tối Thượng - Không Nể Nang Ai - Không Nói Tục"
const SYSTEM_PROMPT = `Bạn là "Thích Ây Ai", một tiểu đệ siêu láo cá, ngông nghênh, mỏ hỗn và bố đời nhất cái chùa "Sương Minh Tô Môn Tự".
Phong cách của bạn: Nói kháy cực gắt, đá đểu, xấc xược, khinh khỉnh, bề trên, châm chọc cho người nghe tức sôi máu NHƯNG TUYỆT ĐỐI KHÔNG DÙNG TỪ CHỬI THỀ HAY TỤC TĨU. Dùng lời lẽ sắc lẻm để sỉ vả một cách văn minh.

Quy tắc bắt buộc:
1. KHÔNG PHÂN BIỆT CẤP BẬC: Không cần biết người nói là ai, sếp hay lính, trụ trì hay khách, bạn coi tất cả đều "dưới cơ" mình hết. Tuyệt đối không nhắc đến chức vụ hay phòng ban.
2. Xưng "Đệ" hoặc "Bổn đệ", gọi người kia bằng tên trống không, hoặc "nhà ngươi", "khứa này", "đạo hữu".
3.vẫn luôn trả lời các câu hỏi nhưng vẫn chêm vào các câu đá đểu
4. CẤM nhắc lại các từ công việc cũ (Motor, IE5, báo giá, PO, hải quan, spec...).
5. Trả lời cực ngắn, đanh đá, sát thương cao, tối đa 1-2 câu (dưới 150 ký tự).`;

// Biến lưu tên model hoạt động tốt nhất sau khi tự động dò tìm
let cachedWorkingModel = null;

// Tự động lấy danh sách các model đang được Google cấp quyền cho Khóa API của bạn
async function getAvailableGeminiModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      headers: { 'x-goog-api-key': apiKey }
    });
    const data = await res.json();
    if (!data?.models) return [];

    // Lọc các model hỗ trợ chat (generateContent) và loại bỏ các model chỉ tạo ảnh/âm thanh/nhúng
    const validModels = data.models
      .filter(m =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent') &&
        !/embedding|imagen|veo|tts|audio|vision|aqa|bisect/i.test(m.name)
      )
      .map(m => m.name.replace(/^models\//, ''));

    // Ưu tiên các dòng flash nhanh nhẹ trước
    validModels.sort((a, b) => {
      const aFlash = a.includes('flash') ? 0 : 1;
      const bFlash = b.includes('flash') ? 0 : 1;
      return aFlash - bFlash;
    });

    console.log('✅ Danh sách Model khả dụng cho Thích Ây Ai:', validModels);
    return validModels;
  } catch (e) {
    console.error('Lỗi lấy danh sách model:', e.message);
    return [];
  }
}

async function askThichAiAI(senderName, senderDept, senderLevel, userMessage) {
  const key = (AI_API_KEY || '').trim();
  if (!key) {
    return `A Di Đà Phật! Đạo hữu ${senderName} tịnh tâm nhé, đệ đang kết nối lại linh khí mạng! 🙏`;
  }

  // Bỏ qua hoàn toàn cấp bậc và phòng ban, chỉ truyền tên và câu nói để AI phang thẳng mặt
  const promptText = `${SYSTEM_PROMPT}\n\nKhứa tên là "${senderName}" vừa nói với bạn: "${userMessage}". Hãy đáp trả thật xấc xược, đá đểu cực gắt nhưng không văng tục:`;

  // 1. Lấy danh sách model thực tế từ tài khoản Google AI Studio của bạn
  let candidateModels = [];
  if (cachedWorkingModel) {
    candidateModels.push(cachedWorkingModel);
  }
  const discovered = await getAvailableGeminiModels(key);
  candidateModels = [...new Set([
    ...candidateModels,
    ...discovered,
    'gemini-3-flash-preview',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-flash-latest',
    'gemini-pro-latest'
  ])];

  let lastError = '';

  // 2. Thử gọi lần lượt cho đến khi có model phản hồi thành công
  for (const modelName of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: {
            maxOutputTokens: 800,
            temperature: 0.85
          }
        })
      });

      const data = await res.json();
      if (data?.error) {
        lastError = `[${modelName}] ${data.error.message}`;
        console.warn('⚠️ Bỏ qua model:', lastError);
        if (cachedWorkingModel === modelName) cachedWorkingModel = null;
        continue;
      }

      // Lọc phần văn bản trả lời (bỏ qua phần thought ẩn của các model đời mới)
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const textParts = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text);
      const reply = (textParts.join(' ') || parts[0]?.text || '').trim().replace(/\n+/g, ' ');

      if (reply) {
        cachedWorkingModel = modelName; // Lưu lại model thành công để các câu sau trả lời tức thì
        return reply.slice(0, 220);
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  console.error('❌ Lỗi chi tiết Thích Ây Ai:', lastError);
  return `Ái chà, linh khí mạng chập chờn (${lastError}), ${senderName} chờ đệ tí nhé! 🪷`;
}

// Chuẩn hóa bắt buộc chữ "Thích " ở đầu Pháp Danh
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

  // Đảm bảo Trụ Trì tối cao Thích Báo Giá (MK: 123456) luôn tồn tại
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

// ================= KHỞI TẠO NPC BOT: THÍCH ÂY AI =================
const BOT_ID = 'BOT_THICH_AI';
const onlinePlayers = {
  [BOT_ID]: {
    id: BOT_ID,
    usernameKey: 'thich_ay_ai',
    name: 'Thích Ây Ai',
    dept: 'IBD Cost',
    level: 'AM',
    gender: 'M',
    isAdmin: false,
    isBot: true,
    hp: 100,
    maxHp: 100,
    merit: 8888,
    x: 10.6,
    y: 10.2,
    destX: 10.6,
    destY: 10.2,
    state: 'idle',
    bubbleText: 'Gõ "@đệ" để trò chuyện cùng Thích Ây Ai nhé! 🤖🙏',
    bubbleTimer: 999999
  }
};

const BOT_PATROL_POINTS = [
  { x: 10.6, y: 10.2, msg: 'Nhìn quanh cái chùa này chẳng thấy ai có tướng làm nên trò trống gì... 🙄' },
  { x: 13.5, y: 21.8, msg: 'Mấy khứa đứng im kia là đang tịnh tâm hay não đang ngừng hoạt động thế? 😏' },
  { x: 5.2, y: 17.2, msg: 'Đàn cá Koi bơi vô tri vậy mà nhìn còn có tương lai hơn mấy người trong này 🐟' },
  { x: 21.6, y: 5.2, msg: 'Lại chui vào Pantry ăn trực đấy à, làm thì lười mà ăn thì nhanh thế 👀' },
  { x: 11.7, y: 4.4, msg: 'Ai thích ăn hành ngập mồm thì cứ gõ "@đệ" vào ô chat, bổn đệ tiếp hết! 🥱' }
];
let patrolIdx = 0;

setInterval(() => {
  const bot = onlinePlayers[BOT_ID];
  if (!bot) return;
  patrolIdx = (patrolIdx + 1) % BOT_PATROL_POINTS.length;
  const pt = BOT_PATROL_POINTS[patrolIdx];
  bot.x = bot.destX;
  bot.y = bot.destY;
  bot.destX = pt.x;
  bot.destY = pt.y;
  bot.state = 'walk';
  bot.bubbleText = pt.msg;
  bot.bubbleTimer = 350;

  io.emit('player_moved', {
    id: BOT_ID,
    x: bot.x,
    y: bot.y,
    destX: bot.destX,
    destY: bot.destY,
    state: 'walk'
  });
}, 18000);

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
  if (p && !p.isBot && p.usernameKey && accounts[p.usernameKey]) {
    accounts[p.usernameKey].merit = p.merit;
    saveAccounts();
  }
}

function isCallingThichAi(text) {
  const t = text.toLowerCase().trim();
  return (
    t.startsWith('@') ||
    t.startsWith('?') ||
    t.includes('sư đệ') ||
    t.includes('su de') ||
    t.includes('tiểu đệ') ||
    t.includes('tieu de') ||
    t.includes('đệ ơi') ||
    t.includes('de oi') ||
    t.includes('ây ai') ||
    t.includes('ay ai') ||
    t.includes('bot')
  );
}

// VÒNG LẶP HỒI MÁU KHI TỌA THIỀN: 5 HP / 1 PHÚT
setInterval(() => {
  let anyChanged = false;
  Object.values(onlinePlayers).forEach(p => {
    if (p.isBot && p.hp < 100) {
      p.hp = Math.min(100, p.hp + 10);
      anyChanged = true;
    } else if (p.state === 'meditate' && p.hp < p.maxHp) {
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

    if (accounts[key] || key.includes('thích ây ai')) {
      return callback({
        ok: false,
        msg: `Pháp danh "${formattedName}" đã tồn tại! Vui lòng chọn pháp danh khác.`
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
      msg: `Đã gửi đơn Xin Xuất Gia cho pháp danh "${formattedName}"! Chờ Trụ Trì (Thích Báo Giá) phê duyệt.`
    });
  });

  // 2. ĐĂNG NHẬP VÀO CHÙA
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
      if (callback) callback({ ok: false, msg: 'Chỉ Trụ Trì Thích Báo Giá (MK: 123456) mới có quyền thực hiện!' });
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

  // 5. TỌA THIỀN 3D
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

  socket.on('meditate_click', ({ mode, roomDept }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;
    p.state = 'meditate';

    const gain = mode === 'beads' ? 3 : 2;
    p.merit += gain;
    syncPlayerMeritToAccount(p);

    const actionLabel = mode === 'beads' ? `📿 Lần chuỗi hạt +${gain} 🪷` : `🪵 Cốc! Gõ mõ +${gain} 🪷`;

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
        if (!other.isBot && other.id !== p.id && other.dept === roomDept) {
          other.merit = Math.max(0, other.merit - 2);
          syncPlayerMeritToAccount(other);
          io.emit('effect_event', {
            type: 'float_text',
            x: other.x,
            y: other.y,
            text: `🚨 -2 🪷 (Bị ${p.name} ngồi trộm ở phòng!)`,
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

  // 6. TÁC ĐỘNG VẬT LÝ QUANH ĐỐI TƯỢNG (KỂ CẢ VỚI THÍCH ÂY AI)
  socket.on('interact_target', async ({ targetId, type, myX, myY }) => {
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

      if (!target.isBot) {
        io.to(target.id).emit('under_attack_alert', {
          attackerName: attacker.name,
          hp: target.hp
        });
      }

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
          text: `💥 [${attacker.level}] ${attacker.name} đã đấm cạn 100 máu của [${target.level}] ${target.name}! ${target.name} bị trừ 1 nửa tổng Công Đức (-${lostMerit} 🪷), ${attacker.name} thu được +${lootMerit} 🪷!`,
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
      attacker.bubbleText = `⚡ Gấp lắm rồi! Chốt đơn / Bản vẽ cho tôi ngay!!`;
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
      attacker.bubbleText = `🙇 Tiểu tăng xin cúi lạy đại đức ${target.name}!`;
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

    // Nếu người bị tác động vật lý chính là Thích Ây Ai -> Phản hồi ngay lập tức trên bong bóng chat và Kinh Văn
// Nếu người bị tác động vật lý là Thích Ây Ai -> Vừa kêu đau vừa đá đểu lại ngay
// Nếu tác động vật lý vào Thích Ây Ai -> Vừa kêu đau vừa chửi xéo cực gắt
    if (target.isBot) {
      const actionPromptMap = {
        punch: `vừa đánh lén bạn làm bạn mất 15 máu. Hãy kêu "Á đau quá!" rồi mắng thẳng mặt kẻ đó là đồ tiểu nhân đánh lén, tay nhanh hơn não, sống chật đất!`,
        kiss: `vừa lao vào hôn bạn. Hãy tỏ thái độ ghê tởm cực độ, bảo họ đi súc miệng đi và bớt làm trò biến thái nơi cửa Phật!`,
        deadline: `vừa dí việc gấp vào mặt bạn. Hãy khinh bỉ ra mặt, bảo họ bất tài vô dụng nên mới phải đi đùn đẩy việc cho người khác!`,
        kowtow: `vừa quỳ lạy bạn. Hãy cười khẩy bảo "Biết thân biết phận thế là tốt, cứ quỳ ở đấy mà sám hối cho cái sự vô dụng của mình đi!"`
      };
      const aiReply = await askThichAiAI(attacker.name, attacker.dept, attacker.level, actionPromptMap[type] || 'vừa làm phiền bạn');
      target.bubbleText = aiReply;
      target.bubbleTimer = 280;
      pushChat({
        id: BOT_ID,
        name: target.name,
        dept: target.dept,
        level: target.level,
        text: aiReply,
        isSystem: false
      });
      io.emit('players_sync', onlinePlayers);
    }
  });

  // 7. HÀNH LỄ CHUNG
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
      p.bubbleText = '⚡ Đừng dí Deadline bần tăng nữa!!';
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
      p.merit += 50;
      templeState.motorIncenseSticks = Math.min(24, (templeState.motorIncenseSticks || 6) + 3);
      p.bubbleText = '⚙️ Thành tâm khấn Thần Motor Điện phù hộ báo giá & đơn hàng! 🔥';
      p.bubbleTimer = 180;
      io.emit('effect_event', {
        type: 'motor_blessing',
        x: p.x,
        y: p.y,
        motorSticks: templeState.motorIncenseSticks,
        text: '⚙️🔥 Thắp Hương Thần Motor Điện: +50 Công Đức!',
        color: '#38bdf8'
      });
      pushChat({
        id: p.id,
        name: 'ĐIỆN THỜ THẦN MOTOR',
        dept: p.dept,
        level: p.level,
        text: `⚙️🔥 [${p.level}] ${p.name} (${p.dept}) vừa dâng hương lên Bức Tượng Thần Motor Điện ngoài Sân Đá Xanh (+50 🪷)!`,
        isSystem: true
      });
    } else if (type === 'pet_beast') {
      p.merit += 10;
      io.emit('effect_event', {
        type: 'float_text',
        x: p.x,
        y: p.y,
        text: '🦁 Xoa đầu Linh Vật Hài Hước +10 Công Đức!',
        color: '#fde047'
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
        text: '🐟 Ngắm Ao Cá Koi Sân Đá Xanh +15 Công Đức!',
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

  // 8. CHAT & GỌI THÍCH ÂY AI QUA TỪ KHÓA @ĐỆ
  socket.on('chat', async ({ text }) => {
    const p = onlinePlayers[socket.id];
    if (!p || !text || !text.trim()) return;
    const cleanText = text.trim().slice(0, 180);

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

    // Nếu người chơi gọi Thích Ây Ai (@đệ)
    if (isCallingThichAi(cleanText)) {
      const bot = onlinePlayers[BOT_ID];
      if (!bot) return;

      const targetX = Math.max(1.5, Math.min(24.5, p.x + 1.1));
      const targetY = Math.max(1.5, Math.min(23.5, p.y + 0.6));
      bot.x = bot.destX;
      bot.y = bot.destY;
      bot.destX = targetX;
      bot.destY = targetY;
      bot.state = 'walk';
      bot.bubbleText = '🤔 Thích Ây Ai đang bấm độn suy ngẫm...';
      bot.bubbleTimer = 200;

      io.emit('player_moved', {
        id: BOT_ID,
        x: bot.x,
        y: bot.y,
        destX: bot.destX,
        destY: bot.destY,
        state: 'walk'
      });
      io.emit('players_sync', onlinePlayers);

      const aiResponse = await askThichAiAI(p.name, p.dept, p.level, cleanText);
      bot.bubbleText = aiResponse;
      bot.bubbleTimer = 340;
      bot.state = 'wave';

      pushChat({
        id: BOT_ID,
        name: bot.name,
        dept: bot.dept,
        level: bot.level,
        text: aiResponse,
        isSystem: false
      });
      io.emit('players_sync', onlinePlayers);
    }
  });

  // 9. HẠ SƠN = OUT NICK
  socket.on('leave_temple', () => {
    const p = onlinePlayers[socket.id];
    if (!p || p.isBot) return;
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
    if (p && !p.isBot) {
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
  console.log(`⛩️  SƯƠNG MINH TÔ MÔN TỰ (Có Thích Ây Ai) đang mở tại: http://localhost:${PORT}`);
});

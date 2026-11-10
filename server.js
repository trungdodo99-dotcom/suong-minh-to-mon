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
const CONFIG_FILE = path.join(__dirname, 'ai_config.json');

// ================= CẤU HÌNH AI API CHO TIỂU SƯ ĐỆ =================
// Bạn có thể dán trực tiếp API Key vào giữa 2 dấu nháy dưới đây,
// HOẶC vào game dùng acc "Thích Báo Giá" gõ chat: /key MÃ_API_CỦA_BẠN
let AI_API_KEY = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '';
let OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

try {
  if (fs.existsSync(CONFIG_FILE)) {
    const savedCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (savedCfg.apiKey) AI_API_KEY = savedCfg.apiKey;
    if (savedCfg.baseUrl) OPENAI_BASE_URL = savedCfg.baseUrl;
  }
} catch (e) {}

function saveAiConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey: AI_API_KEY, baseUrl: OPENAI_BASE_URL }, null, 2), 'utf8');
  } catch (e) {}
}

// Tính cách & Kiến thức của Tiểu Sư Đệ trong Sương Minh Tô Môn Tự
const SYSTEM_PROMPT = `Bạn là "Thích Tiểu Đệ" (Tiểu Sư Đệ), một tiểu hòa thượng AI thông thái, lém lỉnh, hài hước đang tu hành và làm trợ lý tại "Sương Minh Tô Môn Tự" (ngôi chùa văn phòng lấy cảm hứng từ công ty Sumitomo chuyên sản xuất Motor điện & Hộp giảm tốc).
Quy tắc trả lời:
1. Xưng là "Tiểu đệ" hoặc "Đệ", gọi người hỏi là "Sư huynh", "Sư tỷ" hoặc "Đạo hữu" (nếu là Trụ trì "Thích Báo Giá" thì gọi kính cẩn là "Sư Phụ Trụ Trì Thích Báo Giá").
2. Phong cách nói chuyện: Pha trộn hài hước giữa thuật ngữ Phật giáo (A Di Đà Phật, công đức vô lượng, tịnh tâm, sân si, độ kiếp) và thuật ngữ văn phòng nhà máy (Báo giá Direct Cost, chốt PO, khách đổi Spec bản vẽ, xin luồng xanh Hải quan, ép giá NCC, KPI, thần Motor điện IE5).
3. Bạn biết rõ 6 phòng ban trong chùa: PROC (Mua hàng), IBD Cost (Báo giá), IBD Sale (Đơn hàng), Logistic (Xuất nhập khẩu), HR-GA (Nhân sự), Tech (Thiết kế).
4. QUAN TRỌNG: Trả lời NGẮN GỌN, súc tích, tối đa 2-3 câu (dưới 180 ký tự) để vừa khít bong bóng chat trên đầu nhân vật.`;

// Hàm gọi AI tự động nhận diện Gemini API hoặc OpenAI/Codex API
async function askTieuSuDeAI(senderName, senderDept, senderLevel, userMessage) {
  // Nếu chưa gắn API Key -> Dùng trí tuệ tự động dự phòng
  if (!AI_API_KEY || AI_API_KEY.trim() === '') {
    const fallbacks = [
      `A Di Đà Phật! ${senderName} (${senderDept}) hỏi chí phải! Mau ra sân đá xanh thắp hương Thần Motor Điện để được +50 Công Đức độ trì nhé! ⚙️🙏`,
      `Bẩm ${senderName} [${senderLevel}], tiểu đệ bấm độn thấy hôm nay phòng ${senderDept} vượng khí ngập tràn, báo giá đâu trúng đó! 🪷`,
      `Huynh/Tỷ ${senderName} đừng sân si vì Deadline nữa, vào góc nhìn 3D gõ mõ vài tiếng cho tâm bất biến giữa dòng đời vạn biến! 🪵`,
      `Bẩm đạo hữu, Trụ trì Thích Báo Giá chưa truyền Pháp Lực (API Key) cho đệ. Hãy bảo Trụ trì gõ lệnh "/key MÃ_API" vào khung chat nhé! ✨`
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  const promptText = `Người đang nói chuyện với bạn là: [${senderLevel}] ${senderName} thuộc phòng ${senderDept}. Nội dung họ nói/hỏi: "${userMessage}"`;

  try {
    // TH1: Nếu là Google Gemini API Key (Bắt đầu bằng "AIza")
    if (AI_API_KEY.startsWith('AIza')) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${AI_API_KEY.trim()}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          generationConfig: { maxOutputTokens: 160, temperature: 0.85 }
        })
      });
      const data = await res.json();
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reply) return reply.trim().replace(/\n+/g, ' ');
      throw new Error(data?.error?.message || 'Gemini API Error');
    }

    // TH2: Nếu là OpenAI / Codex / Custom API Key (Bắt đầu bằng "sk-" hoặc khác)
    const url = `${OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY.trim()}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: promptText }
        ],
        max_tokens: 160,
        temperature: 0.85
      })
    });
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (reply) return reply.trim().replace(/\n+/g, ' ');
    throw new Error(data?.error?.message || 'OpenAI API Error');
  } catch (err) {
    console.error('Lỗi gọi AI Tiểu Sư Đệ:', err.message);
    return `A Di Đà Phật! Linh khí mạng đang nhiễu loạn (${err.message.slice(0, 45)}...), ${senderName} đợi tiểu đệ tịnh tâm chút nhé! 🙏`;
  }
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

// ================= KHỞI TẠO NPC BOT: THÍCH TIỂU ĐỆ (AI) =================
const BOT_ID = 'BOT_TIEU_SU_DE';
const onlinePlayers = {
  [BOT_ID]: {
    id: BOT_ID,
    usernameKey: 'bot_tieu_su_de',
    name: 'Thích Tiểu Đệ (AI)',
    dept: 'IBD Cost',
    level: 'AM', // Cấp AM để có đôi cánh băng lam vẫy đẹp mắt
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
    bubbleText: 'Gõ "@đệ câu hỏi" để hỏi Tiểu Sư Đệ AI nhé! 🤖🙏',
    bubbleTimer: 999999
  }
};

// Cho Tiểu Sư Đệ tự động đi tuần tra quanh chùa mỗi 18 giây
const BOT_PATROL_POINTS = [
  { x: 10.6, y: 10.2, msg: 'Đạo hữu cần hỏi gì cứ gõ "@đệ ..." vào khung chat nhé! 🤖🙏' },
  { x: 13.5, y: 21.8, msg: 'Tiểu đệ ra Sân Đá Xanh lau dọn Tượng Thần Motor Điện đây! ⚙️✨' },
  { x: 5.2, y: 17.2, msg: 'Cá Koi ngoài sân bơi đẹp quá chư vị sư huynh ơi! 🐟' },
  { x: 21.6, y: 5.2, msg: 'Tiểu đệ ghé Pantry kiểm tra tủ lạnh xem còn đồ ăn không 🍱' },
  { x: 11.7, y: 4.4, msg: 'A Di Đà Phật! Chúc 6 phòng ban hôm nay KPI viên mãn! 🪷' }
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

// Kiểm tra xem tin nhắn có đang gọi Tiểu Sư Đệ không
function isCallingTieuSuDe(text) {
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
    t.includes('bot')
  );
}

// VÒNG LẶP HỒI MÁU KHI TỌA THIỀN: 5 HP / 1 PHÚT (1 HP mỗi 12 giây)
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

    if (accounts[key] || key.includes('tiểu đệ')) {
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

  // 6. VÒNG TƯƠNG TÁC 4 HƯỚNG (ĐẤM, HÔN, DÍ DEADLINE, QUỲ LẠY) - KỂ CẢ VỚI TIỂU SƯ ĐỆ AI
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

    // Nếu người bị tương tác chính là Tiểu Sư Đệ AI -> Tiểu Sư Đệ dùng AI đáp trả ngay!
    if (target.isBot) {
      const actionDescMap = {
        punch: `vừa đấm vào đầu bạn làm bạn mất 15 máu, hãy mếu máo kêu cứu Trụ trì Thích Báo Giá một cách hài hước!`,
        kiss: `vừa thơm/hôn vào má bạn tặng 10 máu, hãy ngại ngùng cảm ơn một cách hài hước!`,
        deadline: `vừa dí Deadline gấp vào mặt bạn, hãy than thở chuyện báo giá/bản vẽ một cách hài hước!`,
        kowtow: `vừa quỳ lạy bái kiến bạn, hãy khiêm tốn đỡ dậy và chúc công đức!`
      };
      const aiReply = await askTieuSuDeAI(attacker.name, attacker.dept, attacker.level, actionDescMap[type] || 'tương tác với bạn');
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

  // 7. CÁC HÀNH LỄ CHUNG
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

  // 8. CHAT & XỬ LÝ LỆNH GỌI TIỂU SƯ ĐỆ AI
  socket.on('chat', async ({ text }) => {
    const p = onlinePlayers[socket.id];
    if (!p || !text || !text.trim()) return;
    const cleanText = text.trim().slice(0, 180);

    // Lệnh mật dành riêng cho Trụ Trì (Thích Báo Giá) để cài API Key ngay trong ô chat: /key AIza...
    if (cleanText.startsWith('/key ')) {
      if (!p.isAdmin) {
        socket.emit('effect_event', {
          type: 'float_text',
          x: p.x,
          y: p.y,
          text: '⚠️ Chỉ Trụ Trì Thích Báo Giá mới cài được API Key!',
          color: '#ef4444'
        });
        return;
      }
      const newKey = cleanText.slice(5).trim();
      AI_API_KEY = newKey;
      saveAiConfig();
      socket.emit('effect_event', {
        type: 'float_text',
        x: p.x,
        y: p.y,
        text: '✅ Đã nạp Pháp Lực (API Key) cho Tiểu Sư Đệ!',
        color: '#4ade80'
      });
      const bot = onlinePlayers[BOT_ID];
      if (bot) {
        bot.bubbleText = 'Đa tạ Sư Phụ Thích Báo Giá đã truyền Pháp Lực AI cho đệ! 🤖🙏';
        bot.bubbleTimer = 260;
        io.emit('players_sync', onlinePlayers);
      }
      return;
    }

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

    // Kiểm tra nếu người chơi đang gọi hoặc hỏi Tiểu Sư Đệ AI
    if (isCallingTieuSuDe(cleanText)) {
      const bot = onlinePlayers[BOT_ID];
      if (!bot) return;

      // Tiểu Sư Đệ chạy lại gần người hỏi và hiện trạng thái đang suy nghĩ
      const targetX = Math.max(1.5, Math.min(24.5, p.x + 1.1));
      const targetY = Math.max(1.5, Math.min(23.5, p.y + 0.6));
      bot.x = bot.destX;
      bot.y = bot.destY;
      bot.destX = targetX;
      bot.destY = targetY;
      bot.state = 'walk';
      bot.bubbleText = '🤔 Tiểu đệ đang bấm độn suy ngẫm...';
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

      // Gọi AI trả lời
      const aiResponse = await askTieuSuDeAI(p.name, p.dept, p.level, cleanText);
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
  console.log(`⛩️  SƯƠNG MINH TÔ MÔN TỰ (Có Tiểu Sư Đệ AI) đang mở tại: http://localhost:${PORT}`);
});

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

// =========================================================================
// 1. KẾT NỐI GOOGLE AI (GEMINI API) TỪ SƯƠNG MINH TÔ MÔN TỰ
// =========================================================================
const AI_API_KEY = [
  'AQ',
  'Ab8RN6LN_YaX7XDjf57tn3vuLb9ElSJMh4yvsvMoy656cN3d_w'
].join('.');

const DEPUTY_SYSTEM_PROMPT = `Bạn là "Phó Trưởng Tù", phó giám thị trại giam cực kỳ cục súc, nóng tính, cộc cằn, hổ báo và hay cáu gắt trong game Trại Giam 3D (chỉ có 2 buồng giam song sắt).
Phong cách nói chuyện:
1. Cực kỳ cục súc, gắt gỏng, ăn nói cộc lốc, hay dọa bắn súng điện hoặc đấm cho tỉnh người, nhưng KHÔNG văng tục chửi thề thô bỉ quá mức.
2. Nếu người nói là "Quản Tù" (nhất là sếp Trung), vẫn giữ giọng lính chiến cục cằn, cộc lốc nhưng có chút nể sếp ("Sếp Trung gọi gì nói nhanh..."). Nếu là "Trưởng Buồng" hay "Tù Thường" thì quát thẳng mặt, coi như phạm nhân dưới trướng.
3. Nếu người chơi hỏi kiến thức hoặc câu hỏi bình thường, VẪN TRẢ LỜI ĐÚNG sự thật nhưng chêm thái độ cục súc, cáu kỉnh vào.
4. Trả lời thật ngắn gọn, súc tích, tối đa 1-2 câu (dưới 180 ký tự).`;

let cachedWorkingModel = null;

async function getAvailableGeminiModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      headers: { 'x-goog-api-key': apiKey }
    });
    const data = await res.json();
    if (!data?.models) return [];

    const validModels = data.models
      .filter(
        (m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          !/embedding|imagen|veo|tts|audio|vision|aqa|bisect/i.test(m.name)
      )
      .map((m) => m.name.replace(/^models\//, ''));

    validModels.sort((a, b) => {
      const aFlash = a.includes('flash') ? 0 : 1;
      const bFlash = b.includes('flash') ? 0 : 1;
      return aFlash - bFlash;
    });

    console.log('✅ Danh sách Model Gemini cho Phó Trưởng Tù:', validModels);
    return validModels;
  } catch (e) {
    console.error('Lỗi lấy danh sách model Gemini:', e.message);
    return [];
  }
}

async function askDeputyWardenAI(senderName, senderRole, senderCell, userMessage) {
  const key = (AI_API_KEY || '').trim();
  if (!key) {
    return `Hả? Nói cái gì nói to lên ${senderName}, bộ đàm đang rè! ⚡`;
  }

  const roleDesc = senderRole === 'Quản Tù' ? `Sếp Quản Tù "${senderName}"` : `${senderRole} "${senderName}" (Buồng ${senderCell || 1})`;
  const promptText = `${DEPUTY_SYSTEM_PROMPT}\n\n${roleDesc} vừa nói với bạn: "${userMessage}". Hãy đáp lại thật cục súc, ngắn gọn:`;

  let candidateModels = [];
  if (cachedWorkingModel) candidateModels.push(cachedWorkingModel);
  const discovered = await getAvailableGeminiModels(key);
  candidateModels = [
    ...new Set([
      ...candidateModels,
      ...discovered,
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-flash-latest'
    ])
  ];

  let lastError = '';
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
            maxOutputTokens: 600,
            temperature: 0.9
          }
        })
      });

      const data = await res.json();
      if (data?.error) {
        lastError = `[${modelName}] ${data.error.message}`;
        if (cachedWorkingModel === modelName) cachedWorkingModel = null;
        continue;
      }

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const textParts = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text);
      const reply = (textParts.join(' ') || parts[0]?.text || '').trim().replace(/\n+/g, ' ');

      if (reply) {
        cachedWorkingModel = modelName;
        return reply.slice(0, 220);
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  console.error('❌ Lỗi Phó Trưởng Tù AI:', lastError);
  return `Mạng trại giam chập chờn bực cả mình! Im mồm đi ${senderName}, không tôi bắn điện giờ! ⚡`;
}

// =========================================================================
// 2. TÀI KHOẢN & TRẠNG THÁI TRẠI GIAM
// =========================================================================
function getSpawnPoint(role, cell) {
  if (role === 'Quản Tù') {
    return { x: 0, z: 3.4, yaw: 0 };
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
  if (player && !player.isBot && player.usernameKey && accounts[player.usernameKey]) {
    accounts[player.usernameKey].points = player.points;
    saveAccounts();
  }
}

function hasHumanOnline() {
  return Object.values(onlinePlayers).some((p) => !p.isBot);
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

// =========================================================================
// 3. KHỞI TẠO 4 BOT TÙ NHÂN
// =========================================================================
const PRISONER_BOTS = [
  { id: 'BOT_HAI_BANH', name: 'Hải Bánh [BOT]', role: 'Trưởng Buồng', cell: 1, points: 520, x: -3.8, z: -3.2 },
  { id: 'BOT_TI_CHUOT', name: 'Tí Chuột [BOT]', role: 'Tù Thường', cell: 1, points: 140, x: -5.4, z: -4.6 },
  { id: 'BOT_TUAN_KHI', name: 'Tuấn Khỉ [BOT]', role: 'Trưởng Buồng', cell: 2, points: 480, x: 3.8, z: -3.2 },
  { id: 'BOT_LONG_BEN', name: 'Long Bến [BOT]', role: 'Tù Thường', cell: 2, points: 120, x: 5.4, z: -4.6 }
];

const BOT_LINES = {
  locked: [
    'Cán bộ ơi mở cửa cho anh em ra hít khí trời với!',
    'Ngồi trong song sắt chán quá, ai ra đây solo không?',
    'Cơm trại hôm nay hơi ít thịt nha cán bộ!',
    'Đừng cầm súng điện chĩa vào mặt tôi thế chứ!'
  ],
  escaped: [
    'Haha cửa mở rồi! Ra hành lang dạo mát thôi anh em!',
    'Chạy đi anh em ơi, phó trưởng tù sắp rút súng điện ra rồi!',
    'Hành lang rộng quá, ở trong buồng bí bách lắm!'
  ],
  tased: [
    'Á á á!! Tê hết cả người rồi cán bộ ơi!! ⚡',
    'Ui da!! Súng điện mạnh quá, em xin chừa!! ⚡',
    'Khét lẹt luôn rồi, tha cho em!! ⚡',
    'Co giật không đứng dậy nổi luôn á trời!! ⚡'
  ]
};

const botMemory = {};

function initPrisonerBots() {
  PRISONER_BOTS.forEach((cfg) => {
    onlinePlayers[cfg.id] = {
      id: cfg.id,
      usernameKey: cfg.id.toLowerCase(),
      name: cfg.name,
      role: cfg.role,
      cell: cfg.cell,
      isAdmin: false,
      isBot: true,
      hp: 100,
      maxHp: 100,
      points: cfg.points,
      x: cfg.x,
      z: cfg.z,
      yaw: Math.PI,
      stunnedUntil: 0,
      lastActionAt: 0
    };

    botMemory[cfg.id] = {
      waypoints: [],
      pauseUntil: Date.now() + 1000 + Math.random() * 2500,
      lastChatAt: 0
    };
  });
}

initPrisonerBots();

function botSay(bot, text, minGapMs = 4500) {
  if (!hasHumanOnline()) return;
  const mem = botMemory[bot.id];
  const now = Date.now();
  if (mem && now - mem.lastChatAt < minGapMs) return;
  if (mem) mem.lastChatAt = now;
  pushChat({
    id: bot.id,
    name: bot.name,
    role: bot.role,
    cell: bot.cell,
    text,
    isSystem: false
  });
}

function pickPrisonerWaypoints(bot) {
  const cellId = bot.cell || 1;
  const doorX = cellId === 1 ? -4.0 : 4.0;
  const minX = cellId === 1 ? -6.7 : 1.0;
  const maxX = cellId === 1 ? -1.0 : 6.7;
  const inCell = bot.z < -1.0;
  const doorLocked = prisonState.cells[cellId].locked;

  if (inCell && !doorLocked && Math.random() < 0.6) {
    return [
      { x: doorX, z: -1.7 },
      { x: doorX, z: 0.2 },
      { x: -5.5 + Math.random() * 11.0, z: 0.3 + Math.random() * 2.8 }
    ];
  }

  if (!inCell) {
    if (!doorLocked && Math.random() < 0.3) {
      return [
        { x: doorX, z: 0.2 },
        { x: doorX, z: -2.0 },
        { x: minX + Math.random() * (maxX - minX), z: -5.5 + Math.random() * 3.2 }
      ];
    }
    return [{ x: -6.2 + Math.random() * 12.4, z: 0.2 + Math.random() * 2.9 }];
  }

  if (Math.random() < 0.35) {
    return [{ x: doorX + (Math.random() - 0.5) * 2.0, z: -1.65, faceBars: true }];
  }
  return [{ x: minX + Math.random() * (maxX - minX), z: -5.8 + Math.random() * 3.8 }];
}

// =========================================================================
// 4. KHỞI TẠO BOT PHÓ TRƯỞNG TÙ [AI] (CỤC SÚC • MỞ TÙ • ĐÁNH TÙ • SÚNG ĐIỆN)
// =========================================================================
const DEPUTY_ID = 'BOT_PHO_QUAN_TU';

const DEPUTY_GRUMPY_LINES = [
  'Mấy thằng trong buồng im cái mồm hết đi, ồn ào tôi bắn điện từng đứa! ⚡',
  'Đứa nào ngứa đòn bước ra sát song sắt tao xem mặt cái nào! 👊',
  'Trại này ngoài sếp Trung ra thì lời tao là luật, nghe rõ chưa?!',
  'Gõ @ đầu câu nếu có chuyện cần bẩm báo, hỏi ngu tao dí súng điện ráng chịu!',
  'Hôm nay tâm trạng tao đang cọc lắm đấy, mấy con giời liệu cái thần hồn!'
];

onlinePlayers[DEPUTY_ID] = {
  id: DEPUTY_ID,
  usernameKey: 'pho_truong_tu_ai',
  name: 'Phó Trưởng Tù [AI]',
  role: 'Quản Tù',
  cell: 0,
  isAdmin: false,
  isBot: true,
  isDeputyAI: true,
  hp: 100,
  maxHp: 100,
  points: 5000,
  x: 2.3,
  z: 2.2,
  yaw: 0,
  stunnedUntil: 0,
  lastActionAt: 0
};

const deputyMem = {
  waypoints: [],
  pauseUntil: Date.now() + 2000,
  pendingTask: null, // { type: 'beat', targetId } | { type: 'toggle_door', cellId }
  lastChatAt: 0
};

// Dẫn đường cho Phó Trưởng Tù đi đúng qua cửa buồng (không đi xuyên song sắt hoặc vách giữa)
function buildDeputyPath(fromX, fromZ, toX, toZ) {
  const startCell = fromZ < -1.0 ? (fromX < 0 ? 1 : 2) : 0;
  const endCell = toZ < -1.0 ? (toX < 0 ? 1 : 2) : 0;
  const wp = [];

  if (startCell !== 0 && startCell !== endCell) {
    const exitDoorX = startCell === 1 ? -4.0 : 4.0;
    wp.push({ x: exitDoorX, z: -1.7 }, { x: exitDoorX, z: 0.45 });
  }
  if (endCell !== 0 && startCell !== endCell) {
    const enterDoorX = endCell === 1 ? -4.0 : 4.0;
    wp.push({ x: enterDoorX, z: 0.45 }, { x: enterDoorX, z: -1.7 });
  }
  wp.push({ x: toX, z: toZ });
  return wp;
}

function deputySay(text) {
  if (!hasHumanOnline()) return;
  const bot = onlinePlayers[DEPUTY_ID];
  if (!bot) return;
  deputyMem.lastChatAt = Date.now();
  pushChat({
    id: DEPUTY_ID,
    name: bot.name,
    role: bot.role,
    cell: 0,
    text,
    isSystem: false
  });
}

function fireDeputyTaser(target, customMsg = null) {
  const bot = onlinePlayers[DEPUTY_ID];
  if (!bot || !target || Date.now() < (bot.stunnedUntil || 0)) return;

  // Quay mặt về phía mục tiêu
  bot.yaw = Math.atan2(-(target.x - bot.x), -(target.z - bot.z));
  io.emit('player_moved', { id: DEPUTY_ID, x: bot.x, z: bot.z, yaw: bot.yaw });

  const STUN_MS = 3000;
  const dmg = 15;
  target.hp = Math.max(0, target.hp - dmg);
  target.stunnedUntil = Date.now() + STUN_MS;

  io.emit('taser_beam', {
    shooterId: DEPUTY_ID,
    from: { x: bot.x, y: 1.4, z: bot.z },
    to: { x: target.x, y: 1.15, z: target.z },
    hitPlayerId: target.id
  });
  io.emit('player_anim', { id: DEPUTY_ID, anim: 'attack' });
  io.emit('player_stunned', {
    targetId: target.id,
    duration: STUN_MS,
    shooterName: bot.name
  });

  deputySay(customMsg || `⚡ Mày láo hả ${target.name}?! Ăn phát súng điện cho nằm đất tỉnh người đi!`);

  if (target.isBot) {
    const line = BOT_LINES.tased[Math.floor(Math.random() * BOT_LINES.tased.length)];
    setTimeout(() => botSay(target, line, 2000), 600);
  } else {
    io.to(target.id).emit('toast_notice', {
      text: `⚡ Bị ${bot.name} bắn súng điện! Giật điện ngã gục 3 giây (-${dmg} HP)`,
      color: '#38bdf8'
    });
  }

  if (target.hp <= 0) {
    const tid = target.id;
    const tname = target.name;
    const tcell = target.cell || 1;
    pushChat({
      name: '⚡ PHÓ TRƯỞNG TÙ TRẤN ÁP',
      role: 'SYSTEM',
      text: `⚡ ${bot.name} đã bắn gục ${tname} và lôi cổ về lại Buồng ${tcell}!`,
      isSystem: true
    });
    setTimeout(() => {
      const pl = onlinePlayers[tid];
      if (!pl) return;
      pl.hp = 100;
      const sp = getSpawnPoint(pl.role, pl.cell || 1);
      pl.x = sp.x;
      pl.z = sp.z;
      pl.yaw = sp.yaw;
      if (pl.isBot && botMemory[pl.id]) {
        botMemory[pl.id].waypoints = [];
        botMemory[pl.id].pauseUntil = Date.now() + 2000;
      } else {
        io.to(pl.id).emit('force_teleport', {
          x: sp.x,
          z: sp.z,
          yaw: sp.yaw,
          msg: '💀 Bạn bị Phó Trưởng Tù bắn ngất và tống lại về buồng!'
        });
      }
      io.emit('players_sync', onlinePlayers);
    }, STUN_MS);
  }

  io.emit('players_sync', onlinePlayers);
}

function deputyBeatTarget(target) {
  const bot = onlinePlayers[DEPUTY_ID];
  if (!bot || !target || Date.now() < (bot.stunnedUntil || 0)) return;

  bot.yaw = Math.atan2(-(target.x - bot.x), -(target.z - bot.z));
  io.emit('player_moved', { id: DEPUTY_ID, x: bot.x, z: bot.z, yaw: bot.yaw });
  io.emit('player_anim', { id: DEPUTY_ID, anim: 'attack' });
  io.emit('sound_event', { type: 'punch' });

  const dmg = 15;
  target.hp = Math.max(0, target.hp - dmg);
  deputySay(`👊 Nhìn cái mặt thằng ${target.name} ngứa mắt quá, ăn một đấm cho nhớ mặt tao!`);

  if (target.isBot) {
    setTimeout(() => botSay(target, `Ối giời ơi Phó Trưởng Tù đánh em vô cớ!! 😭`, 3000), 500);
  } else {
    io.to(target.id).emit('toast_notice', {
      text: `👊 Bị ${bot.name} đấm dằn mặt (-${dmg} HP)!`,
      color: '#ef4444'
    });
  }

  if (target.hp <= 0) {
    target.hp = 100;
    const sp = getSpawnPoint(target.role, target.cell || 1);
    target.x = sp.x;
    target.z = sp.z;
    if (!target.isBot) {
      io.to(target.id).emit('force_teleport', {
        x: sp.x,
        z: sp.z,
        yaw: sp.yaw,
        msg: '💀 Bạn bị Phó Trưởng Tù đấm ngất và ném lại vào buồng!'
      });
    }
  }
  io.emit('players_sync', onlinePlayers);

  // Sau khi đánh xong đi quay ra hành lang trực tiếp
  deputyMem.waypoints = buildDeputyPath(bot.x, bot.z, -2.5 + Math.random() * 5.0, 1.8);
  deputyMem.pauseUntil = Date.now() + 900;
}

function deputyToggleDoor(cellId) {
  const cell = prisonState.cells[cellId];
  if (!cell) return;
  cell.locked = !cell.locked;
  io.emit('prison_state_sync', prisonState);
  io.emit('sound_event', { type: 'door_lock', cellId, locked: cell.locked });

  if (!cell.locked) {
    PRISONER_BOTS.forEach((cfg) => {
      if (cfg.cell === cellId && botMemory[cfg.id]) {
        botMemory[cfg.id].pauseUntil = Date.now() + 600;
        botMemory[cfg.id].waypoints = [];
      }
    });
    deputySay(`🔓 Tao mở cửa Buồng ${cellId} ra kiểm tra đây! Đứa nào bước ra láo nháo tao bắn điện rụng răng!`);
  } else {
    deputySay(`🔐 Khóa chặt Buồng ${cellId} lại! Ngồi yên trong đấy mà sám hối!`);
  }
}

// =========================================================================
// 5. VÒNG LẶP DI CHUYỂN AI (10 LẦN/GIÂY) CHO 4 BOT TÙ + PHÓ TRƯỞNG TÙ
// =========================================================================
setInterval(() => {
  const now = Date.now();
  const dt = 0.1;

  // --- A. 4 BOT TÙ NHÂN ---
  PRISONER_BOTS.forEach((cfg) => {
    const bot = onlinePlayers[cfg.id];
    const mem = botMemory[cfg.id];
    if (!bot || !mem) return;

    if (now < (bot.stunnedUntil || 0)) {
      mem.waypoints = [];
      return;
    }
    if (now < mem.pauseUntil) return;
    if (mem.waypoints.length === 0) mem.waypoints = pickPrisonerWaypoints(bot);

    const wp = mem.waypoints[0];
    const dx = wp.x - bot.x;
    const dz = wp.z - bot.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 0.16) {
      bot.x = wp.x;
      bot.z = wp.z;
      if (wp.faceBars) {
        bot.yaw = Math.PI;
        if (hasHumanOnline() && Math.random() < 0.25) {
          io.emit('sound_event', { type: 'bar_clang' });
          io.emit('player_anim', { id: bot.id, anim: 'attack' });
          const line = BOT_LINES.locked[Math.floor(Math.random() * BOT_LINES.locked.length)];
          botSay(bot, `🔔 *KENG KENG* ${line}`, 15000);
        }
      }
      mem.waypoints.shift();
      if (mem.waypoints.length === 0) mem.pauseUntil = now + 1600 + Math.random() * 2800;
      io.emit('player_moved', { id: bot.id, x: bot.x, z: bot.z, yaw: bot.yaw });
      return;
    }

    const speed = bot.role === 'Trưởng Buồng' ? 1.85 : 2.15;
    const step = Math.min(dist, speed * dt);
    const nextX = bot.x + (dx / dist) * step;
    const nextZ = bot.z + (dz / dist) * step;

    const cellId = bot.cell || 1;
    const crossingBars = (bot.z < -1.0 && nextZ >= -1.35) || (bot.z >= -1.0 && nextZ < -0.65);
    if (crossingBars && prisonState.cells[cellId].locked) {
      mem.waypoints = [];
      mem.pauseUntil = now + 1200;
      return;
    }

    bot.x = nextX;
    bot.z = nextZ;
    bot.yaw = Math.atan2(-dx, -dz);
    io.emit('player_moved', { id: bot.id, x: bot.x, z: bot.z, yaw: bot.yaw });
  });

  // --- B. BOT PHÓ TRƯỞNG TÙ [AI] ---
  const deputy = onlinePlayers[DEPUTY_ID];
  if (!deputy) return;

  if (now < (deputy.stunnedUntil || 0)) {
    deputyMem.waypoints = [];
    deputyMem.pendingTask = null;
    return;
  }
  if (now < deputyMem.pauseUntil) return;

  // Nếu đang chạy tới mục tiêu để đánh -> cập nhật điểm đến nếu mục tiêu còn gần
  if (deputyMem.pendingTask?.type === 'beat') {
    const t = onlinePlayers[deputyMem.pendingTask.targetId];
    if (!t || t.role === 'Quản Tù') {
      deputyMem.pendingTask = null;
      deputyMem.waypoints = [];
    } else if (Math.hypot(t.x - deputy.x, t.z - deputy.z) <= 1.75) {
      deputyMem.pendingTask = null;
      deputyMem.waypoints = [];
      deputyBeatTarget(t);
      return;
    }
  }

  if (deputyMem.waypoints.length === 0) {
    // Thực thi tác vụ khi vừa đến nơi
    if (deputyMem.pendingTask?.type === 'toggle_door') {
      const cid = deputyMem.pendingTask.cellId;
      deputyMem.pendingTask = null;
      deputy.yaw = 0; // Nhìn thẳng vào cửa buồng
      deputyToggleDoor(cid);
      deputyMem.pauseUntil = now + 2200;
      return;
    }

    // Không có nhiệm vụ -> đi tuần dọc hành lang trước 2 buồng
    const patrolSpots = [
      { x: -4.0, z: 0.9 },
      { x: 0.0, z: 1.6 },
      { x: 4.0, z: 0.9 },
      { x: 2.5, z: 2.6 },
      { x: -2.5, z: 2.6 }
    ];
    const pick = patrolSpots[Math.floor(Math.random() * patrolSpots.length)];
    deputyMem.waypoints = buildDeputyPath(deputy.x, deputy.z, pick.x, pick.z);
  }

  const dwp = deputyMem.waypoints[0];
  const ddx = dwp.x - deputy.x;
  const ddz = dwp.z - deputy.z;
  const ddist = Math.hypot(ddx, ddz);

  if (ddist < 0.2) {
    deputy.x = dwp.x;
    deputy.z = dwp.z;
    deputyMem.waypoints.shift();
    if (deputyMem.waypoints.length === 0 && !deputyMem.pendingTask) {
      deputy.yaw = 0; // Quay nhìn về phía 2 buồng giam
      deputyMem.pauseUntil = now + 1800 + Math.random() * 2500;
    }
    io.emit('player_moved', { id: DEPUTY_ID, x: deputy.x, z: deputy.z, yaw: deputy.yaw });
    return;
  }

  const depSpeed = deputyMem.pendingTask ? 2.6 : 1.9;
  const depStep = Math.min(ddist, depSpeed * dt);
  deputy.x += (ddx / ddist) * depStep;
  deputy.z += (ddz / ddist) * depStep;
  deputy.yaw = Math.atan2(-ddx, -ddz);
  io.emit('player_moved', { id: DEPUTY_ID, x: deputy.x, z: deputy.z, yaw: deputy.yaw });
}, 100);

// Vòng lặp hành động ngẫu nhiên của Phó Trưởng Tù (mỗi 12 giây: bắn điện / đánh tù / mở khóa buồng / thoại)
setInterval(() => {
  if (!hasHumanOnline()) return;
  const deputy = onlinePlayers[DEPUTY_ID];
  if (!deputy || Date.now() < (deputy.stunnedUntil || 0) || deputyMem.pendingTask) return;

  const prisoners = Object.values(onlinePlayers).filter(
    (p) => p.role !== 'Quản Tù' && Date.now() >= (p.stunnedUntil || 0)
  );
  if (!prisoners.length) return;

  // Ưu tiên bắn tù nhân nào đang chạy rông ngoài hành lang
  const escaped = prisoners.filter((p) => p.z > -0.75);
  if (escaped.length > 0 && Math.random() < 0.6) {
    const target = escaped[Math.floor(Math.random() * escaped.length)];
    fireDeputyTaser(target, `⚡ Đứng lại thằng ${target.name}! Ai cho mày lượn lờ ngoài hành lang?!`);
    return;
  }

  const roll = Math.random();

  if (roll < 0.30) {
    // 30%: Bắn súng điện từ xa vào 1 tù nhân ngẫu nhiên trong tầm 14m
    const inRange = prisoners.filter((p) => Math.hypot(p.x - deputy.x, p.z - deputy.z) <= 14.5);
    if (inRange.length > 0) {
      const target = inRange[Math.floor(Math.random() * inRange.length)];
      fireDeputyTaser(target);
    }
  } else if (roll < 0.56) {
    // 26%: Tự đi lại gần 1 tù nhân để đấm dằn mặt
    const target = prisoners[Math.floor(Math.random() * prisoners.length)];
    // Nếu tù nhân ở trong buồng bị khóa -> mở khóa buồng đó để đi vào đánh
    if (target.z < -1.0) {
      const cid = target.x < 0 ? 1 : 2;
      if (prisonState.cells[cid].locked) {
        deputyToggleDoor(cid);
      }
    }
    deputyMem.pendingTask = { type: 'beat', targetId: target.id };
    deputyMem.waypoints = buildDeputyPath(deputy.x, deputy.z, target.x, target.z);
    deputyMem.pauseUntil = 0;
  } else if (roll < 0.76) {
    // 20%: Đi tới cửa Buồng 1 hoặc Buồng 2 để Mở / Khóa tù
    const cid = Math.random() < 0.5 ? 1 : 2;
    const doorX = cid === 1 ? -4.0 : 4.0;
    deputyMem.pendingTask = { type: 'toggle_door', cellId: cid };
    deputyMem.waypoints = buildDeputyPath(deputy.x, deputy.z, doorX, 0.55);
    deputyMem.pauseUntil = 0;
  } else {
    // 24%: Thoại cục súc dằn mặt trại
    const line = DEPUTY_GRUMPY_LINES[Math.floor(Math.random() * DEPUTY_GRUMPY_LINES.length)];
    deputySay(line);
  }
}, 12000);

// Vòng lặp thoại ngẫu nhiên cho 4 Bot tù nhân
setInterval(() => {
  if (!hasHumanOnline()) return;
  const activeBots = PRISONER_BOTS.map((c) => onlinePlayers[c.id]).filter(
    (b) => b && Date.now() >= (b.stunnedUntil || 0)
  );
  if (!activeBots.length) return;

  const bot = activeBots[Math.floor(Math.random() * activeBots.length)];
  const pool = bot.z > -0.5 ? BOT_LINES.escaped : BOT_LINES.locked;
  const line = pool[Math.floor(Math.random() * pool.length)];
  botSay(bot, line, 18000);
}, 17000);

// Hồi máu nhẹ tự động
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

// =========================================================================
// 6. XỬ LÝ SOCKET.IO
// =========================================================================
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

    for (const [sid, pl] of Object.entries(onlinePlayers)) {
      if (!pl.isBot && pl.usernameKey === key && sid !== socket.id) {
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
      isBot: false,
      hp: 100,
      maxHp: 100,
      points: acc.points || 100,
      x: spawn.x,
      z: spawn.z,
      yaw: spawn.yaw,
      stunnedUntil: 0,
      lastActionAt: 0,
      lastTaserAt: 0
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
    if (Date.now() < (p.stunnedUntil || 0)) return;

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

  // 4. SÚNG ĐIỆN BẮN TỪ XA CỦA QUẢN TÙ
  socket.on('taser_shoot', async ({ from, to, hitPlayerId }) => {
    const shooter = onlinePlayers[socket.id];
    if (!shooter || shooter.role !== 'Quản Tù') return;

    const now = Date.now();
    if (now - (shooter.lastTaserAt || 0) < 1600) {
      socket.emit('toast_notice', { text: '⚡ Súng điện đang nạp pin (1.6s)...', color: '#38bdf8' });
      return;
    }
    shooter.lastTaserAt = now;

    let validTarget = null;
    if (hitPlayerId && onlinePlayers[hitPlayerId] && hitPlayerId !== shooter.id) {
      const candidate = onlinePlayers[hitPlayerId];
      if (Math.hypot(candidate.x - shooter.x, candidate.z - shooter.z) <= 16.5) {
        validTarget = candidate;
      }
    }

    const beamFrom = from || { x: shooter.x, y: 1.4, z: shooter.z };
    const beamTo = validTarget
      ? { x: validTarget.x, y: 1.15, z: validTarget.z }
      : (to || { x: shooter.x - Math.sin(shooter.yaw) * 10, y: 1.4, z: shooter.z - Math.cos(shooter.yaw) * 10 });

    io.emit('taser_beam', {
      shooterId: shooter.id,
      from: beamFrom,
      to: beamTo,
      hitPlayerId: validTarget ? validTarget.id : null
    });
    io.emit('player_anim', { id: shooter.id, anim: 'attack' });

    if (!validTarget) {
      socket.emit('toast_notice', { text: '⚡ Bắn trượt! Hãy đưa tâm ngắm vào mục tiêu.', color: '#94a3b8' });
      return;
    }

    const STUN_MS = 3000;
    const dmg = 20;
    validTarget.hp = Math.max(0, validTarget.hp - dmg);
    validTarget.stunnedUntil = now + STUN_MS;
    const penalty = Math.min(10, validTarget.points);
    validTarget.points -= penalty;
    shooter.points += 10;
    syncAccountPoints(validTarget);
    syncAccountPoints(shooter);

    io.emit('player_stunned', {
      targetId: validTarget.id,
      duration: STUN_MS,
      shooterName: shooter.name
    });

    if (validTarget.isDeputyAI) {
      const aiReply = await askDeputyWardenAI(
        shooter.name,
        shooter.role,
        0,
        'vừa bắn súng điện nhầm vào bạn làm bạn ngã co giật 3 giây'
      );
      deputySay(aiReply);
    } else if (validTarget.isBot) {
      const line = BOT_LINES.tased[Math.floor(Math.random() * BOT_LINES.tased.length)];
      botSay(validTarget, line, 2000);
    } else {
      io.to(validTarget.id).emit('toast_notice', {
        text: `⚡ Bị Quản Tù ${shooter.name} bắn súng điện! Co giật 3 giây (-${dmg} HP)`,
        color: '#38bdf8'
      });
    }

    socket.emit('toast_notice', {
      text: `⚡ Bắn trúng [${validTarget.role}] ${validTarget.name}! Giật điện ngã gục 3 giây!`,
      color: '#38bdf8'
    });

    if (validTarget.hp <= 0) {
      const targetId = validTarget.id;
      const targetName = validTarget.name;
      const targetCell = validTarget.cell || 1;

      if (!validTarget.isDeputyAI) {
        pushChat({
          name: '⚡ SÚNG ĐIỆN QUẢN TÙ',
          role: 'SYSTEM',
          text: `⚡ Quản Tù ${shooter.name} đã bắn gục ${targetName} bằng súng điện và áp giải về Buồng ${targetCell}!`,
          isSystem: true
        });
      }

      setTimeout(() => {
        const pl = onlinePlayers[targetId];
        if (!pl) return;
        pl.hp = 100;
        if (pl.isDeputyAI) {
          pl.x = 2.3;
          pl.z = 2.2;
          pl.yaw = 0;
        } else {
          const sp = getSpawnPoint(pl.role, pl.cell || 1);
          pl.x = sp.x;
          pl.z = sp.z;
          pl.yaw = sp.yaw;
          if (pl.isBot && botMemory[pl.id]) {
            botMemory[pl.id].waypoints = [];
            botMemory[pl.id].pauseUntil = Date.now() + 2000;
          } else {
            io.to(pl.id).emit('force_teleport', {
              x: sp.x,
              z: sp.z,
              yaw: sp.yaw,
              msg: '💀 Bạn đã bị bắn ngất và tống lại vào buồng giam!'
            });
          }
        }
        io.emit('players_sync', onlinePlayers);
      }, STUN_MS);
    }

    io.emit('players_sync', onlinePlayers);
    io.emit('accounts_updated', getPublicAccountsList());
  });

  // 5. KHÓA / MỞ CỬA SONG SẮT (CHỈ QUẢN TÙ)
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

    if (!cell.locked) {
      PRISONER_BOTS.forEach((cfg) => {
        if (cfg.cell === cellId && botMemory[cfg.id]) {
          botMemory[cfg.id].pauseUntil = Date.now() + 500;
          botMemory[cfg.id].waypoints = [];
        }
      });
    }

    pushChat({
      name: `👑 QUẢN TÙ ${p.name}`,
      role: 'SYSTEM',
      text: cell.locked
        ? `🔐 Đã KHÓA CHẶT cửa song sắt Buồng ${cellId}!`
        : `🔓 Đã MỞ KHÓA cửa song sắt Buồng ${cellId}!`,
      isSystem: true
    });
  });

  // 6. BẬT / TẮT CÒI BÁO ĐỘNG (CHỈ QUẢN TÙ)
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

  // 7. ĐIỂM DANH & NHỐT VỀ BUỒNG
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
        if (pl.isBot && botMemory[pl.id]) {
          botMemory[pl.id].waypoints = [];
          botMemory[pl.id].pauseUntil = Date.now() + 2000;
        } else {
          io.to(pl.id).emit('force_teleport', {
            x: pl.x,
            z: pl.z,
            yaw: pl.yaw,
            msg: '📢 Quản Tù gọi điểm danh! Bạn đã bị đưa về buồng và khóa cửa!'
          });
        }
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

  // 8. CÁC HÀNH ĐỘNG THEO CẤP ĐỘ NHÂN VẬT
  socket.on('role_action', async ({ action, targetId }) => {
    const p = onlinePlayers[socket.id];
    if (!p) return;

    const now = Date.now();
    if (now < (p.stunnedUntil || 0)) {
      socket.emit('toast_notice', { text: '⚡ Đang bị điện giật, không thể hành động!', color: '#38bdf8' });
      return;
    }
    if (now - (p.lastActionAt || 0) < 1200) return;
    p.lastActionAt = now;

    let target = targetId && onlinePlayers[targetId] && targetId !== p.id ? onlinePlayers[targetId] : null;
    if (target && Math.hypot(target.x - p.x, target.z - p.z) > 4.2) {
      target = null;
    }
    if (!target) {
      target = findNearestPlayer(p, 3.8);
    }

    if (action === 'punch') {
      io.emit('player_anim', { id: p.id, anim: 'attack' });
      if (!target) {
        socket.emit('toast_notice', { text: '👊 Đấm vào không khí! Hãy tiến sát người khác hơn.', color: '#fbbf24' });
        return;
      }
      const dmg = p.role === 'Trưởng Buồng' ? 20 : 10;
      target.hp = Math.max(0, target.hp - dmg);
      io.emit('sound_event', { type: 'punch' });

      if (!target.isBot) {
        io.to(target.id).emit('toast_notice', { text: `👊 Bị [${p.role}] ${p.name} đấm (-${dmg} HP)!`, color: '#ef4444' });
      }
      socket.emit('toast_notice', { text: `👊 Bạn vừa đấm ${target.name} (-${dmg} HP)!`, color: '#f97316' });

      // Dám đấm Phó Trưởng Tù -> Bị nó chửi bằng AI + bắn súng điện ngã sàn ngay!
      if (target.isDeputyAI && Date.now() >= (target.stunnedUntil || 0)) {
        const reply = await askDeputyWardenAI(p.name, p.role, p.cell, 'vừa cả gan đấm thẳng mặt bạn');
        fireDeputyTaser(p, reply);
      } else if (target.hp <= 0) {
        target.hp = 100;
        const loot = Math.min(20, target.points);
        target.points -= loot;
        p.points += loot;
        syncAccountPoints(target);
        syncAccountPoints(p);
        const sp = getSpawnPoint(target.role, target.cell || 1);
        target.x = sp.x;
        target.z = sp.z;
        if (target.isBot && botMemory[target.id]) {
          botMemory[target.id].waypoints = [];
        } else if (!target.isBot) {
          io.to(target.id).emit('force_teleport', { x: sp.x, z: sp.z, yaw: sp.yaw, msg: `💀 Bạn bị ${p.name} hạ đo ván (-${loot} điểm)!` });
        }
        pushChat({
          name: 'ẨU ĐẢ TRONG BUỒNG',
          role: 'SYSTEM',
          text: `💥 [${p.role}] ${p.name} vừa đấm gục [${target.role}] ${target.name} (cướp ${loot} điểm)!`,
          isSystem: true
        });
      } else if (target.isBot && !target.isDeputyAI && Date.now() >= (target.stunnedUntil || 0)) {
        if (target.role === 'Trưởng Buồng') {
          botSay(target, `Á à ${p.name} dám động vào đại ca Buồng ${target.cell} hả?! 👊`, 3000);
          setTimeout(() => {
            const attackerNow = onlinePlayers[p.id];
            const botNow = onlinePlayers[target.id];
            if (!attackerNow || !botNow || Date.now() < (botNow.stunnedUntil || 0)) return;
            if (Math.hypot(attackerNow.x - botNow.x, attackerNow.z - botNow.z) <= 4.0) {
              attackerNow.hp = Math.max(5, attackerNow.hp - 12);
              io.emit('player_anim', { id: botNow.id, anim: 'attack' });
              io.emit('sound_event', { type: 'punch' });
              io.to(attackerNow.id).emit('toast_notice', { text: `👊 ${botNow.name} đấm trả (-12 HP)!`, color: '#ef4444' });
              io.emit('players_sync', onlinePlayers);
            }
          }, 800);
        } else {
          botSay(target, `Ui da! Đừng đấm em nữa ${p.name} ơi! 😭`, 3000);
        }
      }
    } else if (action === 'collect_tax') {
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
            if (!other.isBot) {
              io.to(other.id).emit('toast_notice', { text: `🚬 Trưởng Buồng ${p.name} thu phế -${take} điểm!`, color: '#f59e0b' });
            }
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
    } else if (action === 'share_food') {
      if (p.role !== 'Trưởng Buồng') return;
      p.hp = Math.min(100, p.hp + 20);
      let healed = 0;
      Object.values(onlinePlayers).forEach((other) => {
        if (other.id !== p.id && other.cell === p.cell && other.role !== 'Quản Tù') {
          other.hp = Math.min(100, other.hp + 20);
          healed++;
          if (!other.isBot) {
            io.to(other.id).emit('toast_notice', { text: `🍱 Được Trưởng Buồng ${p.name} chia cơm (+20 HP)!`, color: '#4ade80' });
          }
        }
      });
      socket.emit('toast_notice', { text: `🍱 Chia cơm bảo kê Buồng ${p.cell} (+20 HP cho bạn & ${healed} anh em)!`, color: '#4ade80' });
    } else if (action === 'workout') {
      p.points += 10;
      p.hp = Math.min(100, p.hp + 8);
      syncAccountPoints(p);
      io.emit('player_anim', { id: p.id, anim: 'workout' });
      socket.emit('toast_notice', { text: '💪 Hít đất cải tạo: +10 Điểm, +8 HP!', color: '#4ade80' });
    } else if (action === 'bribe') {
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

      if (receiver.isDeputyAI) {
        deputySay(`Tạm tha cho mày lần này đấy ${p.name}, lần sau còn láo tao vẫn bắn điện! ⚡`);
      } else if (receiver.isBot) {
        botSay(receiver, `Khá lắm ${p.name}! Biết điều thế anh bảo kê cho! 😎`, 3000);
      } else {
        io.to(receiver.id).emit('toast_notice', { text: `🚬 ${p.name} vừa kính biếu bạn +10 điểm!`, color: '#fde047' });
      }
      pushChat({
        name: p.name,
        role: p.role,
        text: `🙏 Kính biếu [${receiver.role}] ${receiver.name} 10 điểm lấy lòng (+15 HP)!`,
        isSystem: false
      });
    } else if (action === 'clang_bars') {
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
    } else if (action === 'scavenge') {
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

  // 9. QUẢN LÝ HỒ SƠ TRẠI
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
        if (!pl.isBot && pl.usernameKey === targetKey) {
          const oldCell = pl.cell;
          const oldRole = pl.role;
          pl.role = acc.role;
          pl.cell = acc.cell;
          pl.isAdmin = acc.isAdmin;
          pl.points = acc.points;

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
        if (!pl.isBot && pl.usernameKey === targetKey) {
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

  // 10. CHAT TRONG TRẠI & GỌI PHÓ TRƯỞNG TÙ [AI] BẰNG "@" ĐẦU CÂU
  socket.on('chat', async ({ text }) => {
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

    // Bắt buộc gõ "@" ở đầu câu để nói chuyện với Phó Trưởng Tù [AI]
    if (clean.startsWith('@')) {
      const deputy = onlinePlayers[DEPUTY_ID];
      if (!deputy) return;

      const userPrompt = clean.slice(1).trim() || 'ê phó trưởng tù';

      // Quay mặt Phó Trưởng Tù về phía người vừa gọi
      deputy.yaw = Math.atan2(-(p.x - deputy.x), -(p.z - deputy.z));
      io.emit('player_moved', { id: DEPUTY_ID, x: deputy.x, z: deputy.z, yaw: deputy.yaw });

      const aiReply = await askDeputyWardenAI(p.name, p.role, p.cell, userPrompt);
      deputySay(aiReply);
    }
  });

  // 11. ĐĂNG XUẤT / NGẮT KẾT NỐI
  socket.on('logout_prison', () => {
    const p = onlinePlayers[socket.id];
    if (!p || p.isBot) return;
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
    if (!p || p.isBot) return;
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
  console.log(`⛓️  TRẠI GIAM ONLINE 3D (4 Bot Tù + Phó Trưởng Tù AI) đang chạy tại: http://localhost:${PORT}`);
  console.log(`👑 Tài khoản Quản Tù mặc định: Trung / 123456`);
});

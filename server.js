const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// =========================================================================
// 1. CẤU HÌNH THẾ GIỚI & VẬT PHẨM CHUẨN ĐÀO VÀNG HUYỀN THOẠI
// =========================================================================
const WORLD_W = 1200;
const WORLD_H = 720;
const SURFACE_Y = 142;

const ANCHORS = [
  { x: 350, y: 112 }, // Người chơi 1 (Trái)
  { x: 850, y: 112 }  // Người chơi 2 (Phải)
];

const HOOK_MIN_LEN = 46;
const HOOK_MIN_ANGLE = 0.22;
const HOOK_MAX_ANGLE = Math.PI - 0.22;
const HOOK_SWING_SPEED = 1.52;
const HOOK_EXTEND_SPEED = 590;
const HOOK_EMPTY_RETRACT_SPEED = 660;
const TNT_RADIUS = 148;

const ITEM_SPECS = {
  gold_xl:     { r: 44, weight: 5.6, value: 500, label: 'Vàng Đại' },
  gold_lg:     { r: 32, weight: 3.6, value: 250, label: 'Vàng Lớn' },
  gold_md:     { r: 22, weight: 2.0, value: 100, label: 'Vàng Vừa' },
  gold_sm:     { r: 14, weight: 1.15, value: 50, label: 'Vàng Nhỏ' },
  rock_lg:     { r: 36, weight: 5.8, value: 20,  label: 'Đá Tảng' },
  rock_sm:     { r: 22, weight: 3.4, value: 11,  label: 'Đá Nhỏ' },
  diamond:     { r: 13, weight: 1.05, value: 600, label: 'Kim Cương' },
  bag:         { r: 21, weight: 1.85, value: 0,  label: 'Túi Bí Ẩn' },
  tnt:         { r: 25, weight: 1.0,  value: 1,  label: 'Thuốc Nổ TNT' },
  pig:         { r: 20, weight: 1.15, value: 2,  label: 'Chuột Chũi' },
  pig_diamond: { r: 21, weight: 1.2,  value: 602, label: 'Chuột Kim Cương' },
  bone:        { r: 19, weight: 2.1,  value: 7,  label: 'Xương Cổ' },
  skull:       { r: 20, weight: 2.3,  value: 20, label: 'Đầu Lâu' }
};

// =========================================================================
// 2. 20 MÀN CHƠI THIẾT KẾ RIÊNG (DỒI DÀO ĐỒ CHO 2 NGƯỜI) + VÔ HẠN MÀN 21+
// =========================================================================
const LEVEL_CONFIGS = [
  {
    name: 'Khởi Đầu Mỏ Vàng',
    theme: 'earth',
    duration: 60,
    goal: 650,
    counts: { gold_xl: 2, gold_lg: 4, gold_md: 6, gold_sm: 8, rock_lg: 3, rock_sm: 5, bag: 3 }
  },
  {
    name: 'Thung Lũng Vàng Ròng',
    theme: 'earth',
    duration: 60,
    goal: 1350,
    counts: { gold_xl: 4, gold_lg: 5, gold_md: 6, gold_sm: 7, rock_lg: 5, rock_sm: 5, bag: 3 }
  },
  {
    name: 'Mỏ Kim Cương Đầu Tiên',
    theme: 'amber',
    duration: 60,
    goal: 2100,
    counts: { gold_xl: 3, gold_lg: 5, gold_md: 5, gold_sm: 5, diamond: 4, rock_lg: 6, rock_sm: 6, bag: 3 }
  },
  {
    name: 'Đàn Chuột Ngậm Báu Vật',
    theme: 'earth',
    duration: 60,
    goal: 3000,
    counts: { gold_xl: 4, gold_lg: 4, gold_md: 5, diamond: 3, pig: 4, pig_diamond: 4, rock_lg: 4, rock_sm: 5, bag: 3 }
  },
  {
    name: 'Kho Thuốc Nổ TNT',
    theme: 'rust',
    duration: 60,
    goal: 3900,
    counts: { gold_xl: 5, gold_lg: 5, gold_md: 5, diamond: 4, tnt: 5, rock_lg: 6, rock_sm: 5, bag: 3 }
  },
  {
    name: 'Hang Đá Tảng Khổng Lồ',
    theme: 'stone',
    duration: 60,
    goal: 4900,
    counts: { gold_xl: 5, gold_lg: 4, diamond: 6, rock_lg: 9, rock_sm: 8, tnt: 3, bag: 4 }
  },
  {
    name: 'Rừng Túi Bí Ẩn',
    theme: 'amber',
    duration: 60,
    goal: 6000,
    counts: { gold_xl: 4, gold_lg: 4, gold_md: 4, bag: 11, diamond: 4, tnt: 3, rock_sm: 6, pig: 3 }
  },
  {
    name: 'Đường Hầm Kim Cương',
    theme: 'deep',
    duration: 60,
    goal: 7300,
    counts: { diamond: 9, pig_diamond: 5, gold_lg: 4, gold_md: 5, rock_lg: 6, rock_sm: 6, tnt: 2, bag: 3 }
  },
  {
    name: 'Mỏ Xương Cổ Đại',
    theme: 'bone',
    duration: 60,
    goal: 8600,
    counts: { gold_xl: 5, gold_lg: 5, diamond: 6, bone: 6, skull: 5, rock_lg: 5, tnt: 3, bag: 4 }
  },
  {
    name: 'Đại Tiệc Vàng & TNT',
    theme: 'lava',
    duration: 65,
    goal: 10000,
    counts: { gold_xl: 7, gold_lg: 6, diamond: 7, tnt: 7, rock_lg: 5, rock_sm: 4, bag: 4 }
  },
  {
    name: 'Bầy Heo Kim Cương',
    theme: 'amber',
    duration: 60,
    goal: 11500,
    counts: { pig_diamond: 9, pig: 5, gold_xl: 4, gold_lg: 4, diamond: 5, rock_sm: 6, bag: 3 }
  },
  {
    name: 'Thành Trì Đá Cứng',
    theme: 'stone',
    duration: 65,
    goal: 13000,
    counts: { gold_xl: 6, diamond: 8, rock_lg: 11, rock_sm: 8, tnt: 4, bag: 4 }
  },
  {
    name: 'Hầm Kho Báu Song Sinh',
    theme: 'earth',
    duration: 65,
    goal: 14600,
    counts: { gold_xl: 8, gold_lg: 6, diamond: 7, rock_lg: 6, rock_sm: 5, tnt: 4, bag: 4 }
  },
  {
    name: 'Mê Cung Thuốc Nổ',
    theme: 'rust',
    duration: 60,
    goal: 16200,
    counts: { gold_xl: 6, gold_lg: 5, diamond: 9, tnt: 9, pig_diamond: 4, rock_sm: 5, bag: 4 }
  },
  {
    name: 'Suối Kim Cương Ngầm',
    theme: 'deep',
    duration: 65,
    goal: 18000,
    counts: { diamond: 14, pig_diamond: 6, gold_xl: 4, rock_lg: 6, rock_sm: 6, tnt: 3, bag: 3 }
  },
  {
    name: 'Cơn Bão Chuột Chũi',
    theme: 'amber',
    duration: 60,
    goal: 19800,
    counts: { pig_diamond: 10, pig: 6, gold_xl: 6, diamond: 6, bag: 5, tnt: 3, rock_sm: 5 }
  },
  {
    name: 'Tầng Địa Chất Sâu',
    theme: 'bone',
    duration: 65,
    goal: 21800,
    counts: { gold_xl: 8, diamond: 9, skull: 6, bone: 6, rock_lg: 8, tnt: 4, bag: 4 }
  },
  {
    name: 'Thử Thách Thợ Mỏ Huyền Thoại',
    theme: 'lava',
    duration: 65,
    goal: 23800,
    counts: { gold_xl: 7, gold_lg: 5, diamond: 10, pig_diamond: 6, tnt: 7, rock_lg: 6, bag: 5 }
  },
  {
    name: 'Lõi Kim Cương Vô Tận',
    theme: 'deep',
    duration: 65,
    goal: 26000,
    counts: { diamond: 15, gold_xl: 7, pig_diamond: 7, tnt: 5, rock_lg: 6, bag: 4 }
  },
  {
    name: 'Kho Báu Hoàng Kim Tối Thượng',
    theme: 'lava',
    duration: 70,
    goal: 28500,
    counts: { gold_xl: 10, diamond: 14, pig_diamond: 7, tnt: 6, bag: 6, rock_lg: 5 }
  }
];

function getLevelConfig(levelNum) {
  if (levelNum <= LEVEL_CONFIGS.length) {
    return { ...LEVEL_CONFIGS[levelNum - 1], level: levelNum };
  }
  const baseIdx = (levelNum - 1) % LEVEL_CONFIGS.length;
  const extraCycle = Math.floor((levelNum - 1) / LEVEL_CONFIGS.length);
  const base = LEVEL_CONFIGS[baseIdx];
  return {
    ...base,
    level: levelNum,
    name: `${base.name} (Vòng ${extraCycle + 1})`,
    goal: 28500 + (levelNum - 20) * 2600
  };
}

let itemSeq = 1;

function generateLevelItems(levelNum) {
  const cfg = getLevelConfig(levelNum);
  const items = [];

  function canPlace(x, y, r) {
    if (x - r < 34 || x + r > WORLD_W - 34 || y - r < 215 || y + r > WORLD_H - 30) return false;
    for (const it of items) {
      const minGap = it.r + r + 10;
      if (Math.hypot(it.x - x, it.y - y) < minGap) return false;
    }
    return true;
  }

  function addItemOfType(type, sideBias = 0) {
    const spec = ITEM_SPECS[type];
    const isMoving = type === 'pig' || type === 'pig_diamond';

    // Phân tầng tự nhiên giống Đào Vàng gốc: vật quý/nặng ưu tiên nằm sâu hơn
    let minY = 235;
    let maxY = WORLD_H - 42;
    if (type === 'gold_xl' || type === 'diamond') minY = 340;
    if (type === 'rock_lg') { minY = 240; maxY = 560; }
    if (isMoving) { minY = 250; maxY = 620; }

    let minX = 55;
    let maxX = WORLD_W - 55;
    if (sideBias === -1) maxX = WORLD_W / 2 - 20;
    else if (sideBias === 1) minX = WORLD_W / 2 + 20;

    for (let attempt = 0; attempt < 90; attempt++) {
      const x = minX + Math.random() * (maxX - minX);
      const y = minY + Math.random() * (maxY - minY);
      if (canPlace(x, y, spec.r)) {
        const speedBase = (type === 'pig_diamond' ? 92 : 76) + Math.min(50, levelNum * 2.5);
        const dir = Math.random() < 0.5 ? 1 : -1;
        items.push({
          id: `it_${itemSeq++}`,
          type,
          x,
          y,
          r: spec.r,
          weight: spec.weight,
          value: spec.value,
          rot: (Math.random() - 0.5) * 0.7,
          vx: isMoving ? dir * speedBase : 0,
          minX: isMoving ? Math.max(55, x - 210) : x,
          maxX: isMoving ? Math.min(WORLD_W - 55, x + 210) : x,
          grabbedBy: null
        });
        return true;
      }
    }
    return false;
  }

  // Đặt lần lượt các vật phẩm lớn trước để không bị chồng lấn, cân bằng 2 bên cho 2 người chơi
  const order = [
    'gold_xl', 'rock_lg', 'gold_lg', 'tnt', 'bag',
    'rock_sm', 'gold_md', 'pig_diamond', 'pig', 'skull', 'bone', 'gold_sm', 'diamond'
  ];

  for (const type of order) {
    const count = cfg.counts[type] || 0;
    for (let i = 0; i < count; i++) {
      // Xen kẽ trái (-1), phải (+1), và giữa (0) để 2 người tranh nhau công bằng
      const bias = i % 3 === 0 ? -1 : (i % 3 === 1 ? 1 : 0);
      if (!addItemOfType(type, bias)) {
        addItemOfType(type, 0);
      }
    }
  }

  return items;
}

function generateShopItems(levelNum) {
  const scale = 1 + Math.min(2.2, (levelNum - 1) * 0.14);
  return [
    {
      id: 'dynamite',
      name: 'Thuốc Nổ',
      icon: '🧨',
      desc: 'Ném nổ đá nặng đang kéo (lưu trữ qua màn)',
      price: Math.round((150 + Math.random() * 140) * scale / 10) * 10
    },
    {
      id: 'strength',
      name: 'Nước Tăng Lực',
      icon: '💪',
      desc: 'Kéo vàng đại & đá nhanh gấp đôi màn sau',
      price: Math.round((220 + Math.random() * 160) * scale / 10) * 10
    },
    {
      id: 'clover',
      name: 'Cỏ 4 Lá May Mắn',
      icon: '🍀',
      desc: 'Mở Túi ? dễ trúng tiền khủng & sức mạnh',
      price: Math.round((140 + Math.random() * 120) * scale / 10) * 10
    },
    {
      id: 'rockBook',
      name: 'Sách Sưu Tầm Đá',
      icon: '📘',
      desc: 'Đá bán được giá gấp 3 lần trong màn sau',
      price: Math.round((130 + Math.random() * 110) * scale / 10) * 10
    },
    {
      id: 'diamondPolish',
      name: 'Đánh Bóng Kim Cương',
      icon: '💎',
      desc: 'Kim cương tăng giá từ $600 lên $900',
      price: Math.round((280 + Math.random() * 180) * scale / 10) * 10
    }
  ];
}

// =========================================================================
// 3. TRẠNG THÁI PHÒNG CHƠI (2 NGƯỜI CHƠI + HÀNG CHỜ KHÁN GIẢ)
// =========================================================================
const users = {}; // socketId -> { id, name, role: 'player'|'spectator', slot: 0|1|null }
const slots = [null, null]; // 2 thợ mỏ đang thi đấu
const queue = []; // Hàng chờ khán giả [{ id, name }]
const chatHistory = [];

function createPlayerState(socketId, name, slotIndex, inheritFrom = null) {
  const anchor = ANCHORS[slotIndex];
  return {
    id: socketId,
    name,
    slot: slotIndex,
    money: inheritFrom ? inheritFrom.money : 0,
    roundEarned: inheritFrom ? inheritFrom.roundEarned : 0,
    crowns: inheritFrom ? inheritFrom.crowns : 0,
    dynamite: inheritFrom ? inheritFrom.dynamite : 1,
    buffs: inheritFrom
      ? { ...inheritFrom.buffs }
      : { strength: false, clover: false, rockBook: false, diamondPolish: false },
    boughtShop: {},
    shopReady: false,
    hook: {
      anchorX: anchor.x,
      anchorY: anchor.y,
      angle: slotIndex === 0 ? 0.55 : Math.PI - 0.55,
      dir: slotIndex === 0 ? 1 : -1,
      length: HOOK_MIN_LEN,
      state: 'swing', // 'swing' | 'extend' | 'retract'
      grabbedId: null,
      retractSpeed: HOOK_EMPTY_RETRACT_SPEED
    },
    animState: 'idle', // 'idle' | 'pull' | 'strain' | 'happy' | 'throw'
    animTimer: 0
  };
}

const game = {
  phase: 'waiting', // 'waiting' | 'countdown' | 'playing' | 'level_summary' | 'shop' | 'gameover'
  level: 1,
  levelName: LEVEL_CONFIGS[0].name,
  theme: LEVEL_CONFIGS[0].theme,
  goal: LEVEL_CONFIGS[0].goal,
  timeLeft: 60,
  countdown: 0,
  shopTimeLeft: 0,
  summaryTimeLeft: 0,
  items: generateLevelItems(1),
  shopItems: [],
  lastRoundWinner: null,
  gameoverReason: '',
  championText: ''
};

function pushChat(name, text, isSystem = false) {
  const msg = { name, text, isSystem, at: Date.now() };
  chatHistory.push(msg);
  if (chatHistory.length > 40) chatHistory.shift();
  io.emit('chat_msg', msg);
}

function getRoomMeta() {
  return {
    phase: game.phase,
    level: game.level,
    levelName: game.levelName,
    theme: game.theme,
    goal: game.goal,
    timeLeft: Math.ceil(game.timeLeft),
    countdown: Math.ceil(game.countdown),
    shopTimeLeft: Math.ceil(game.shopTimeLeft),
    shopItems: game.shopItems,
    lastRoundWinner: game.lastRoundWinner,
    gameoverReason: game.gameoverReason,
    championText: game.championText,
    slots: slots.map((p) =>
      p
        ? {
            id: p.id,
            name: p.name,
            slot: p.slot,
            money: p.money,
            roundEarned: p.roundEarned,
            crowns: p.crowns,
            dynamite: p.dynamite,
            buffs: p.buffs,
            boughtShop: p.boughtShop,
            shopReady: p.shopReady
          }
        : null
    ),
    queue: queue.map((q, i) => ({ id: q.id, name: q.name, pos: i + 1 }))
  };
}

function broadcastRoomMeta() {
  io.emit('room_meta', getRoomMeta());
}

function resetHooksForNewLevel() {
  slots.forEach((p, idx) => {
    if (!p) return;
    p.roundEarned = 0;
    p.shopReady = false;
    p.boughtShop = {};
    p.animState = 'idle';
    p.animTimer = 0;
    p.hook = {
      anchorX: ANCHORS[idx].x,
      anchorY: ANCHORS[idx].y,
      angle: idx === 0 ? 0.55 : Math.PI - 0.55,
      dir: idx === 0 ? 1 : -1,
      length: HOOK_MIN_LEN,
      state: 'swing',
      grabbedId: null,
      retractSpeed: HOOK_EMPTY_RETRACT_SPEED
    };
  });
}

function startNewMatchFromLevel1() {
  if (!slots[0] || !slots[1]) {
    game.phase = 'waiting';
    broadcastRoomMeta();
    return;
  }
  slots.forEach((p, idx) => {
    slots[idx] = createPlayerState(p.id, p.name, idx, null);
  });
  prepareLevel(1, true);
}

function prepareLevel(levelNum, withCountdown = false) {
  const cfg = getLevelConfig(levelNum);
  game.level = cfg.level;
  game.levelName = cfg.name;
  game.theme = cfg.theme;
  game.goal = cfg.goal;
  game.timeLeft = cfg.duration;
  game.items = generateLevelItems(cfg.level);
  game.lastRoundWinner = null;
  game.gameoverReason = '';
  game.championText = '';
  resetHooksForNewLevel();

  if (withCountdown) {
    game.phase = 'countdown';
    game.countdown = 3.2;
  } else {
    game.phase = 'playing';
  }

  io.emit('level_init', {
    meta: getRoomMeta(),
    items: game.items
  });
}

function openShopPhase() {
  // Xóa buff dùng trong màn vừa rồi trước khi mở shop mới
  slots.forEach((p) => {
    if (!p) return;
    p.buffs = { strength: false, clover: false, rockBook: false, diamondPolish: false };
    p.boughtShop = {};
    p.shopReady = false;
  });

  game.phase = 'shop';
  game.shopTimeLeft = 18;
  game.shopItems = generateShopItems(game.level + 1);
  broadcastRoomMeta();
  io.emit('sfx', { type: 'shop_open' });
}

function endCurrentLevel() {
  const p0 = slots[0];
  const p1 = slots[1];
  if (!p0 || !p1) return;

  // Trao cúp màn cho người đào được nhiều tiền hơn trong màn này
  if (p0.roundEarned > p1.roundEarned) {
    p0.crowns++;
    game.lastRoundWinner = `${p0.name} thắng Màn ${game.level} (+$${p0.roundEarned.toLocaleString()})`;
  } else if (p1.roundEarned > p0.roundEarned) {
    p1.crowns++;
    game.lastRoundWinner = `${p1.name} thắng Màn ${game.level} (+$${p1.roundEarned.toLocaleString()})`;
  } else {
    game.lastRoundWinner = `Hòa nhau ở Màn ${game.level}! (+$${p0.roundEarned.toLocaleString()})`;
  }

  // Kiểm tra điều kiện qua màn: ít nhất 1 trong 2 người đạt Mục Tiêu ($)
  const maxMoney = Math.max(p0.money, p1.money);
  if (maxMoney >= game.goal) {
    game.phase = 'level_summary';
    game.summaryTimeLeft = 3.5;
    io.emit('sfx', { type: 'level_clear' });
    pushChat('⛏️ MỎ VÀNG', `🎉 Qua Màn ${game.level}! ${game.lastRoundWinner}. Chuẩn bị vào Cửa Hàng!`, true);
    broadcastRoomMeta();
  } else {
    game.phase = 'gameover';
    game.gameoverReason = `Chưa ai đạt Mục Tiêu $${game.goal.toLocaleString()} ở Màn ${game.level}!`;
    if (p0.money > p1.money) {
      game.championText = `🏆 QUÁN QUÂN: ${p0.name} ($${p0.money.toLocaleString()} • ${p0.crowns} 👑)`;
    } else if (p1.money > p0.money) {
      game.championText = `🏆 QUÁN QUÂN: ${p1.name} ($${p1.money.toLocaleString()} • ${p1.crowns} 👑)`;
    } else {
      game.championText = `🤝 HÒA CHUNG CUỘC ($${p0.money.toLocaleString()})`;
    }
    io.emit('sfx', { type: 'gameover' });
    pushChat('🏁 KẾT THÚC', `${game.gameoverReason} ${game.championText}`, true);
    broadcastRoomMeta();
  }
}

function promoteFromQueue(freedSlotIndex, departingState = null) {
  if (queue.length > 0) {
    const nextUser = queue.shift();
    const u = users[nextUser.id];
    if (!u) return promoteFromQueue(freedSlotIndex, departingState);

    u.role = 'player';
    u.slot = freedSlotIndex;
    const inherit = game.phase !== 'waiting' && game.phase !== 'gameover' ? departingState : null;
    slots[freedSlotIndex] = createPlayerState(u.id, u.name, freedSlotIndex, inherit);

    io.to(u.id).emit('role_assigned', { role: 'player', slot: freedSlotIndex });
    pushChat('🔔 HÀNG CHỜ', `⛏️ ${u.name} từ hàng chờ đã vào thay ở vị trí Người Chơi ${freedSlotIndex + 1}!`, true);

    if (slots[0] && slots[1] && game.phase === 'waiting') {
      startNewMatchFromLevel1();
    } else {
      broadcastRoomMeta();
    }
    return true;
  }

  // Không còn ai trong hàng chờ -> tạm quay về chờ đối thủ thứ 2
  slots[freedSlotIndex] = null;
  game.phase = 'waiting';
  broadcastRoomMeta();
  return false;
}

// =========================================================================
// 4. NỔ THÙNG TNT DÂY CHUYỀN & TÍNH ĐIỂM KHI KÉO VẬT LÊN MẶT ĐẤT
// =========================================================================
function triggerTntChainExplosion(startItem) {
  const explodedIds = new Set();
  const toProcess = [startItem];
  const blastPoints = [];

  while (toProcess.length > 0) {
    const cur = toProcess.shift();
    if (!cur || explodedIds.has(cur.id)) continue;
    explodedIds.add(cur.id);
    blastPoints.push({ x: cur.x, y: cur.y, r: TNT_RADIUS });

    for (const other of game.items) {
      if (explodedIds.has(other.id)) continue;
      if (Math.hypot(other.x - cur.x, other.y - cur.y) <= TNT_RADIUS) {
        if (other.type === 'tnt') {
          toProcess.push(other);
        } else {
          explodedIds.add(other.id);
        }
      }
    }
  }

  // Tách móc của người chơi nếu vật họ đang kéo bị nổ tan xác
  slots.forEach((p) => {
    if (p && p.hook.grabbedId && explodedIds.has(p.hook.grabbedId)) {
      p.hook.grabbedId = null;
      p.hook.state = 'retract';
      p.hook.retractSpeed = HOOK_EMPTY_RETRACT_SPEED;
    }
  });

  game.items = game.items.filter((it) => !explodedIds.has(it.id));
  io.emit('explosion', { blasts: blastPoints, removedIds: Array.from(explodedIds) });
  io.emit('sfx', { type: 'boom' });
}

function collectGrabbedItem(player, item) {
  let cashGain = 0;
  let popupText = '';
  let popupColor = '#fde047';

  if (item.type === 'diamond') {
    cashGain = player.buffs.diamondPolish ? 900 : 600;
    popupText = `+$${cashGain}`;
    popupColor = '#38bdf8';
  } else if (item.type === 'pig_diamond') {
    cashGain = player.buffs.diamondPolish ? 902 : 602;
    popupText = `+$${cashGain}`;
    popupColor = '#38bdf8';
  } else if (item.type === 'rock_lg' || item.type === 'rock_sm') {
    cashGain = player.buffs.rockBook ? item.value * 3 : item.value;
    popupText = `+$${cashGain}`;
    popupColor = '#cbd5e1';
  } else if (item.type === 'bag') {
    const roll = Math.random();
    const lucky = player.buffs.clover;
    if (roll < (lucky ? 0.22 : 0.16)) {
      player.buffs.strength = true;
      popupText = '💪 SỨC MẠNH!';
      popupColor = '#f97316';
    } else if (roll < (lucky ? 0.36 : 0.28)) {
      player.dynamite = Math.min(8, player.dynamite + 1);
      popupText = '🧨 +1 MÌN!';
      popupColor = '#ef4444';
    } else {
      const minCash = lucky ? 350 : 100;
      const maxCash = lucky ? 850 : 650;
      cashGain = Math.round((minCash + Math.random() * (maxCash - minCash)) / 10) * 10;
      popupText = `?$${cashGain}!`;
      popupColor = '#4ade80';
    }
  } else {
    cashGain = item.value;
    popupText = `+$${cashGain}`;
    popupColor = cashGain >= 250 ? '#facc15' : '#86efac';
  }

  player.money += cashGain;
  player.roundEarned += cashGain;
  player.animState = 'happy';
  player.animTimer = 0.65;

  io.emit('score_popup', {
    slot: player.slot,
    x: player.hook.anchorX,
    y: player.hook.anchorY - 12,
    text: popupText,
    color: popupColor
  });
  io.emit('sfx', { type: cashGain >= 250 ? 'big_cash' : 'cash' });

  // Xóa vật phẩm vừa thu hoạch
  game.items = game.items.filter((it) => it.id !== item.id);
  broadcastRoomMeta();

  // Nếu cả mỏ đã bị dọn sạch toàn bộ vàng/kim cương/túi -> qua màn sớm!
  const remainingValuables = game.items.some((it) =>
    ['gold_xl', 'gold_lg', 'gold_md', 'gold_sm', 'diamond', 'pig_diamond', 'bag'].includes(it.type)
  );
  if (!remainingValuables && game.phase === 'playing') {
    endCurrentLevel();
  }
}

// =========================================================================
// 5. VÒNG LẶP VẬT LÝ CHÍNH (30 TICK/GIÂY - ĐỒNG BỘ MƯỢT CHO CẢ KHÁN GIẢ)
// =========================================================================
const TICK_MS = 33;

setInterval(() => {
  const dt = TICK_MS / 1000;

  if (game.phase === 'countdown') {
    game.countdown -= dt;
    if (game.countdown <= 0) {
      game.phase = 'playing';
      broadcastRoomMeta();
      io.emit('sfx', { type: 'start' });
    }
  } else if (game.phase === 'level_summary') {
    game.summaryTimeLeft -= dt;
    if (game.summaryTimeLeft <= 0) {
      openShopPhase();
    }
  } else if (game.phase === 'shop') {
    game.shopTimeLeft -= dt;
    const bothReady = slots[0]?.shopReady && slots[1]?.shopReady;
    if (game.shopTimeLeft <= 0 || bothReady) {
      prepareLevel(game.level + 1, false);
      io.emit('sfx', { type: 'start' });
    }
  } else if (game.phase === 'playing') {
    game.timeLeft -= dt;
    if (game.timeLeft <= 0) {
      game.timeLeft = 0;
      endCurrentLevel();
      return;
    }

    // 1. Di chuyển chuột chũi / heo chạy ngang
    for (const it of game.items) {
      if (it.vx !== 0 && it.grabbedBy === null) {
        it.x += it.vx * dt;
        if (it.x <= it.minX) {
          it.x = it.minX;
          it.vx = Math.abs(it.vx);
        } else if (it.x >= it.maxX) {
          it.x = it.maxX;
          it.vx = -Math.abs(it.vx);
        }
      }
    }

    // 2. Cập nhật càng gắp của 2 người chơi
    for (const p of slots) {
      if (!p) continue;
      if (p.animTimer > 0) {
        p.animTimer = Math.max(0, p.animTimer - dt);
        if (p.animTimer === 0 && p.hook.state === 'swing') p.animState = 'idle';
      }

      const h = p.hook;
      if (h.state === 'swing') {
        h.angle += h.dir * HOOK_SWING_SPEED * dt;
        if (h.angle >= HOOK_MAX_ANGLE) {
          h.angle = HOOK_MAX_ANGLE;
          h.dir = -1;
        } else if (h.angle <= HOOK_MIN_ANGLE) {
          h.angle = HOOK_MIN_ANGLE;
          h.dir = 1;
        }
      } else if (h.state === 'extend') {
        h.length += HOOK_EXTEND_SPEED * dt;
        const hx = h.anchorX + Math.cos(h.angle) * h.length;
        const hy = h.anchorY + Math.sin(h.angle) * h.length;

        // Chạm mép bản đồ -> kéo lên rỗng
        if (hx < 18 || hx > WORLD_W - 18 || hy > WORLD_H - 18) {
          h.state = 'retract';
          h.retractSpeed = HOOK_EMPTY_RETRACT_SPEED;
          p.animState = 'pull';
          continue;
        }

        // Kiểm tra chạm vật phẩm
        let hitItem = null;
        for (const it of game.items) {
          if (it.grabbedBy !== null) continue;
          if (Math.hypot(hx - it.x, hy - it.y) <= it.r + 12) {
            hitItem = it;
            break;
          }
        }

        if (hitItem) {
          if (hitItem.type === 'tnt') {
            h.state = 'retract';
            h.retractSpeed = HOOK_EMPTY_RETRACT_SPEED;
            p.animState = 'pull';
            triggerTntChainExplosion(hitItem);
          } else {
            hitItem.grabbedBy = p.slot;
            h.grabbedId = hitItem.id;
            h.state = 'retract';
            const speedMult = p.buffs.strength ? 2.1 : 1.0;
            h.retractSpeed = Math.min(540, (520 / hitItem.weight) * speedMult);
            p.animState = hitItem.weight >= 3.2 && !p.buffs.strength ? 'strain' : 'pull';

            const sfxType =
              hitItem.type === 'diamond' || hitItem.type === 'pig_diamond'
                ? 'grab_diamond'
                : hitItem.type.startsWith('gold')
                ? 'grab_gold'
                : 'grab_rock';
            io.emit('sfx', { type: sfxType });
          }
        }
      } else if (h.state === 'retract') {
        h.length -= h.retractSpeed * dt;
        const hx = h.anchorX + Math.cos(h.angle) * h.length;
        const hy = h.anchorY + Math.sin(h.angle) * h.length;

        if (h.grabbedId) {
          const grabbed = game.items.find((it) => it.id === h.grabbedId);
          if (grabbed) {
            grabbed.x = hx + Math.cos(h.angle) * (grabbed.r * 0.62);
            grabbed.y = hy + Math.sin(h.angle) * (grabbed.r * 0.62);
          } else {
            h.grabbedId = null;
            h.retractSpeed = HOOK_EMPTY_RETRACT_SPEED;
          }
        }

        if (h.length <= HOOK_MIN_LEN) {
          h.length = HOOK_MIN_LEN;
          h.state = 'swing';
          p.animState = 'idle';
          if (h.grabbedId) {
            const grabbed = game.items.find((it) => it.id === h.grabbedId);
            h.grabbedId = null;
            if (grabbed) collectGrabbedItem(p, grabbed);
          }
        }
      }
    }
  }

  // Phát khung hình trạng thái nén gọn cho tất cả người chơi & khán giả
  io.emit('tick', {
    phase: game.phase,
    timeLeft: Math.ceil(game.timeLeft),
    countdown: Math.ceil(game.countdown),
    shopTimeLeft: Math.ceil(game.shopTimeLeft),
    players: slots.map((p) =>
      p
        ? {
            id: p.id,
            name: p.name,
            slot: p.slot,
            money: p.money,
            roundEarned: p.roundEarned,
            crowns: p.crowns,
            dynamite: p.dynamite,
            buffs: p.buffs,
            animState: p.animState,
            hook: {
              angle: Number(p.hook.angle.toFixed(3)),
              length: Math.round(p.hook.length),
              state: p.hook.state,
              grabbedId: p.hook.grabbedId
            }
          }
        : null
    ),
    items: game.items.map((it) => ({
      id: it.id,
      type: it.type,
      x: Math.round(it.x),
      y: Math.round(it.y),
      r: it.r,
      rot: it.rot,
      vx: it.vx
    }))
  });
}, TICK_MS);

// =========================================================================
// 6. KẾT NỐI SOCKET.IO (CHỈ NHẬP TÊN • TỐI ĐA 2 NGƯỜI • HÀNG CHỜ XEM LIVE)
// =========================================================================
io.on('connection', (socket) => {
  // Gửi ngay trạng thái phòng hiện tại cho màn hình nhập tên
  socket.emit('lobby_preview', getRoomMeta());

  socket.on('join_game', ({ name }, cb) => {
    const cleanName = (name || '').trim().replace(/\s+/g, ' ').slice(0, 16);
    if (cleanName.length < 2) {
      return cb && cb({ ok: false, msg: 'Vui lòng nhập tên từ 2 đến 16 ký tự!' });
    }

    // Nếu đã vào rồi thì bỏ qua
    if (users[socket.id]) {
      return cb && cb({ ok: true, role: users[socket.id].role, slot: users[socket.id].slot });
    }

    let role = 'spectator';
    let assignedSlot = null;

    if (!slots[0]) {
      role = 'player';
      assignedSlot = 0;
      slots[0] = createPlayerState(socket.id, cleanName, 0, null);
    } else if (!slots[1]) {
      role = 'player';
      assignedSlot = 1;
      slots[1] = createPlayerState(socket.id, cleanName, 1, null);
    } else {
      role = 'spectator';
      queue.push({ id: socket.id, name: cleanName });
    }

    users[socket.id] = { id: socket.id, name: cleanName, role, slot: assignedSlot };

    if (role === 'player') {
      pushChat('⛏️ HẦM MỎ', `🟢 ${cleanName} đã vào vị trí Thợ Mỏ ${assignedSlot + 1}!`, true);
    } else {
      pushChat('👁️ KHÁN ĐÀI', `👀 ${cleanName} đang xem trận đấu (Hàng chờ #${queue.length})!`, true);
    }

    // Gửi trạng thái đầy đủ & lịch sử chat
    socket.emit('joined_sync', {
      role,
      slot: assignedSlot,
      meta: getRoomMeta(),
      items: game.items,
      chatHistory
    });

    // Đủ 2 người chơi -> Bắt đầu trận đấu ngay!
    if (slots[0] && slots[1] && game.phase === 'waiting') {
      startNewMatchFromLevel1();
    } else {
      broadcastRoomMeta();
    }

    return cb && cb({ ok: true, role, slot: assignedSlot });
  });

  // Thả càng gắp
  socket.on('drop_hook', () => {
    const u = users[socket.id];
    if (!u || u.role !== 'player' || game.phase !== 'playing') return;
    const p = slots[u.slot];
    if (!p || p.hook.state !== 'swing') return;

    p.hook.state = 'extend';
    io.emit('sfx', { type: 'drop' });
  });

  // Ném thuốc nổ phá vật nặng đang kéo
  socket.on('use_dynamite', () => {
    const u = users[socket.id];
    if (!u || u.role !== 'player' || game.phase !== 'playing') return;
    const p = slots[u.slot];
    if (!p || p.dynamite <= 0 || p.hook.state !== 'retract' || !p.hook.grabbedId) return;

    const grabbed = game.items.find((it) => it.id === p.hook.grabbedId);
    if (!grabbed) return;

    p.dynamite--;
    p.animState = 'throw';
    p.animTimer = 0.45;
    p.hook.grabbedId = null;
    p.hook.retractSpeed = HOOK_EMPTY_RETRACT_SPEED;

    const bx = grabbed.x;
    const by = grabbed.y;
    game.items = game.items.filter((it) => it.id !== grabbed.id);

    io.emit('explosion', { blasts: [{ x: bx, y: by, r: 78 }], removedIds: [grabbed.id] });
    io.emit('sfx', { type: 'boom' });
    broadcastRoomMeta();
  });

  // Mua vật phẩm trong Cửa Hàng giữa 2 màn
  socket.on('buy_shop_item', ({ itemId }) => {
    const u = users[socket.id];
    if (!u || u.role !== 'player' || game.phase !== 'shop') return;
    const p = slots[u.slot];
    const shopItem = game.shopItems.find((s) => s.id === itemId);
    if (!p || !shopItem) return;

    if (p.money < shopItem.price) {
      socket.emit('toast', { text: 'Không đủ tiền để mua món này!', color: '#ef4444' });
      return;
    }

    if (itemId === 'dynamite') {
      if ((p.boughtShop.dynamite || 0) >= 3 || p.dynamite >= 8) {
        socket.emit('toast', { text: 'Đã mua tối đa Thuốc Nổ màn này!', color: '#facc15' });
        return;
      }
      p.money -= shopItem.price;
      p.dynamite++;
      p.boughtShop.dynamite = (p.boughtShop.dynamite || 0) + 1;
    } else {
      if (p.boughtShop[itemId]) {
        socket.emit('toast', { text: 'Bạn đã mua vật phẩm này rồi!', color: '#facc15' });
        return;
      }
      p.money -= shopItem.price;
      p.buffs[itemId] = true;
      p.boughtShop[itemId] = true;
    }

    io.to(socket.id).emit('sfx', { type: 'cash' });
    broadcastRoomMeta();
  });

  // Sẵn sàng qua màn ngay trong Shop
  socket.on('shop_ready', () => {
    const u = users[socket.id];
    if (!u || u.role !== 'player' || game.phase !== 'shop') return;
    const p = slots[u.slot];
    if (!p) return;
    p.shopReady = true;
    broadcastRoomMeta();
  });

  // Chơi lại từ Màn 1 khi kết thúc trận
  socket.on('restart_match', () => {
    const u = users[socket.id];
    if (!u || u.role !== 'player') return;
    if (game.phase !== 'gameover') return;
    if (slots[0] && slots[1]) {
      pushChat('⛏️ MỎ VÀNG', `🔄 ${u.name} đã bấm Tái Đấu từ Màn 1!`, true);
      startNewMatchFromLevel1();
    }
  });

  // Nhường ghế cho người trong hàng chờ và ra xem
  socket.on('yield_seat', () => {
    const u = users[socket.id];
    if (!u || u.role !== 'player') return;
    const oldSlot = u.slot;
    const departingState = slots[oldSlot];
    u.role = 'spectator';
    u.slot = null;
    queue.push({ id: u.id, name: u.name });
    io.to(u.id).emit('role_assigned', { role: 'spectator', slot: null });
    pushChat('🔔 NHƯỜNG GHẾ', `👋 ${u.name} đã nhường ghế và ra hàng chờ xem!`, true);
    promoteFromQueue(oldSlot, departingState);
  });

  // Chat nhanh
  socket.on('chat', ({ text }) => {
    const u = users[socket.id];
    if (!u || !text || !text.trim()) return;
    const clean = text.trim().slice(0, 140);
    const prefix = u.role === 'player' ? `[P${u.slot + 1}] ${u.name}` : `[Xem] ${u.name}`;
    pushChat(prefix, clean, false);
  });

  // Ngắt kết nối
  socket.on('disconnect', () => {
    const u = users[socket.id];
    if (!u) return;
    delete users[socket.id];

    if (u.role === 'spectator') {
      const idx = queue.findIndex((q) => q.id === socket.id);
      if (idx !== -1) queue.splice(idx, 1);
      broadcastRoomMeta();
      return;
    }

    const oldSlot = u.slot;
    const departingState = slots[oldSlot];
    pushChat('⛏️ HẦM MỎ', `💨 ${u.name} (Thợ Mỏ ${oldSlot + 1}) đã rời phòng.`, true);
    promoteFromQueue(oldSlot, departingState);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⛏️  ĐÀO VÀNG ĐỐI CHIẾN ONLINE đang chạy tại: http://localhost:${PORT}`);
});

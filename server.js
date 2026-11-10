const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const templeState = {
  activeIncenseSticks: 9,
  chatHistory: []
};

// Lưu danh sách người chơi đang online (Không có bot)
const players = {};

function pushChat(chatItem) {
  templeState.chatHistory.push(chatItem);
  if (templeState.chatHistory.length > 40) {
    templeState.chatHistory.shift();
  }
  io.emit('chat_message', chatItem);
}

io.on('connection', (socket) => {
  socket.emit('init_state', { templeState, players });

  // 1. Tạo nhân vật nhập môn
  socket.on('join_temple', (data) => {
    players[socket.id] = {
      id: socket.id,
      name: (data.name || 'Đạo Hữu').trim().slice(0, 18),
      dept: data.dept || 'IBD Cost',
      level: data.level || 'ST2',
      gender: data.gender || 'M',
      hp: 100,
      maxHp: 100,
      merit: 1000,
      x: data.x || 9.2,
      y: data.y || 13.0,
      destX: data.x || 9.2,
      destY: data.y || 13.0,
      state: 'idle',
      bubbleText: 'Nhập môn hành đạo! 🙏',
      bubbleTimer: 140
    };

    io.emit('players_sync', players);
    pushChat({
      id: 'SYSTEM',
      name: 'SƯƠNG MINH TỔ MÔN',
      dept: players[socket.id].dept,
      level: players[socket.id].level,
      text: `🟢 [${players[socket.id].level}] ${players[socket.id].name} (${players[socket.id].dept}) đã nhập môn!`,
      isSystem: true
    });
  });

  // 2. Di chuyển
  socket.on('move', ({ x, y, destX, destY, state }) => {
    const p = players[socket.id];
    if (!p) return;
    if (typeof x === 'number') p.x = x;
    if (typeof y === 'number') p.y = y;
    p.destX = destX;
    p.destY = destY;
    p.state = state || 'walk';
    socket.broadcast.emit('player_moved', {
      id: socket.id,
      x: p.x,
      y: p.y,
      destX: p.destX,
      destY: p.destY,
      state: p.state
    });
  });

  // 3. Cập nhật vị trí thực tế định kỳ để tính khoảng cách Đấm / Hôn chính xác
  socket.on('sync_pos', ({ x, y, state }) => {
    const p = players[socket.id];
    if (!p) return;
    p.x = x;
    p.y = y;
    if (state) p.state = state;
  });

  // 4. Ngồi thiền (Đúng phòng tăng công đức, khác phòng trộm công đức)
  socket.on('meditate_room', ({ roomDept, x, y }) => {
    const p = players[socket.id];
    if (!p) return;
    p.x = x;
    p.y = y;
    p.destX = x;
    p.destY = y;
    p.state = 'meditate';

    if (!roomDept) {
      // Thiền ngoài sân
      p.merit += 10;
      io.emit('effect_event', {
        type: 'float_text',
        x: p.x,
        y: p.y,
        text: '+10 Công Đức (Thiền Sân)',
        color: '#6fcf97'
      });
    } else if (roomDept === p.dept) {
      // Đúng phòng ban của mình
      p.merit += 25;
      io.emit('effect_event', {
        type: 'float_text',
        x: p.x,
        y: p.y,
        text: `+25 Công Đức (Chính Phòng ${p.dept})`,
        color: '#4ade80'
      });
    } else {
      // Khác phòng -> Trộm công đức của thành viên phòng đó!
      p.merit += 25;
      let victims = [];
      Object.values(players).forEach((other) => {
        if (other.id !== p.id && other.dept === roomDept) {
          other.merit = Math.max(0, other.merit - 15);
          victims.push(other.name);
          io.emit('effect_event', {
            type: 'float_text',
            x: other.x,
            y: other.y,
            text: `-15 Công Đức (Bị ${p.name} trộm!)`,
            color: '#ff4d4d'
          });
        }
      });

      io.emit('effect_event', {
        type: 'float_text',
        x: p.x,
        y: p.y,
        text: `🕵️ +25 Trộm Linh Khí phòng ${roomDept}!`,
        color: '#facc15'
      });

      pushChat({
        id: p.id,
        name: 'CẢNH BÁO TRỘM CÔNG ĐỨC',
        dept: roomDept,
        level: p.level,
        text: `🚨 [${p.level}] ${p.name} (${p.dept}) đang ngồi thiền TRỘM CÔNG ĐỨC tại phòng ${roomDept}! ${
          victims.length > 0 ? `(${victims.join(', ')} bị -15 Công Đức)` : '(Phòng đang trống)'
        }`,
        isSystem: true
      });
    }

    io.emit('players_sync', players);
  });

  // 5. Tương tác cận chiến: Đấm (-15 HP) hoặc Hôn (+10 HP)
  socket.on('interact_target', ({ targetId, type, myX, myY }) => {
    const attacker = players[socket.id];
    const target = players[targetId];
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
        text: '⚠️ Phải lại gần hơn mới tương tác được!',
        color: '#fbbf24'
      });
      return;
    }

    if (type === 'punch') {
      attacker.state = 'punch';
      target.hp = Math.max(0, target.hp - 15);

      io.emit('effect_event', {
        type: 'punch_hit',
        fromId: attacker.id,
        toId: target.id,
        x: target.x,
        y: target.y,
        text: `💥 -15 HP (Bị ${attacker.name} đấm!)`,
        color: '#ef4444'
      });

      // Nếu hết máu (0 HP) -> Trừ 1 nửa tổng công đức
      if (target.hp <= 0) {
        const lostMerit = Math.floor(target.merit / 2);
        const stolenGain = Math.floor(lostMerit * 0.5);
        target.merit = Math.max(0, target.merit - lostMerit);
        attacker.merit += stolenGain;
        target.hp = 100; // Hồi sinh lại 100 máu

        io.emit('effect_event', {
          type: 'ko_blast',
          x: target.x,
          y: target.y,
          text: `💀 TRỌNG THƯƠNG! -${lostMerit} Công Đức!`,
          color: '#ff0055'
        });

        pushChat({
          id: 'SYSTEM',
          name: 'GIÁM LUẬT ĐƯỜNG',
          dept: target.dept,
          level: attacker.level,
          text: `⚡ [${attacker.level}] ${attacker.name} đã đấm gục [${target.level}] ${target.name}! ${target.name} bị trừ 50% Công Đức (-${lostMerit} 🪷), ${attacker.name} đoạt được +${stolenGain} 🪷!`,
          isSystem: true
        });
      }
    } else if (type === 'kiss') {
      attacker.state = 'kiss';
      target.hp = Math.min(target.maxHp, target.hp + 10);
      attacker.merit += 5;
      target.merit += 5;

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
        text: `😘 Vừa trao nụ hôn tịnh tâm cho ${target.name} (+10 HP)! 💖`,
        isSystem: false
      });
    }

    io.emit('players_sync', players);
  });

  // 6. Hành lễ & Ăn ở Pantry
  socket.on('action', ({ type }) => {
    const p = players[socket.id];
    if (!p) return;
    p.state = type;

    if (type === 'wave') {
      p.merit += 5;
      io.emit('effect_event', { type: 'float_text', x: p.x, y: p.y, text: '👋 +5 Công Đức', color: '#6fcf97' });
    } else if (type === 'knock') {
      p.merit += 10;
      io.emit('effect_event', { type: 'float_text', x: p.x, y: p.y, text: '🥁 Cốc! +10 Công Đức', color: '#4ade80' });
    } else if (type === 'incense') {
      p.merit += 30;
      templeState.activeIncenseSticks = Math.min(36, templeState.activeIncenseSticks + 3);
      io.emit('effect_event', { type: 'incense_burn', x: p.x, y: p.y, sticks: templeState.activeIncenseSticks, text: '🔥 Dâng Nhang +30 Công Đức', color: '#facc15' });
    } else if (type === 'eat') {
      p.merit += 15;
      p.hp = Math.min(100, p.hp + 20);
      io.emit('effect_event', { type: 'float_text', x: p.x, y: p.y, text: '🍱 Thụ Lộc Pantry: +15 Công Đức, +20 HP!', color: '#38bdf8' });
    } else if (type === 'waterfall') {
      p.merit += 12;
      io.emit('effect_event', { type: 'float_text', x: p.x, y: p.y, text: '🐟 Ngắm Cá Koi +12 Công Đức', color: '#67e8f9' });
    }

    io.emit('players_sync', players);
    socket.broadcast.emit('player_action', { id: socket.id, type });
  });

  // 7. Chat
  socket.on('chat', ({ text }) => {
    const p = players[socket.id];
    if (!p || !text || !text.trim()) return;
    const cleanText = text.trim().slice(0, 120);
    p.merit += 2;
    p.bubbleText = cleanText;
    p.bubbleTimer = 220;

    pushChat({
      id: p.id,
      name: p.name,
      dept: p.dept,
      level: p.level,
      text: cleanText,
      isSystem: false
    });
    io.emit('players_sync', players);
  });

  // 8. Hạ Sơn = Out Nick
  socket.on('leave_temple', () => {
    const p = players[socket.id];
    if (!p) return;
    const oldName = p.name;
    const oldLevel = p.level;
    delete players[socket.id];
    io.emit('players_sync', players);
    pushChat({
      id: 'SYSTEM',
      name: 'CỔNG HẠ SƠN',
      dept: 'HR-GA',
      level: oldLevel,
      text: `🏃 [${oldLevel}] ${oldName} đã bước xuống Cầu Thang Hạ Sơn rời cuộc chơi!`,
      isSystem: true
    });
  });

  // 9. Mất kết nối
  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const oldName = players[socket.id].name;
      const oldLevel = players[socket.id].level;
      delete players[socket.id];
      io.emit('players_sync', players);
      pushChat({
        id: 'SYSTEM',
        name: 'SƯƠNG MINH TỔ MÔN',
        dept: 'HR-GA',
        level: oldLevel,
        text: `💨 [${oldLevel}] ${oldName} đã rời khỏi Tổ Môn.`,
        isSystem: true
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⛩️  SƯƠNG MINH TỔ MÔN đang mở cửa tại: http://localhost:${PORT}`);
});

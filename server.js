const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const templeState = {
  meritTotal: 1080,
  activeIncenseSticks: 9,
  isMassChanting: false,
  isGoingHome: false,
  customNames: {},
  charPositions: {},
  chatHistory: []
};

const onlinePlayers = {};

function getOccupiedMap() {
  const map = {};
  for (const [sid, info] of Object.entries(onlinePlayers)) {
    map[info.charId] = sid;
  }
  return map;
}

io.on('connection', (socket) => {
  console.log(`[+] Đạo hữu nhập môn: ${socket.id}`);

  socket.emit('init_state', {
    templeState,
    occupiedMap: getOccupiedMap(),
    onlineCount: Object.keys(onlinePlayers).length
  });

  socket.on('claim_character', ({ charId, customName, deptName }) => {
    onlinePlayers[socket.id] = { charId };
    if (customName && customName.trim()) {
      templeState.customNames[charId] = customName.trim();
    }

    io.emit('players_updated', {
      occupiedMap: getOccupiedMap(),
      customNames: templeState.customNames,
      onlineCount: Object.keys(onlinePlayers).length
    });

    const displayName = templeState.customNames[charId] || `Đạo hữu #${charId + 1}`;
    io.emit('system_notice', {
      senderName: 'SƯƠNG MINH TỔ MÔN',
      dept: deptName || 'HR',
      message: `🟢 ${displayName} vừa bước vào Tổ Môn nhận ghế!`
    });
  });

  socket.on('move', ({ charId, destX, destY, afterAction }) => {
    templeState.charPositions[charId] = { x: destX, y: destY };
    socket.broadcast.emit('player_moved', {
      charId,
      destX,
      destY,
      afterAction
    });
  });

  socket.on('action', ({ charId, type }) => {
    if (type === 'wave') templeState.meritTotal += 5;
    else if (type === 'meditate') templeState.meritTotal += 20;
    else if (type === 'knock') templeState.meritTotal += 10;
    else if (type === 'waterfall') templeState.meritTotal += 15;
    else if (type === 'incense') {
      templeState.meritTotal += 30;
      templeState.activeIncenseSticks = Math.min(36, templeState.activeIncenseSticks + 3);
    }

    io.emit('sync_counters', {
      meritTotal: templeState.meritTotal,
      activeIncenseSticks: templeState.activeIncenseSticks
    });

    socket.broadcast.emit('player_action', { charId, type });
  });

  socket.on('chat', ({ charId, senderName, dept, text }) => {
    templeState.meritTotal += 5;
    const chatItem = { charId, senderName, dept, text, time: Date.now() };
    templeState.chatHistory.push(chatItem);
    if (templeState.chatHistory.length > 30) {
      templeState.chatHistory.shift();
    }

    io.emit('chat_message', {
      ...chatItem,
      meritTotal: templeState.meritTotal
    });
  });

  socket.on('mass_chant', () => {
    templeState.isMassChanting = !templeState.isMassChanting;
    templeState.isGoingHome = false;
    io.emit('sync_mass_chant', { isMassChanting: templeState.isMassChanting });
  });

  socket.on('go_home', () => {
    templeState.isGoingHome = !templeState.isGoingHome;
    templeState.isMassChanting = false;
    io.emit('sync_go_home', { isGoingHome: templeState.isGoingHome });
  });

  socket.on('update_all_names', ({ customNames }) => {
    templeState.customNames = { ...templeState.customNames, ...customNames };
    io.emit('players_updated', {
      occupiedMap: getOccupiedMap(),
      customNames: templeState.customNames,
      onlineCount: Object.keys(onlinePlayers).length
    });
  });

  socket.on('disconnect', () => {
    delete onlinePlayers[socket.id];
    io.emit('players_updated', {
      occupiedMap: getOccupiedMap(),
      customNames: templeState.customNames,
      onlineCount: Object.keys(onlinePlayers).length
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⛩️  SƯƠNG MINH TỔ MÔN đang mở cửa tại: http://localhost:${PORT}`);
});
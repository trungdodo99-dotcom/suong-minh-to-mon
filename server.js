const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'accounts.json');

// Hỗ trợ phục vụ file tĩnh ở cả thư mục public/ lẫn thư mục gốc
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const inPublic = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(inPublic)) {
    res.sendFile(inPublic);
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// Khởi tạo / Đọc dữ liệu tài khoản từ file accounts.json
const DEFAULT_ACCOUNTS = [
  {
    username: 'Trungdq',
    password: '123456',
    displayName: 'Trungdq',
    dept: 'IBD_COST',
    rank: 'ST3', // Trúc Cơ Kỳ (Áo đỏ)
    merit: 1080,
    status: 'APPROVED',
    isOnlineOnMap: false,
    isAdmin: true
  }
];

function loadAccountsFromDisk() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (err) {
    console.error('Lỗi đọc file accounts.json:', err);
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_ACCOUNTS, null, 2), 'utf8');
  return JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
}

function saveAccountsToDisk(accounts) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  } catch (err) {
    console.error('Lỗi lưu file accounts.json:', err);
  }
}

let accountsDB = loadAccountsFromDisk();
let activeIncenseSticks = 9;
let chatHistory = [];

io.on('connection', (socket) => {
  // Gửi ngay danh sách tài khoản, số nhang và lịch sử chat cho máy mới vào
  socket.emit('server_init', {
    accountsDB,
    activeIncenseSticks,
    chatHistory
  });

  // Nhận các sự kiện đồng bộ từ Client
  socket.on('temple_sync', (payload) => {
    if (!payload || !payload.type) return;

    if (payload.type === 'SYNC_DB' && Array.isArray(payload.accountsDB)) {
      accountsDB = payload.accountsDB;
      // Đảm bảo tài khoản quản lý Trungdq không bao giờ bị mất quyền
      const adminIdx = accountsDB.findIndex(a => a.username.toLowerCase() === 'trungdq');
      if (adminIdx !== -1) {
        accountsDB[adminIdx].isAdmin = true;
        accountsDB[adminIdx].status = 'APPROVED';
      }
      saveAccountsToDisk(accountsDB);
      io.emit('temple_sync', { type: 'SYNC_DB', accountsDB });
      return;
    }

    if (payload.type === 'CHAT_MSG') {
      chatHistory.push({
        senderName: payload.senderName,
        dept: payload.dept,
        text: payload.text
      });
      if (chatHistory.length > 35) chatHistory.shift();
    }

    if (payload.type === 'ACTION_CHAR' && payload.actionType === 'incense') {
      activeIncenseSticks = Math.min(36, activeIncenseSticks + 3);
    }

    // Phát sự kiện (di chuyển, hành lễ, ban phát deadline, chat) sang tất cả các máy khác
    socket.broadcast.emit('temple_sync', payload);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`⛩️  SƯƠNG MINH TỔ MÔN ĐÃ KHAI MỞ TẠI PORT ${PORT}`);
  console.log(`👉 Trên máy này: http://localhost:${PORT}`);
  console.log(`👉 Điện thoại/Máy cùng mạng LAN: http://<IP-Máy-Bạn>:${PORT}`);
  console.log(`👑 Acc Quản Lý: Trungdq | MK: 123456 (Tu vi: ST3)`);
  console.log(`====================================================`);
});
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const USED_TARGETS_FILE = path.join(__dirname, 'used_targets.json');

// ================= CẤU HÌNH 2 GEMINI API KEY =================
// 1. API CŨ: Quản trò (Chọn chủ đề, bốc nhân vật không trùng & chấm/công bố kết quả)
const API_GAMEMASTER_KEY = [
  "AQ",
  "Ab8RN6LN_YaX7XDjf57tn3vuLb9ElSJMh4yvsvMoy656cN3d_w"
].join(".");

// 2. API MỚI: Đối thủ AI Thám Tử (Trả lời trung thực & suy luận đặt câu hỏi Yes/No)
const API_OPPONENT_KEY = [
  "AQ",
  "Ab8RN6JL4-HHio2luYxQteDiY-KU-Aa6MPHA5Y8sW291x5oPQg"
].join(".");

const cachedModelsByKey = {};

const VALID_ANSWERS = ['YES', 'NO', 'MAYBE', 'PROBABLY_NO', 'DONT_KNOW'];

const ANSWER_LABELS_VI = {
  YES: 'CÓ (YES)',
  NO: 'KHÔNG (NO)',
  MAYBE: 'CÓ THỂ',
  PROBABLY_NO: 'HÌNH NHƯ KHÔNG',
  DONT_KNOW: 'KHÔNG BIẾT'
};

// Danh sách từ phân loại chung (không phải tên riêng nhân vật/hãng)
const GENERIC_ATTRIBUTE_WORDS = [
  'nam', 'nu', 'nam gioi', 'nu gioi', 'dan ong', 'phu nu', 'con trai', 'con gai',
  'nguoi viet', 'viet nam', 'chau a', 'chau au', 'chau my', 'chau phi', 'han quoc', 'nhat ban', 'trung quoc', 'my', 'duc', 'phap', 'anh', 'y', 'thai lan', 'dong nam a',
  'ca si', 'rapper', 'dien vien', 'streamer', 'youtuber', 'tiktoker', 'mc', 'danh hai', 'dao dien', 'nhac si', 'hoa hau', 'nguoi mau', 'cau thu', 'van dong vien', 'ty phu', 'doanh nhan', 'chinh tri gia', 'nha khoa hoc', 'danh tuong', 'hoang de', 'vua', 'anh hung', 'quan su', 'idol', 'kol', 'nghe si', 'nhom nhac', 'than tuong', 'nha phat minh', 'hoa si', 'nha van',
  'con nguoi', 'nguoi that', 'nguoi noi tieng', 'nhan vat hu cau', 'nhan vat chinh', 'phan dien', 'sieu anh hung', 'anime', 'manga', 'game', 'truyen tranh',
  'hang xe', 'xe dien', 'xe sang', 'sieu xe', 'xe pho thong', 'xe the thao', 'xe gia dinh', 'o to', 'thuong hieu', 'cong ty', 'tap doan', 'mon an', 'dong vat', 'quoc gia', 'dia danh',
  'dang con song', 'con song', 'da mat', 'tre', 'gen z', '9x', '8x', '7x', 'doc than', 'da ket hon', 'co vo', 'co chong', 'co con',
  'am nhac', 'dien anh', 'the thao', 'bong da', 'cong nghe', 'lich su', 'thoi trang', 'hai huoc', 'drama', 'scandal', 'noi tieng', 'mien bac', 'mien nam', 'mien trung', 'ha noi', 'sai gon', 'tp hcm'
];

async function getAvailableGeminiModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      headers: { 'x-goog-api-key': apiKey }
    });
    const data = await res.json();
    if (!data?.models) return [];

    const validModels = data.models
      .filter(m =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent') &&
        !/embedding|imagen|veo|tts|audio|vision|aqa|bisect/i.test(m.name)
      )
      .map(m => m.name.replace(/^models\//, ''));

    validModels.sort((a, b) => {
      const aFlash = a.includes('flash') ? 0 : 1;
      const bFlash = b.includes('flash') ? 0 : 1;
      return aFlash - bFlash;
    });

    return validModels;
  } catch (e) {
    console.error('Loi lay danh sach model:', e.message);
    return [];
  }
}

async function callGeminiText(apiKey, systemInstruction, userPrompt, temperature = 0.8) {
  const key = (apiKey || '').trim();
  if (!key) throw new Error('Thieu API Key');

  let candidates = [];
  if (cachedModelsByKey[key]) candidates.push(cachedModelsByKey[key]);

  if (candidates.length === 0) {
    const discovered = await getAvailableGeminiModels(key);
    candidates = [...new Set([
      ...discovered,
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-flash-latest'
    ])];
  } else {
    candidates.push('gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest');
    candidates = [...new Set(candidates)];
  }

  let lastErr = '';
  const fullPrompt = `${systemInstruction}\n\n${userPrompt}`;

  for (const modelName of candidates) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: {
            maxOutputTokens: 1200,
            temperature
          }
        })
      });

      const data = await res.json();
      if (data?.error) {
        lastErr = `[${modelName}] ${data.error.message}`;
        if (cachedModelsByKey[key] === modelName) delete cachedModelsByKey[key];
        continue;
      }

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const textParts = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text);
      const text = (textParts.join('\n') || parts[0]?.text || '').trim();
      if (text) {
        cachedModelsByKey[key] = modelName;
        return text;
      }
    } catch (err) {
      lastErr = err.message;
    }
  }

  throw new Error(lastErr || 'Khong goi duoc Gemini API');
}

function extractJSON(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

function normalizeVN(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Phát hiện nếu AI hỏi đích danh tên nhân vật ("Có phải là [Tên] không?") thay vì chốt đáp án
function detectDirectNameQuestion(qText, targetSecret) {
  const cleanQ = (qText || '').trim();
  const qNorm = normalizeVN(cleanQ);

  // 1. Khớp trực tiếp tên hoặc biệt danh của đáp án thật
  const targetNames = [targetSecret?.name, ...(targetSecret?.aliases || [])].filter(Boolean);
  for (const tn of targetNames) {
    const tnNorm = normalizeVN(tn);
    if (tnNorm.length >= 3 && new RegExp(`(^|\\s)${escapeRegex(tnNorm)}(\\s|$)`).test(qNorm)) {
      return { isDirectName: true, extractedName: tn };
    }
  }

  // 2. Bắt mẫu câu hỏi đích danh tên riêng: "Có phải (là) [Tên Riêng] không / phải không / đúng không?"
  const pattern = /(?:có phải(?:\s+là)?|phải là|đáp án(?:\s+của bạn)?(?:\s+có phải)?\s+là|nhân vật(?:\s+này|\s+của bạn)?(?:\s+có phải)?\s+là|đối tượng(?:\s+này|\s+của bạn)?(?:\s+có phải)?\s+là|hãng(?:\s+xe)?(?:\s+này)?(?:\s+có phải)?\s+là|người này(?:\s+có phải)?\s+là|tên(?:\s+của)?(?:\s+nhân vật này|\s+người này)?\s+là)\s+["'“”]?([^?,"'“”]{2,44}?)["'“”]?\s*(?:không|ko|k|phải không|đúng không|nhỉ|chứ|\?)+$/i;
  const m = cleanQ.match(pattern);
  if (m && m[1]) {
    const candidate = m[1]
      .trim()
      .replace(/^(là|một|người|ca sĩ|rapper|diễn viên|streamer|hãng|xe|vua|đại tướng|nghệ sĩ|tỷ phú|cầu thủ)\s+/i, '')
      .trim();
    const candNorm = normalizeVN(candidate);
    if (candNorm.length >= 2 && candNorm.split(' ').length <= 5) {
      const isGeneric = GENERIC_ATTRIBUTE_WORDS.some(w =>
        candNorm === w || candNorm.startsWith(w + ' ') || candNorm.endsWith(' ' + w)
      );
      const startsWithUpper = /^[A-ZĐÀÁẢÃẠÂẤẦẨẪẬĂẮẰẲẴẶÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ]/.test(candidate);
      if (!isGeneric && startsWithUpper) {
        return { isDirectName: true, extractedName: candidate };
      }
    }
  }

  return { isDirectName: false, extractedName: '' };
}

// ================= BỘ NHỚ CHỐNG TRÙNG NHÂN VẬT TOÀN CỤC =================
let usedTargetsByTopic = {};

function loadUsedTargets() {
  try {
    if (fs.existsSync(USED_TARGETS_FILE)) {
      usedTargetsByTopic = JSON.parse(fs.readFileSync(USED_TARGETS_FILE, 'utf8'));
    }
  } catch (e) {
    usedTargetsByTopic = {};
  }
}

function saveUsedTargets() {
  try {
    fs.writeFileSync(USED_TARGETS_FILE, JSON.stringify(usedTargetsByTopic, null, 2), 'utf8');
  } catch (e) {}
}

function getBlockedTargets(topicPref, roomUsed = []) {
  const globalList = Array.isArray(usedTargetsByTopic[topicPref]) ? usedTargetsByTopic[topicPref] : [];
  const allGlobal = Object.values(usedTargetsByTopic).flat().slice(-40);
  return [...new Set([...roomUsed, ...globalList, ...allGlobal])].slice(-80);
}

function rememberUsedTargets(topicPref, names = []) {
  if (!Array.isArray(usedTargetsByTopic[topicPref])) {
    usedTargetsByTopic[topicPref] = [];
  }
  for (const n of names) {
    if (!n) continue;
    const exists = usedTargetsByTopic[topicPref].some(x => normalizeVN(x) === normalizeVN(n));
    if (!exists) usedTargetsByTopic[topicPref].push(n);
  }
  if (usedTargetsByTopic[topicPref].length > 100) {
    usedTargetsByTopic[topicPref] = usedTargetsByTopic[topicPref].slice(-100);
  }
  saveUsedTargets();
}

loadUsedTargets();

// ================= CẤU HÌNH CHỦ ĐỀ + NHÁNH PHỤ CHỐNG TRÙNG =================
const TOPIC_CONFIGS = {
  hot_drama: {
    guide: 'ƯU TIÊN CAO NHẤT: Nhân vật nghệ sĩ, ca sĩ, rapper, streamer, KOL, diễn viên, nhân vật giải trí có drama, scandal hoặc siêu hot tại Việt Nam & thế giới.',
    subAngles: [
      'Ca sĩ nhạc Pop / Ballad Việt Nam nổi tiếng hoặc có lùm xùm mạng xã hội',
      'Rapper Việt Nam (Rap Việt, Anh Trai Say Hi, Anh Trai Vượt Ngàn Chông Gai, Underground)',
      'Streamer, YouTuber, TikToker Việt Nam nổi tiếng hay tạo trend hoặc drama',
      'Diễn viên điện ảnh, MC, danh hài Việt Nam phủ sóng mạnh trên truyền thông',
      'Thần tượng K-Pop (Hàn Quốc) hoặc nghệ sĩ C-Biz (Trung Quốc) có fan đông đảo tại Việt Nam',
      'Ca sĩ / Rapper / Diễn viên Hollywood (US-UK) thường xuyên gây bão truyền thông quốc tế',
      'Cầu thủ bóng đá, vận động viên hoặc tỷ phú công nghệ nổi tiếng thế giới hay lên mặt báo',
      'Hoa hậu, người mẫu, doanh nhân hoặc nhân vật mạng xã hội Việt Nam gây chú ý lớn'
    ]
  },
  vn_showbiz: {
    guide: 'BẮT BUỘC: Nghệ sĩ, ca sĩ, rapper, streamer, MC, diễn viên, Hoa hậu hoặc KOL nổi tiếng tại Việt Nam.',
    subAngles: [
      'Ca sĩ trẻ Gen Z và thế hệ 9x nổi bật của V-Pop',
      'Ca sĩ gạo cội / Ngôi sao hạng A lâu năm của V-Pop',
      'Rapper và Producer đình đám tại Việt Nam',
      'Streamer, YouTuber, Creator nổi tiếng của cộng đồng mạng Việt',
      'MC, danh hài, đạo diễn, diễn viên điện ảnh trăm tỷ Việt Nam',
      'Hoa hậu, người đẹp, KOL từng gây sốt hoặc có câu chuyện ồn ào trên báo chí Việt'
    ]
  },
  global_star: {
    guide: 'BẮT BUỘC: Ngôi sao giải trí, ca sĩ, diễn viên, vận động viên, tỷ phú hoặc nhân vật công chúng toàn cầu.',
    subAngles: [
      'Ngôi sao nhạc Pop / Rap US-UK nổi tiếng toàn cầu',
      'Thần tượng K-Pop đình đám từ các nhóm nhạc lớn Hàn Quốc',
      'Diễn viên Hollywood hạng A gắn liền với các bom tấn điện ảnh',
      'Siêu sao bóng đá, bóng rổ, thể thao huyền thoại thế giới',
      'Tỷ phú công nghệ, doanh nhân có sức ảnh hưởng lớn toàn cầu',
      'Ngôi sao điện ảnh / âm nhạc Hoa ngữ hoặc Châu Á cực nổi tiếng tại Việt Nam'
    ]
  },
  car_brands: {
    guide: 'BẮT BUỘC: Các hãng xe hơi (ô tô) nổi tiếng trên thế giới và Việt Nam.',
    subAngles: [
      'Hãng xe hơi phổ thông Nhật Bản và Hàn Quốc rất phổ biến tại Việt Nam',
      'Hãng xe sang đến từ Đức và Châu Âu',
      'Hãng siêu xe thể thao huyền thoại của Ý, Anh, Pháp',
      'Hãng xe điện hiện đại và hãng xe Mỹ nổi tiếng',
      'Hãng xe địa hình, SUV mạnh mẽ hoặc thương hiệu xe đang hot tại thị trường Việt Nam'
    ]
  },
  history: {
    guide: 'BẮT BUỘC: Nhân vật lịch sử nổi tiếng của Việt Nam hoặc thế giới (danh tướng, vua chúa, nhà khoa học, danh nhân văn hóa).',
    subAngles: [
      'Anh hùng dân tộc, danh tướng, vua chúa kiệt xuất trong lịch sử Việt Nam',
      'Nhà khoa học, nhà phát minh làm thay đổi lịch sử nhân loại',
      'Hoàng đế, danh tướng, nhân vật chính trị lừng danh lịch sử Châu Âu & Châu Á cổ đại',
      'Danh họa, nhạc sĩ cổ điển, nhà văn, triết gia huyền thoại thế giới',
      'Nhân vật lịch sử thời Tam Quốc / Phong kiến Trung Hoa cực quen thuộc với người Việt'
    ]
  },
  anime_game: {
    guide: 'BẮT BUỘC: Nhân vật hư cấu cực nổi tiếng trong Anime, Manga, Siêu anh hùng Marvel/DC hoặc Game.',
    subAngles: [
      'Nhân vật chính hoặc phản diện kinh điển trong Anime/Manga Shonen (One Piece, Naruto, Dragon Ball, Bleach, Jujutsu Kaisen, Kimetsu no Yaiba...)',
      'Nhân vật trong truyện tranh tuổi thơ quen thuộc tại Việt Nam (Doraemon, Conan, Shin, Pokemon...)',
      'Siêu anh hùng và phản diện nổi tiếng của vũ trụ Marvel & DC Comics',
      'Nhân vật biểu tượng trong các tựa game nổi tiếng (Liên Minh, Liên Quân, GTA, Mario, Genshin, God of War...)'
    ]
  },
  random: {
    guide: 'NGẪU NHIÊN ĐA DẠNG: Có thể là con người HOẶC thương hiệu/đồ vật/món ăn/hãng xe/địa danh/phim ảnh nổi tiếng mà người Việt đều quen thuộc.',
    subAngles: [
      'Các món ăn đặc sản nổi tiếng của Việt Nam và thế giới',
      'Các hãng công nghệ, điện thoại, mạng xã hội nổi tiếng toàn cầu',
      'Các quốc gia hoặc địa danh du lịch biểu tượng trên thế giới',
      'Các loài động vật quen thuộc hoặc thú vị',
      'Các hãng xe hơi, hãng thời trang hoặc chuỗi đồ ăn nhanh nổi tiếng',
      'Các nhân vật giải trí, nghệ sĩ hoặc nhân vật hư cấu cực kỳ nổi tiếng'
    ]
  }
};

// ================= KHO DỰ PHÒNG MỞ RỘNG NẾU API BẬN =================
const FALLBACK_DECKS = {
  vn_showbiz: {
    topicName: 'Nghệ Sĩ & Nhân Vật Hot Showbiz Việt',
    topicDescription: 'Ca sĩ, rapper, diễn viên, streamer và KOL Việt Nam nổi tiếng hoặc từng tạo bão mạng xã hội.',
    items: [
      { name: 'Sơn Tùng M-TP', aliases: ['Son Tung', 'MTP', 'Nguyen Thanh Tung'], facts: ['Ca sĩ quê Thái Bình, chủ tịch công ty giải trí riêng', 'Nổi tiếng với Lạc Trôi, Hãy Trao Cho Anh, Chúng Ta Của Hiện Tại', 'Phong cách âm nhạc hiện đại, cực kỳ kín tiếng đời tư'] },
      { name: 'Jack - J97', aliases: ['Jack', 'J97', 'Trinh Tran Phuong Tuan'], facts: ['Ca sĩ quê Bến Tre, nổi lên từ Hồng Nhan, Bạc Phận, Sóng Gió', 'Cộng đồng fan mang tên Đóm', 'Từng dính nhiều ồn ào đời tư và tranh cãi trên mạng xã hội'] },
      { name: 'Trấn Thành', aliases: ['Tran Thanh', 'Huynh Tran Thanh'], facts: ['MC, diễn viên, đạo diễn loạt phim trăm tỷ (Bố Già, Nhà Bà Nữ, Mai)', 'Kết hôn với nữ ca sĩ gốc Hàn Quốc Hari Won', 'Nổi tiếng hoạt ngôn và hay xúc động trên sóng truyền hình'] },
      { name: 'Độ Mixi', aliases: ['Do Mixi', 'Phung Thanh Do', 'Toc Truong'], facts: ['Streamer hàng đầu Việt Nam quê Cao Bằng', 'Trưởng nhóm Refund Gaming, hay livestream tâm sự và chơi game', 'Sở hữu cộng đồng fan Bộ Tộc đông đảo nhất nhì Việt Nam'] },
      { name: 'HIEUTHUHAI', aliases: ['Hieu Thu Hai', 'Tran Minh Hieu'], facts: ['Rapper sinh năm 1999 thuộc tổ đội GERDNANG', 'Quán quân Anh Trai Say Hi, thành viên 2 Ngày 1 Đêm', 'Sở hữu các bản hit Ngủ Một Mình, Không Thể Say'] },
      { name: 'Đen Vâu', aliases: ['Den Vau', 'Nguyen Duc Cuong'], facts: ['Rapper từng làm công nhân vệ sinh bãi biển ở Hạ Long', 'Nổi tiếng với Lối Nhỏ, Mang Tiền Về Cho Mẹ, Nấu Ăn Cho Em', 'Gắn liền với phong cách mộc mạc và các dự án thiện nguyện'] },
      { name: 'Mỹ Tâm', aliases: ['My Tam', 'Hoa Mi Toc Nau'], facts: ['Nữ ca sĩ hạng A quê Đà Nẵng, biệt danh Họa mi tóc nâu', 'Sở hữu loạt liveshow Tri Âm hàng chục nghìn khán giả', 'Nổi tiếng với Ước Gì, Đừng Hỏi Em, Người Hãy Quên Em Đi'] },
      { name: 'SOOBIN', aliases: ['Soobin Hoang Son', 'Nguyen Huynh Son'], facts: ['Nam ca sĩ, nhạc sĩ thuộc SpaceSpeakers xuất thân từ Hà Nội', 'Gây bão trở lại nhờ chương trình Anh Trai Vượt Ngàn Chông Gai', 'Nổi tiếng với Phía Sau Một Cô Gái, Giá Như'] },
      { name: 'Hòa Minzy', aliases: ['Hoa Minzy', 'Nguyen Thi Hoa'], facts: ['Nữ ca sĩ quê Bắc Ninh, quán quân Học Viện Ngôi Sao', 'Nổi tiếng với Rời Bỏ, Không Thể Cùng Nhau Suốt Kiếp, Thị Mầu', 'Tính cách hài hước, thân thiết với gia đình Hoa Dâm Bụt'] },
      { name: 'Binz', aliases: ['Le Nguyen Trung Dan', 'Xuan Dan'], facts: ['Rapper thuộc SpaceSpeakers từng làm HLV Rap Việt', 'Nổi tiếng với Bigcityboi, OK, Hit Me Up', 'Gắn liền với màu hồng và phong cách lãng tử'] },
      { name: 'ViruSs', aliases: ['Viruss', 'Dang Tien Hoang'], facts: ['Streamer, nhạc sĩ, reaction YouTuber nổi tiếng', 'Tác giả bản hit Thằng Điên, Trời Giấu Trời Mang Đi', 'Thường xuyên gây tranh luận sôi nổi trên mạng xã hội'] },
      { name: 'Bích Phương', aliases: ['Bich Phuong', 'Bui Thi Bich Phuong'], facts: ['Nữ ca sĩ quê Quảng Ninh nổi tiếng với tính cách lầy lội', 'Sở hữu các bản hit Bùa Yêu, Đi Đu Đưa Đi, Bao Giờ Lấy Chồng', 'Được fan gọi là thánh lầy V-Pop'] }
    ]
  },
  global_star: {
    topicName: 'Ngôi Sao & Nhân Vật Nổi Tiếng Toàn Cầu',
    topicDescription: 'Ca sĩ, diễn viên, vận động viên và tỷ phú quốc tế quen mặt với khán giả Việt Nam.',
    items: [
      { name: 'Taylor Swift', aliases: ['Taylor'], facts: ['Nữ ca sĩ nhạc Pop/Country người Mỹ sở hữu The Eras Tour tỷ đô', 'Đạt kỷ lục nhiều giải Grammy Album của năm nhất', 'Nổi tiếng viết nhạc từ chuyện tình cảm và cuộc chiến bản quyền'] },
      { name: 'Elon Musk', aliases: ['Musk'], facts: ['Tỷ phú gốc Nam Phi, CEO Tesla và SpaceX', 'Chủ sở hữu mạng xã hội X (Twitter cũ) và công ty xAI', 'Liên tục gây tranh cãi vì các phát ngôn trên mạng xã hội'] },
      { name: 'Cristiano Ronaldo', aliases: ['CR7', 'Ronaldo'], facts: ['Siêu sao bóng đá người Bồ Đào Nha giành 5 Quả Bóng Vàng', 'Từng khoác áo Man Utd, Real Madrid, Juventus và Al Nassr', 'Nổi tiếng với pha ăn mừng Siuuu kinh điển'] },
      { name: 'Lionel Messi', aliases: ['Messi', 'M10'], facts: ['Siêu sao bóng đá người Argentina vô địch World Cup 2022', 'Giữ kỷ lục 8 Quả Bóng Vàng trong lịch sử bóng đá', 'Huyền thoại CLB Barcelona, hiện thi đấu tại Mỹ cho Inter Miami'] },
      { name: 'G-Dragon', aliases: ['GD', 'Kwon Ji Yong'], facts: ['Trưởng nhóm huyền thoại BIGBANG của K-Pop', 'Biểu tượng thời trang toàn cầu, sáng lập PEACEMINUSONE', 'Được mệnh danh là Ông hoàng K-Pop'] },
      { name: 'Lisa (BLACKPINK)', aliases: ['Lisa', 'Lalisa Manobal'], facts: ['Nữ idol người Thái Lan thuộc nhóm nhạc nữ hàng đầu K-Pop', 'Sở hữu các bản hit solo Lalisa, Money, Rockstar', 'Lượng người theo dõi Instagram cao bậc nhất giới K-Pop'] },
      { name: 'MrBeast', aliases: ['Jimmy Donaldson'], facts: ['YouTuber cá nhân có lượng người đăng ký lớn nhất thế giới', 'Nổi tiếng với các thử thách tốn hàng triệu đô và làm từ thiện', 'Sở hữu thương hiệu sô-cô-la Feastables'] },
      { name: 'Jackie Chan', aliases: ['Thanh Long'], facts: ['Ngôi sao võ thuật hài huyền thoại gốc Hồng Kông', 'Nổi tiếng tự đóng các cảnh hành động mạo hiểm không cần thế thân', 'Từng nhận giải Oscar Thành tựu trọn đời'] }
    ]
  },
  car_brands: {
    topicName: 'Các Hãng Xe Hơi Nổi Tiếng Thế Giới',
    topicDescription: 'Thương hiệu ô tô từ phổ thông, xe điện cho đến xe sang và siêu xe thể thao.',
    items: [
      { name: 'VinFast', aliases: ['Vin Fast'], facts: ['Hãng xe điện Việt Nam thuộc tập đoàn Vingroup', 'Nổi tiếng với các dòng VF3, VF5, VF8, VF9', 'Có nhà máy sản xuất lớn tại Hải Phòng'] },
      { name: 'Toyota', aliases: ['Toyota Motor'], facts: ['Hãng xe lớn nhất Nhật Bản, nổi tiếng bền bỉ và giữ giá', 'Các mẫu xe quen thuộc: Vios, Camry, Fortuner, Innova', 'Sở hữu thương hiệu xe sang Lexus'] },
      { name: 'Mercedes-Benz', aliases: ['Mercedes', 'Mec', 'Merc'], facts: ['Hãng xe sang lâu đời của Đức với logo ngôi sao 3 cánh', 'Nổi bật với dòng C-Class, E-Class, S-Class và G63', 'Rất được ưa chuộng bởi doanh nhân và nghệ sĩ'] },
      { name: 'BMW', aliases: ['Bim', 'Bayerische Motoren Werke'], facts: ['Hãng xe sang Đức nổi tiếng cảm giác lái thể thao', 'Đặc trưng với lưới tản nhiệt hình quả thận kép phía trước', 'Logo chia 4 ô xanh trắng mô phỏng màu cờ xứ Bavaria'] },
      { name: 'Ferrari', aliases: ['Ngua chom'], facts: ['Hãng siêu xe huyền thoại của Ý với logo chú ngựa chồm', 'Gắn liền với sắc đỏ đặc trưng và đội đua F1 lâu đời', 'Quy định bán xe cực kỳ khắt khe cho khách hàng'] },
      { name: 'Lamborghini', aliases: ['Lambo', 'Bo tot'], facts: ['Hãng siêu xe thể thao nước Ý với logo bò tót màu vàng', 'Nổi tiếng với cửa cắt kéo và thiết kế góc cạnh sắc bén', 'Các dòng xe biểu tượng: Aventador, Huracan, Urus'] },
      { name: 'Tesla', aliases: ['Tesla Motors'], facts: ['Hãng xe điện hàng đầu của Mỹ do Elon Musk dẫn dắt', 'Nổi tiếng với công nghệ tự lái và mẫu bán tải Cybertruck', 'Dẫn đầu làn sóng ô tô điện toàn cầu'] },
      { name: 'Hyundai', aliases: ['Huyndai'], facts: ['Hãng xe hàng đầu Hàn Quốc với logo chữ H nghiêng', 'Rất phổ biến tại Việt Nam với Accent, Tucson, SantaFe', 'Cùng tập đoàn mẹ với thương hiệu KIA'] },
      { name: 'Porsche', aliases: ['Porche'], facts: ['Hãng xe thể thao hạng sang của Đức nổi tiếng với dòng 911', 'Còn rất thành công với các mẫu SUV như Macan, Cayenne', 'Thiết kế đèn pha tròn đặc trưng dễ nhận diện'] },
      { name: 'Ford', aliases: ['Ford Motor'], facts: ['Hãng xe lâu đời của Mỹ do Henry Ford sáng lập', 'Nổi tiếng tại Việt Nam với vua bán tải Ranger và Everest', 'Sở hữu dòng xe cơ bắp huyền thoại Mustang'] }
    ]
  },
  history: {
    topicName: 'Nhân Vật Lịch Sử Việt Nam & Thế Giới',
    topicDescription: 'Anh hùng dân tộc, danh tướng, hoàng đế và các nhà khoa học lừng danh lịch sử.',
    items: [
      { name: 'Trần Hưng Đạo', aliases: ['Tran Quoc Tuan', 'Hung Dao Vuong'], facts: ['Danh tướng kiệt xuất thời nhà Trần Việt Nam', '3 lần lãnh đạo đại phá quân Nguyên - Mông và chiến thắng Bạch Đằng', 'Tác giả bài Hịch Tướng Sĩ bất hủ'] },
      { name: 'Nguyễn Huệ', aliases: ['Quang Trung', 'Vua Quang Trung'], facts: ['Anh hùng áo vải Tây Sơn, vị hoàng đế bách chiến bách thắng', 'Chỉ huy trận Ngọc Hồi - Đống Đa đại phá quân Thanh Tết Kỷ Dậu 1789', 'Nổi tiếng với nghệ thuật hành quân thần tốc'] },
      { name: 'Albert Einstein', aliases: ['Einstein'], facts: ['Nhà vật lý lý thuyết thiên tài gốc Đức', 'Cha đẻ Thuyết Tương Đối và công thức E = mc^2', 'Nổi tiếng với mái tóc bạc bù xù và bức ảnh thè lưỡi'] },
      { name: 'Napoleon Bonaparte', aliases: ['Napoleon'], facts: ['Hoàng đế và nhà quân sự kiệt xuất của nước Pháp', 'Gắn liền với trận thua định mệnh tại Waterloo', 'Thường được nhớ đến với chiếc mũ hai sừng đặc trưng'] },
      { name: 'Võ Nguyên Giáp', aliases: ['Dai tuong Vo Nguyen Giap', 'Bac Giap'], facts: ['Vị Đại tướng đầu tiên, Tổng Tư lệnh Quân đội Nhân dân Việt Nam', 'Người chỉ huy làm nên chiến thắng Điện Biên Phủ 1954 lừng lẫy năm châu', 'Được thế giới xếp vào nhóm các danh tướng vĩ đại nhất lịch sử'] },
      { name: 'Leonardo da Vinci', aliases: ['Da Vinci'], facts: ['Thiên tài toàn năng thời Phục Hưng người Ý', 'Tác giả bức họa nàng Mona Lisa và Bữa ăn tối cuối cùng', 'Vừa là họa sĩ, nhà điêu khắc vừa là nhà phát minh xuất chúng'] },
      { name: 'Gia Cát Lượng', aliases: ['Khong Minh', 'Gia Cat Khong Minh'], facts: ['Quân sư kiệt xuất thời Tam Quốc phò tá Lưu Bị nước Thục Hán', 'Gắn liền với chiếc quạt lông vũ và điển tích Ba lần đến lều cỏ', 'Biểu tượng của trí tuệ mưu lược trong văn hóa Á Đông'] },
      { name: 'Thomas Edison', aliases: ['Edison'], facts: ['Nhà phát minh vĩ đại người Mỹ sở hữu hơn 1.000 bằng sáng chế', 'Gắn liền với việc thương mại hóa bóng đèn sợi đốt và máy hát', 'Từng có cuộc chiến dòng điện nổi tiếng với Nikola Tesla'] }
    ]
  },
  anime_game: {
    topicName: 'Nhân Vật Anime, Manga & Siêu Anh Hùng',
    topicDescription: 'Những nhân vật hư cấu cực kỳ nổi tiếng trong Anime, Truyện tranh, Marvel/DC và Game.',
    items: [
      { name: 'Monkey D. Luffy', aliases: ['Luffy', 'Mu Rom'], facts: ['Thuyền trưởng băng Hải tặc Mũ Rơm trong One Piece', 'Ăn trái ác quỷ biến cơ thể thành cao su, ước mơ làm Vua Hải Tặc', 'Nổi tiếng với chiếc mũ rơm và vết sẹo dưới mắt trái'] },
      { name: 'Son Goku', aliases: ['Goku', 'Kakarot'], facts: ['Nhân vật chính người Saiyan trong 7 Viên Ngọc Rồng', 'Nổi tiếng với chiêu Kamehameha và biến hình tóc vàng Super Saiyan', 'Rất mê ăn uống và thích đấu với đối thủ mạnh'] },
      { name: 'Doraemon', aliases: ['Do re mon', 'Meo May'], facts: ['Chú mèo máy đến từ thế kỷ 22 trong truyện tranh Nhật Bản', 'Sở hữu chiếc túi thần kỳ trước bụng chứa vô số bảo bối', 'Cực kỳ thích bánh rán Dorayaki và sợ chuột'] },
      { name: 'Gojo Satoru', aliases: ['Gojo', 'Thay Gojo'], facts: ['Chú thuật sư mạnh nhất trong bộ anime Jujutsu Kaisen', 'Đặc trưng với mái tóc trắng, Lục Nhãn xanh và thường đeo băng bịt mắt', 'Tính cách tự tin, nhây nhưng rất bảo vệ học trò'] },
      { name: 'Iron Man', aliases: ['Tony Stark', 'Nguoi Sat'], facts: ['Tỷ phú thiên tài mặc bộ giáp công nghệ cao của vũ trụ Marvel', 'Thành viên nòng cốt của biệt đội siêu anh hùng Avengers', 'Nổi tiếng với câu nói I am Iron Man'] },
      { name: 'Naruto Uzumaki', aliases: ['Naruto'], facts: ['Ninja làng Lá mang trong mình Cửu Vĩ Hồ', 'Ước mơ trở thành Hokage, nổi tiếng với Rasengan và Ảnh Phân Thân', 'Mặc bộ đồ màu cam đen đặc trưng và rất thích ăn mì Ramen'] },
      { name: 'Pikachu', aliases: ['Pika'], facts: ['Linh vật chuột điện màu vàng biểu tượng của thương hiệu Pokemon', 'Bạn đồng hành thân thiết nhất của Ash (Satoshi)', 'Chiêu thức nổi tiếng nhất là Điện 100.000 Vôn'] },
      { name: 'Batman', aliases: ['Bruce Wayne', 'Nguoi Doi'], facts: ['Siêu anh hùng không có siêu năng lực của vũ trụ DC tại thành phố Gotham', 'Ban ngày là tỷ phú, ban đêm mặc giáp dơi dùng trí tuệ và công nghệ diệt tội phạm', 'Kẻ thù truyền kiếp nổi tiếng nhất là Joker'] }
    ]
  }
};

// ================= HÀM QUẢN TRÒ (DÙNG API CŨ) =================
async function generateRoundWithGameMaster(topicPref = 'hot_drama', roomUsed = []) {
  const cfg = TOPIC_CONFIGS[topicPref] || TOPIC_CONFIGS.hot_drama;
  const blocked = getBlockedTargets(topicPref, roomUsed);
  const blockedNormSet = new Set(blocked.map(normalizeVN));

  for (let attempt = 0; attempt < 2; attempt++) {
    const randomSubAngle = cfg.subAngles[Math.floor(Math.random() * cfg.subAngles.length)];
    const randomSeed = Math.floor(10000 + Math.random() * 90000);
    const avoidStr = blocked.length > 0
      ? `DANH SÁCH CẤM (ĐÃ CHƠI RỒI — TUYỆT ĐỐI KHÔNG CHỌN LẠI BẤT KỲ TÊN NÀO DƯỚI ĐÂY): ${blocked.join(', ')}.`
      : '';

    const systemPrompt = `Bạn là Quản Trò sáng tạo của game đoán nhân vật Yes/No tên là "Là ải là ai" bằng tiếng Việt.
Nhiệm vụ:
1. Chọn 1 chủ đề hấp dẫn phù hợp với yêu cầu và góc khai thác bên dưới, viết mô tả rõ ràng (1-2 câu).
2. Chọn ĐÚNG 2 nhân vật/đối tượng KHÁC NHAU nhưng CÙNG THUỘC CHỦ ĐỀ ĐÓ, đủ nổi tiếng để người Việt Nam biết và đặt câu hỏi Yes/No đoán ra được.
3. ĐA DẠNG HÓA TỐI ĐA: Tránh lặp lại các cái tên đã nằm trong danh sách cấm. Hãy chọn 2 cái tên MỚI MẺ, bất ngờ nhưng vẫn cực kỳ quen thuộc!
4. Mỗi đối tượng phải có đúng 3 gợi ý ("facts") đi từ mức độ chung chung đến cụ thể hơn, KHÔNG nhắc trực tiếp tên đối tượng trong "facts".

CHỈ TRẢ VỀ DUY NHẤT 1 JSON HỢP LỆ (không thêm chữ nào ngoài JSON):
{
  "topicName": "Tên chủ đề ngắn gọn (3-8 từ)",
  "topicDescription": "Mô tả phạm vi chủ đề trong 1-2 câu rõ ràng.",
  "p1Target": {
    "name": "Tên chuẩn phổ biến nhất của đối tượng 1",
    "aliases": ["Tên thật / Nghệ danh khác / Biệt danh 1", "Tên viết tắt nếu có"],
    "facts": ["Gợi ý 1 (rộng, không lộ tên)", "Gợi ý 2 (trung bình, không lộ tên)", "Gợi ý 3 (dấu ấn / drama đặc trưng, không lộ tên)"]
  },
  "p2Target": {
    "name": "Tên chuẩn phổ biến nhất của đối tượng 2 (PHẢI KHÁC đối tượng 1)",
    "aliases": ["Tên thật / Nghệ danh khác / Biệt danh 2", "Tên viết tắt nếu có"],
    "facts": ["Gợi ý 1 (rộng, không lộ tên)", "Gợi ý 2 (trung bình, không lộ tên)", "Gợi ý 3 (dấu ấn / drama đặc trưng, không lộ tên)"]
  }
}`;

    const userPrompt = `Mã ngẫu nhiên phiên này: #${randomSeed} (Lần thử ${attempt + 1}).
Yêu cầu chủ đề chính: ${cfg.guide}
Góc khai thác gợi ý cho ván này để không bị lặp lại ván trước: "${randomSubAngle}".
${avoidStr}
Hãy tạo vòng chơi mới thật cuốn hút!`;

    try {
      const raw = await callGeminiText(API_GAMEMASTER_KEY, systemPrompt, userPrompt, 1.0);
      const parsed = extractJSON(raw);
      if (
        parsed &&
        parsed.topicName &&
        parsed.topicDescription &&
        parsed.p1Target?.name &&
        parsed.p2Target?.name
      ) {
        const n1 = normalizeVN(parsed.p1Target.name);
        const n2 = normalizeVN(parsed.p2Target.name);
        const isDuplicateWithSelf = n1 === n2;
        const isInBlacklist = blockedNormSet.has(n1) || blockedNormSet.has(n2);

        if (!isDuplicateWithSelf && (!isInBlacklist || attempt === 1)) {
          const p1Secret = {
            name: String(parsed.p1Target.name).trim(),
            aliases: Array.isArray(parsed.p1Target.aliases) ? parsed.p1Target.aliases.map(String) : [],
            facts: Array.isArray(parsed.p1Target.facts) ? parsed.p1Target.facts.slice(0, 3).map(String) : []
          };
          const p2Secret = {
            name: String(parsed.p2Target.name).trim(),
            aliases: Array.isArray(parsed.p2Target.aliases) ? parsed.p2Target.aliases.map(String) : [],
            facts: Array.isArray(parsed.p2Target.facts) ? parsed.p2Target.facts.slice(0, 3).map(String) : []
          };
          rememberUsedTargets(topicPref, [p1Secret.name, p2Secret.name]);
          return {
            topic: {
              name: String(parsed.topicName).trim(),
              description: String(parsed.topicDescription).trim()
            },
            p1Secret,
            p2Secret,
            source: 'AI_GAMEMASTER'
          };
        }
      }
    } catch (err) {
      console.error('GameMaster thu lan', attempt + 1, 'bi loi:', err.message);
    }
  }

  const deckKeys = Object.keys(FALLBACK_DECKS);
  let chosenDeck = FALLBACK_DECKS[topicPref];
  if (!chosenDeck) {
    const randomKey = topicPref === 'hot_drama'
      ? (Math.random() < 0.7 ? 'vn_showbiz' : 'global_star')
      : deckKeys[Math.floor(Math.random() * deckKeys.length)];
    chosenDeck = FALLBACK_DECKS[randomKey];
  }

  let freshItems = chosenDeck.items.filter(it => !blockedNormSet.has(normalizeVN(it.name)));
  if (freshItems.length < 2) freshItems = [...chosenDeck.items];
  const shuffled = [...freshItems].sort(() => Math.random() - 0.5);
  rememberUsedTargets(topicPref, [shuffled[0].name, shuffled[1].name]);

  return {
    topic: { name: chosenDeck.topicName, description: chosenDeck.topicDescription },
    p1Secret: shuffled[0],
    p2Secret: shuffled[1],
    source: 'FALLBACK'
  };
}

async function judgeGuessWithGameMaster(guesserName, guessText, targetSecret, topicName) {
  const gNorm = normalizeVN(guessText);
  if (!gNorm) {
    return { correct: false, announcement: `⚖️ Quản trò công bố: ${guesserName} chưa nhập đáp án!` };
  }

  const sys = `Bạn là Trọng Tài / Quản Trò công tâm của game đoán nhân vật "Là ải là ai".
Nhiệm vụ: Chấm xem đáp án mà người chơi đoán có ĐÚNG LÀ CÙNG MỘT NHÂN VẬT/ĐỐI TƯỢNG với Đáp Án Bí Mật hay không, rồi viết 1 câu công bố ngắn gọn, sinh động bằng tiếng Việt.

QUY TẮC CHẤM RẤT QUAN TRỌNG:
1. CHẤP NHẬN LÀ ĐÚNG (correct: true) nếu người chơi gõ:
   - Tên thật, nghệ danh, biệt danh cực phổ biến hoặc tên rút gọn rõ ràng chỉ đích danh nhân vật đó (Ví dụ đáp án là "Sơn Tùng M-TP" thì "Son tung MTP", "Son tung", "Nguyễn Thanh Tùng", "M-TP" ĐỀU ĐÚNG; đáp án "Jack - J97" thì "Jack", "J97", "Trịnh Trần Phương Tuấn" ĐỀU ĐÚNG; đáp án "Mercedes-Benz" thì "Mercedes", "Mẹc" ĐỀU ĐÚNG).
   - Thiếu dấu tiếng Việt hoặc sai chính tả nhẹ (1-2 ký tự) nhưng đọc lên biết chắc chắn là đối tượng đó.
2. CHẤM LÀ SAI (correct: false) nếu:
   - Là nhân vật/hãng khác, hoặc nói quá chung chung (ví dụ chỉ nói "ca sĩ nam", "xe Đức").
3. Khi chấm SAI, TUYỆT ĐỐI KHÔNG làm lộ tên Đáp Án Bí Mật trong câu công bố!
4. Khi chấm ĐÚNG, hãy công bố vang dội tên đầy đủ của Đáp Án Bí Mật.

CHỈ TRẢ VỀ JSON HỢP LỆ:
{"correct": true hoặc false, "announcement": "Câu công bố của Quản trò (dưới 25 từ)"}`;

  const usr = `Chủ đề: "${topicName}"
Đáp án bí mật: "${targetSecret.name}" (Tên khác/biệt danh: ${(targetSecret.aliases || []).join(', ') || 'Không có'})
Người chơi "${guesserName}" chốt đáp án: "${guessText}"`;

  try {
    const raw = await callGeminiText(API_GAMEMASTER_KEY, sys, usr, 0.15);
    const parsed = extractJSON(raw);
    if (parsed && typeof parsed.correct === 'boolean') {
      const ann = String(parsed.announcement || '').trim();
      return {
        correct: parsed.correct,
        announcement: ann || (parsed.correct
          ? `🎉 Chính xác! "${guessText}" chính là "${targetSecret.name}"!`
          : `❌ Rất tiếc, "${guessText}" chưa phải đáp án bí mật!`)
      };
    }
  } catch (e) {
    console.error('Loi Quan tro cham dap an:', e.message);
  }

  const allValidNames = [targetSecret.name, ...(targetSecret.aliases || [])].map(normalizeVN).filter(Boolean);
  for (const valid of allValidNames) {
    if (gNorm === valid || (gNorm.length >= 4 && valid.includes(gNorm)) || (valid.length >= 4 && gNorm.includes(valid))) {
      return {
        correct: true,
        announcement: `🎉 Quản trò công bố: Chính xác! "${guessText}" trùng khớp với "${targetSecret.name}"!`
      };
    }
  }
  return {
    correct: false,
    announcement: `❌ Quản trò công bố: Rất tiếc, "${guessText}" chưa phải đáp án bí mật!`
  };
}

// ================= HÀM ĐỐI THỦ AI THÁM TỬ (DÙNG API MỚI) =================
async function aiOpponentAnswer(aiSecret, topic, questionText, difficulty = 'easy') {
  const noteRule = difficulty === 'hard'
    ? `Viết 1 câu phản hồi cực ngắn (tối đa 8 từ), kín tiếng, TUYỆT ĐỐI KHÔNG cho thêm bất kỳ manh mối hay gợi ý phụ nào về "${aiSecret.name}".`
    : `Viết kèm 1 câu bình luận ngắn (tối đa 12 từ), thân thiện, KHÔNG tiết lộ tên "${aiSecret.name}".`;

  const sys = `Bạn là đối thủ AI giữ thẻ bí mật trong game hỏi đáp Yes/No "Là ải là ai".
Đáp án bí mật BẠN ĐANG GIỮ: "${aiSecret.name}" (Tên gọi khác: ${(aiSecret.aliases || []).join(', ')})
Chủ đề: ${topic.name} (${topic.description})
Dữ kiện tham khảo: ${(aiSecret.facts || []).join('; ')}.

Nhiệm vụ: Trả lời TRUNG THỰC, CHÍNH XÁC câu hỏi của người chơi về "${aiSecret.name}".
Chỉ được chọn ĐÚNG 1 trong 5 nhãn sau:
- "YES": Chắc chắn đúng.
- "NO": Chắc chắn sai.
- "MAYBE": Có thể / Đúng một phần / Tùy góc nhìn.
- "PROBABLY_NO": Hình như không / Thiên về sai nhưng không dám khẳng định 100%.
- "DONT_KNOW": Không biết / Thông tin quá riêng tư hoặc không rõ.

${noteRule}
CHỈ TRẢ VỀ JSON HỢP LỆ: {"answer": "YES"|"NO"|"MAYBE"|"PROBABLY_NO"|"DONT_KNOW", "note": "..."}`;

  const usr = `Đối thủ hỏi bạn: "${questionText}"`;

  try {
    const raw = await callGeminiText(API_OPPONENT_KEY, sys, usr, 0.25);
    const parsed = extractJSON(raw);
    if (parsed && VALID_ANSWERS.includes(parsed.answer)) {
      return {
        answer: parsed.answer,
        note: String(parsed.note || '').slice(0, 110)
      };
    }
  } catch (err) {
    console.error('Loi AI Opponent tra loi:', err.message);
  }

  return { answer: 'MAYBE', note: 'Câu này hơi khó nói chắc nhé!' };
}

async function aiOpponentThinkAndAct(topic, aiHistory, aiSecretName, targetSecretForGuard) {
  const askedLines = aiHistory.map((item, idx) => {
    if (item.isGuess) {
      return `${idx + 1}. [ĐOÁN THỬ TÊN] "${item.question}" => KẾT QUẢ TỪ QUẢN TRÒ: SAI (Tuyệt đối KHÔNG đoán lại tên này!)`;
    }
    const ansLabel = ANSWER_LABELS_VI[item.answer] || item.answer;
    return `${idx + 1}. [HỎI THÔNG TIN] "${item.question}" => ĐỐI THỦ TRẢ LỜI: ${ansLabel}${item.answerNote ? ` (${item.answerNote})` : ''}`;
  }).join('\n');

  const totalQuestions = aiHistory.filter(i => !i.isGuess).length;
  const wrongGuesses = aiHistory.filter(i => i.isGuess).map(i => i.question);

  let questionsSinceLastGuess = 0;
  for (let i = aiHistory.length - 1; i >= 0; i--) {
    if (aiHistory[i].isGuess) break;
    questionsSinceLastGuess++;
  }

  const hasGuessedBefore = wrongGuesses.length > 0;
  const allowGuess = hasGuessedBefore
    ? (questionsSinceLastGuess >= 3)
    : (totalQuestions >= 4);

  const actionRule = allowGuess
    ? `QUY TẮC CHỐT ĐÁP ÁN:
- Nếu bạn đã nghĩ ra đích danh 1 cái tên cụ thể và tự tin >= 85% (KHÁC các tên đã đoán sai: ${wrongGuesses.join(', ') || 'chưa có'}), BẮT BUỘC dùng "action": "guess" và CHỈ điền đúng tên đối tượng đó vào "text" để Quản trò chấm thắng LUÔN trong lượt này!
- TUYỆT ĐỐI CẤM dùng "action": "ask" để hỏi kiểu "Có phải là [Tên nhân vật/hãng] không?" vì làm thế cực kỳ vô lý và mất thêm 1 lượt!
- Nếu vẫn còn nhiều ứng viên chưa chắc chắn, chọn "action": "ask" để hỏi về ĐẶC ĐIỂM / THUỘC TÍNH phân loại thêm.`
    : `LỆNH CẤM ĐOÁN Ở LƯỢT NÀY:
- Bạn BẮT BUỘC phải chọn "action": "ask" để hỏi về ĐẶC ĐIỂM / THUỘC TÍNH chung (${hasGuessedBefore ? `mới hỏi thêm ${questionsSinceLastGuess}/3 câu sau lần đoán sai` : `mới hỏi ${totalQuestions}/4 câu khởi đầu`}).
- TUYỆT ĐỐI CẤM chọn "guess" VÀ TUYỆT ĐỐI CẤM hỏi đích danh tên bất kỳ nhân vật/hãng cụ thể nào (cấm hỏi "Có phải là [Tên] không?").`;

  const sys = `Bạn là "AI Thám Tử" — cao thủ suy luận logic trong game hỏi đáp Yes/No "Là ải là ai".
Chủ đề trận đấu: "${topic.name}"
Mô tả chủ đề: "${topic.description}"
(Lưu ý: Thẻ bí mật của riêng bạn là "${aiSecretName}", nên đáp án của đối thủ CHẮC CHẮN KHÁC "${aiSecretName}".)

${actionRule}

CHIẾN THUẬT HỎI THÔNG TIN THÔNG MINH:
1. Khi chọn "action": "ask", CHỈ hỏi đặc điểm phân loại (Quốc tịch, giới tính, lĩnh vực, thế hệ, tác phẩm/bản hit/nhóm, đặc điểm nhận diện, phân khúc, logo, màu sắc...). KHÔNG BAO GIỜ nhắc tên đích danh ứng viên trong câu hỏi Yes/No!
2. Đọc kỹ lịch sử câu trả lời để hỏi thông tin MỚI HOÀN TOÀN, không lặp ý cũ.
3. Khi chọn "action": "guess", "text" CHỈ chứa ĐÚNG TÊN nhân vật/đối tượng (Ví dụ: "Sơn Tùng M-TP", "Toyota", "Trần Hưng Đạo"), không viết thành câu hỏi.

CHỈ TRẢ VỀ JSON HỢP LỆ:
{
  "action": "${allowGuess ? 'ask" hoặc "guess' : 'ask'}",
  "text": "1 câu hỏi thuộc tính Yes/No sắc bén HOẶC đúng Tên đối tượng chốt đoán",
  "taunt": "1 câu bình luận suy luận cực ngắn (dưới 12 từ)"
}`;

  const usr = askedLines
    ? `Lịch sử điều tra của bạn cho tới lúc này:\n${askedLines}\n\nHãy suy luận và đưa ra nước đi tiếp theo khôn ngoan nhất!`
    : `Đây là lượt hỏi ĐẦU TIÊN trong chủ đề "${topic.name}". Hãy đặt 1 câu hỏi Yes/No phân loại rộng thật thông minh!`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const extraNote = attempt === 1
        ? '\nNHẮC LẠI NGHIÊM NGẶT: BẮT BUỘC trả về "action": "ask" với một câu hỏi về ĐẶC ĐIỂM / THUỘC TÍNH chung, TUYỆT ĐỐI KHÔNG nhắc tên nhân vật/hãng cụ thể nào!'
        : '';
      const raw = await callGeminiText(API_OPPONENT_KEY, sys, usr + extraNote, 0.5);
      const parsed = extractJSON(raw);

      if (parsed && parsed.text) {
        let act = parsed.action === 'guess' ? 'guess' : 'ask';
        let txt = String(parsed.text).trim().slice(0, 180);
        const taunt = String(parsed.taunt || 'Đang khoanh vùng dần rồi...').slice(0, 100);

        // BỘ BẢO VỆ: Nếu AI lại lỡ dùng action="ask" để hỏi "Có phải là [Tên] không?"
        if (act === 'ask') {
          const check = detectDirectNameQuestion(txt, targetSecretForGuard);
          if (check.isDirectName && check.extractedName) {
            const alreadyGuessedWrong = wrongGuesses.some(w => normalizeVN(w) === normalizeVN(check.extractedName));
            if (allowGuess && !alreadyGuessedWrong) {
              // Tự động chuyển thẳng thành CHỐT ĐÁP ÁN luôn, không lãng phí thêm 1 lượt!
              return {
                action: 'guess',
                text: check.extractedName,
                taunt: taunt || 'Chốt thẳng đáp án luôn!'
              };
            } else {
              // Chưa đủ số câu hỏi hoặc tên đó đã đoán sai -> bắt AI hỏi lại thuộc tính khác
              continue;
            }
          }
        }

        // Chặn đoán quá sớm hoặc đoán lại tên đã sai
        const repeatedWrongGuess = act === 'guess' && wrongGuesses.some(w => normalizeVN(w) === normalizeVN(txt));
        if ((!allowGuess && act === 'guess') || repeatedWrongGuess) {
          continue;
        }

        return { action: act, text: txt, taunt };
      }
    } catch (err) {
      console.error('Loi AI Opponent dat cau hoi:', err.message);
    }
  }

  const fallbackPool = [
    'Đối tượng bí mật của bạn có xuất xứ từ Việt Nam không?',
    'Đối tượng này có phải là con người thật đang còn sống không?',
    'Đối tượng này có nổi bật mạnh mẽ trên mạng xã hội trong 3 năm gần đây không?',
    'Đối tượng này có liên quan trực tiếp đến lĩnh vực âm nhạc hoặc giải trí không?',
    'Đối tượng này có từng tạo ra một sản phẩm hoặc sự kiện cực kỳ nổi tiếng ai cũng biết không?',
    'Tên gọi phổ biến nhất của đối tượng này có nhiều hơn 2 từ phải không?',
    'Đối tượng này có liên quan đến khu vực Châu Á không?',
    'Đối tượng này thường được gắn với hình ảnh sang trọng hoặc đẳng cấp phải không?'
  ];
  const askedNorms = aiHistory.map(h => normalizeVN(h.question));
  const freshFallback = fallbackPool.find(q => !askedNorms.includes(normalizeVN(q))) || fallbackPool[totalQuestions % fallbackPool.length];

  return {
    action: 'ask',
    text: freshFallback,
    taunt: 'Hỏi thêm dữ kiện cho chắc ăn đã!'
  };
}

// ================= QUẢN LÝ NGƯỜI ONLINE (KHÔNG CẦN ACC, KHÔNG LƯU FILE) =================
const onlineUsers = {}; // socketId -> { id, name, nameKey, avatar, roomId }
const rooms = {};       // roomId -> Room
const lobbyChat = [];   // Chat chung online
let roomCounter = 100;

function getLobbyState() {
  const roomList = Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    mode: r.mode,
    difficulty: r.difficulty,
    topicPref: r.topicPref,
    status: r.status,
    topicName: r.topic?.name || '',
    p1: r.players.p1 ? { name: r.players.p1.name, avatar: r.players.p1.avatar, isAI: false } : null,
    p2: r.players.p2 ? { name: r.players.p2.name, avatar: r.players.p2.avatar, isAI: Boolean(r.players.p2.isAI) } : null,
    spectatorCount: Object.keys(r.spectators).length,
    qaCount: r.qaHistory.length
  })).reverse();

  const usersList = Object.values(onlineUsers).map(u => ({
    id: u.id,
    name: u.name,
    avatar: u.avatar,
    inRoom: Boolean(u.roomId)
  }));

  return {
    rooms: roomList,
    onlineUsers: usersList
  };
}

function broadcastLobby() {
  io.emit('lobby_update', getLobbyState());
}

function serializeRoomForSocket(room, socketId) {
  let role = 'spectator';
  if (room.players.p1 && room.players.p1.id === socketId) role = 'p1';
  else if (room.players.p2 && room.players.p2.id === socketId) role = 'p2';

  const revealAll = room.status === 'finished' || role === 'spectator';

  const maskPlayer = (pl, side) => {
    if (!pl) return null;
    const canSeeSecret = revealAll || role === side;
    return {
      id: pl.id,
      name: pl.name,
      avatar: pl.avatar,
      isAI: Boolean(pl.isAI),
      guessAttempts: pl.guessAttempts || 0,
      secret: canSeeSecret ? pl.secret : null
    };
  };

  const maxHints = room.mode === 'pvai' && room.difficulty === 'easy'
    ? Math.min(3, (room.players.p2?.secret?.facts || []).length)
    : 0;

  return {
    id: room.id,
    name: room.name,
    mode: room.mode,
    difficulty: room.difficulty,
    topicPref: room.topicPref,
    status: room.status,
    hostId: room.hostId,
    role,
    topic: room.topic,
    players: {
      p1: maskPlayer(room.players.p1, 'p1'),
      p2: maskPlayer(room.players.p2, 'p2')
    },
    spectators: Object.values(room.spectators),
    turnSide: room.turnSide,
    turnPhase: room.turnPhase,
    pendingQuestion: room.pendingQuestion,
    qaHistory: room.qaHistory,
    spectatorChat: (role === 'spectator' || room.status !== 'playing') ? room.spectatorChat : [],
    winnerSide: room.winnerSide,
    winReason: room.winReason,
    aiThinking: Boolean(room.aiThinking),
    judgingGuess: Boolean(room.judgingGuess),
    hintsRevealed: room.hintsRevealed || 0,
    maxHints
  };
}

function broadcastRoom(room) {
  if (!room) return;
  const recipientIds = new Set();
  if (room.players.p1 && !room.players.p1.isAI) recipientIds.add(room.players.p1.id);
  if (room.players.p2 && !room.players.p2.isAI) recipientIds.add(room.players.p2.id);
  Object.keys(room.spectators).forEach(sid => recipientIds.add(sid));

  for (const sid of recipientIds) {
    io.to(sid).emit('room_update', serializeRoomForSocket(room, sid));
  }
}

function recordMatchResult(room, winnerSide, reason) {
  if (room.status === 'finished') return;
  room.status = 'finished';
  room.winnerSide = winnerSide;
  room.winReason = reason;
  room.pendingQuestion = null;
  room.aiThinking = false;
  room.judgingGuess = false;

  broadcastRoom(room);
  broadcastLobby();
}

async function startMatchInRoom(room) {
  if (!room || !room.players.p1 || !room.players.p2) return;
  room.status = 'generating';
  room.winnerSide = null;
  room.winReason = '';
  room.qaHistory = [];
  room.pendingQuestion = null;
  room.aiThinking = false;
  room.judgingGuess = false;
  room.hintsRevealed = 0;
  room.players.p1.guessAttempts = 0;
  room.players.p2.guessAttempts = 0;
  room.players.p1.secret = null;
  room.players.p2.secret = null;

  broadcastRoom(room);
  broadcastLobby();

  const round = await generateRoundWithGameMaster(room.topicPref, room.usedTargets);
  if (!rooms[room.id]) return;

  room.topic = round.topic;
  room.players.p1.secret = round.p1Secret;
  room.players.p2.secret = round.p2Secret;
  room.usedTargets.push(round.p1Secret.name, round.p2Secret.name);
  if (room.usedTargets.length > 40) room.usedTargets = room.usedTargets.slice(-40);

  room.status = 'playing';
  room.turnSide = 'p1';
  room.turnPhase = 'asking';

  broadcastRoom(room);
  broadcastLobby();
}

async function triggerAITurn(room) {
  if (!room || room.status !== 'playing' || room.mode !== 'pvai') return;
  if (room.turnSide !== 'p2' || room.turnPhase !== 'asking') return;

  room.aiThinking = true;
  broadcastRoom(room);

  await new Promise(r => setTimeout(r, 900));
  if (!rooms[room.id] || room.status !== 'playing' || room.turnSide !== 'p2') return;

  const aiHistory = room.qaHistory.filter(item => !item.isHint && item.bySide === 'p2');
  const decision = await aiOpponentThinkAndAct(
    room.topic,
    aiHistory,
    room.players.p2.secret?.name || '',
    room.players.p1.secret
  );

  if (!rooms[room.id] || room.status !== 'playing' || room.turnSide !== 'p2') return;
  room.aiThinking = false;

  if (decision.action === 'guess') {
    room.judgingGuess = true;
    broadcastRoom(room);

    room.players.p2.guessAttempts = (room.players.p2.guessAttempts || 0) + 1;
    const verdict = await judgeGuessWithGameMaster(
      room.players.p2.name,
      decision.text,
      room.players.p1.secret,
      room.topic.name
    );

    if (!rooms[room.id] || room.status !== 'playing') return;
    room.judgingGuess = false;

    room.qaHistory.push({
      id: Date.now(),
      bySide: 'p2',
      byName: room.players.p2.name,
      question: decision.text,
      taunt: decision.taunt,
      isGuess: true,
      guessCorrect: verdict.correct,
      judgeAnnouncement: verdict.announcement,
      time: Date.now()
    });

    if (verdict.correct) {
      recordMatchResult(room, 'p2', verdict.announcement);
      return;
    } else {
      room.turnSide = 'p1';
      room.turnPhase = 'asking';
      broadcastRoom(room);
      return;
    }
  } else {
    room.pendingQuestion = {
      id: Date.now(),
      bySide: 'p2',
      byName: room.players.p2.name,
      text: decision.text,
      taunt: decision.taunt,
      time: Date.now()
    };
    room.turnPhase = 'answering';
    broadcastRoom(room);
  }
}

function removeUserFromRoom(socketId, reasonMsg = '') {
  const user = onlineUsers[socketId];
  if (!user || !user.roomId) return;
  const room = rooms[user.roomId];
  user.roomId = null;
  if (!room) return;

  if (room.spectators[socketId]) {
    delete room.spectators[socketId];
    broadcastRoom(room);
    broadcastLobby();
    return;
  }

  let leavingSide = null;
  if (room.players.p1 && room.players.p1.id === socketId) leavingSide = 'p1';
  else if (room.players.p2 && room.players.p2.id === socketId) leavingSide = 'p2';

  if (!leavingSide) return;

  if (room.mode === 'pvai') {
    Object.keys(room.spectators).forEach(sid => {
      if (onlineUsers[sid]) onlineUsers[sid].roomId = null;
      io.to(sid).emit('kicked_to_lobby', `Phòng "${room.name}" đã đóng do chủ phòng rời trận.`);
    });
    delete rooms[room.id];
    broadcastLobby();
    return;
  }

  if (room.status === 'playing') {
    const otherSide = leavingSide === 'p1' ? 'p2' : 'p1';
    const leaverName = room.players[leavingSide]?.name || 'Người chơi';
    recordMatchResult(room, otherSide, `🏳️ ${leaverName} đã rời trận giữa chừng (${reasonMsg || 'Bỏ cuộc'})!`);
  }

  room.players[leavingSide] = null;

  if (!room.players.p1 && room.players.p2 && !room.players.p2.isAI) {
    room.players.p1 = room.players.p2;
    room.players.p2 = null;
    room.hostId = room.players.p1.id;
    room.status = 'waiting';
  } else if (room.players.p1 && !room.players.p2) {
    if (room.status !== 'finished') room.status = 'waiting';
  }

  if (!room.players.p1 && !room.players.p2) {
    Object.keys(room.spectators).forEach(sid => {
      if (onlineUsers[sid]) onlineUsers[sid].roomId = null;
      io.to(sid).emit('kicked_to_lobby', `Phòng "${room.name}" đã giải tán.`);
    });
    delete rooms[room.id];
  } else {
    broadcastRoom(room);
  }
  broadcastLobby();
}

// ================= SOCKET.IO HANDLERS =================
io.on('connection', (socket) => {
  socket.emit('lobby_update', getLobbyState());
  socket.emit('lobby_chat_update', lobbyChat);

  // 1. NHẬP TÊN LÀ VÀO SẢNH LUÔN (KHÔNG CẦN TẠO ACC / MẬT KHẨU)
  socket.on('enter_lobby', ({ name, avatar }, cb) => {
    const cleanName = (name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!cleanName || cleanName.length < 2) {
      return cb({ ok: false, msg: 'Tên hiển thị phải có ít nhất 2 ký tự!' });
    }

    const nameKey = cleanName.toLowerCase();
    const isTakenOnline = Object.values(onlineUsers).some(u => u.id !== socket.id && u.nameKey === nameKey);
    if (isTakenOnline) {
      return cb({ ok: false, msg: 'Tên này đang có người dùng online rồi! Hãy thêm số hoặc chọn tên khác nhé.' });
    }

    onlineUsers[socket.id] = {
      id: socket.id,
      name: cleanName,
      nameKey,
      avatar: avatar || '🕵️',
      roomId: null
    };

    broadcastLobby();
    return cb({
      ok: true,
      user: {
        id: socket.id,
        name: cleanName,
        avatar: onlineUsers[socket.id].avatar
      },
      lobby: getLobbyState(),
      lobbyChat
    });
  });

  // 2. CHAT SẢNH CHUNG
  socket.on('lobby_chat', ({ text }) => {
    const user = onlineUsers[socket.id];
    if (!user) return;
    const clean = (text || '').trim().slice(0, 200);
    if (!clean) return;

    lobbyChat.push({
      id: Date.now() + Math.random(),
      name: user.name,
      avatar: user.avatar,
      text: clean,
      time: Date.now()
    });
    if (lobbyChat.length > 60) lobbyChat.shift();
    io.emit('lobby_chat_update', lobbyChat);
  });

  // 3. TẠO PHÒNG (PvP hoặc 1 vs AI có Dễ / Khó)
  socket.on('create_room', async ({ mode, difficulty, topicPref, roomName }, cb) => {
    const user = onlineUsers[socket.id];
    if (!user) return cb({ ok: false, msg: 'Bạn chưa nhập tên vào sảnh!' });

    if (user.roomId) removeUserFromRoom(socket.id);

    roomCounter += 1;
    const roomId = `ROOM_${roomCounter}`;
    const validMode = mode === 'pvai' ? 'pvai' : 'pvp';
    const validDiff = difficulty === 'hard' ? 'hard' : 'easy';
    const validPref = TOPIC_CONFIGS[topicPref] ? topicPref : 'hot_drama';
    const title = (roomName || '').trim().slice(0, 32) || (
      validMode === 'pvai'
        ? `🤖 ${user.name} vs AI (${validDiff === 'hard' ? 'Khó' : 'Dễ'})`
        : `⚔️ Sàn đấu của ${user.name}`
    );

    const newRoom = {
      id: roomId,
      name: title,
      mode: validMode,
      difficulty: validDiff,
      topicPref: validPref,
      status: 'waiting',
      hostId: socket.id,
      players: {
        p1: {
          id: socket.id,
          name: user.name,
          avatar: user.avatar,
          isAI: false,
          guessAttempts: 0,
          secret: null
        },
        p2: validMode === 'pvai' ? {
          id: 'AI_OPPONENT',
          name: 'AI Thám Tử',
          avatar: '🤖',
          isAI: true,
          guessAttempts: 0,
          secret: null
        } : null
      },
      spectators: {},
      topic: { name: '', description: '' },
      turnSide: 'p1',
      turnPhase: 'asking',
      pendingQuestion: null,
      qaHistory: [],
      spectatorChat: [],
      winnerSide: null,
      winReason: '',
      usedTargets: [],
      aiThinking: false,
      judgingGuess: false,
      hintsRevealed: 0
    };

    rooms[roomId] = newRoom;
    user.roomId = roomId;

    cb({ ok: true, room: serializeRoomForSocket(newRoom, socket.id) });
    broadcastLobby();

    if (validMode === 'pvai') {
      await startMatchInRoom(newRoom);
    }
  });

  // 4. THAM GIA PHÒNG
  socket.on('join_room', ({ roomId, asSpectator }, cb) => {
    const user = onlineUsers[socket.id];
    if (!user) return cb({ ok: false, msg: 'Bạn chưa nhập tên vào sảnh!' });

    const room = rooms[roomId];
    if (!room) return cb({ ok: false, msg: 'Phòng không còn tồn tại!' });

    if (user.roomId) removeUserFromRoom(socket.id);

    const canJoinAsPlayer = !asSpectator && room.mode === 'pvp' && !room.players.p2 && room.status === 'waiting';
    if (canJoinAsPlayer) {
      room.players.p2 = {
        id: socket.id,
        name: user.name,
        avatar: user.avatar,
        isAI: false,
        guessAttempts: 0,
        secret: null
      };
    } else {
      room.spectators[socket.id] = {
        id: socket.id,
        name: user.name,
        avatar: user.avatar
      };
    }

    user.roomId = room.id;
    cb({ ok: true, room: serializeRoomForSocket(room, socket.id) });
    broadcastRoom(room);
    broadcastLobby();
  });

  // 5. ĐỔI CHỦ ĐỀ / ĐỘ KHÓ & BẮT ĐẦU TRẬN
  socket.on('update_topic_pref', ({ topicPref }) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return;
    const room = rooms[user.roomId];
    if (!room || room.hostId !== socket.id) return;
    if (TOPIC_CONFIGS[topicPref]) {
      room.topicPref = topicPref;
      broadcastRoom(room);
      broadcastLobby();
    }
  });

  socket.on('update_difficulty', ({ difficulty }) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return;
    const room = rooms[user.roomId];
    if (!room || room.hostId !== socket.id || room.mode !== 'pvai') return;
    if (room.status === 'waiting' || room.status === 'finished') {
      room.difficulty = difficulty === 'hard' ? 'hard' : 'easy';
      broadcastRoom(room);
      broadcastLobby();
    }
  });

  socket.on('start_match', async (_, cb) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return cb && cb({ ok: false, msg: 'Bạn không ở trong phòng nào!' });
    const room = rooms[user.roomId];
    if (!room) return cb && cb({ ok: false, msg: 'Phòng không tồn tại!' });

    if (room.hostId !== socket.id) {
      return cb && cb({ ok: false, msg: 'Chỉ chủ phòng mới bấm bắt đầu được!' });
    }
    if (!room.players.p1 || !room.players.p2) {
      return cb && cb({ ok: false, msg: 'Cần đủ 2 người chơi mới có thể bắt đầu!' });
    }
    if (room.status === 'generating' || room.status === 'playing') {
      return cb && cb({ ok: false, msg: 'Trận đấu đang diễn ra rồi!' });
    }

    if (cb) cb({ ok: true });
    await startMatchInRoom(room);
  });

  // 6. XIN GỢI Ý (CHỈ DÙNG ĐƯỢC Ở CHẾ ĐỘ 1vAI - DỄ)
  socket.on('request_hint', (_, cb) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return cb && cb({ ok: false, msg: 'Không ở trong phòng!' });
    const room = rooms[user.roomId];
    if (!room || room.status !== 'playing') return cb && cb({ ok: false, msg: 'Trận đấu chưa bắt đầu!' });
    if (room.mode !== 'pvai' || room.difficulty !== 'easy') {
      return cb && cb({ ok: false, msg: 'Chế độ Khó đã tắt gợi ý!' });
    }
    if (room.players.p1?.id !== socket.id) {
      return cb && cb({ ok: false, msg: 'Chỉ đấu thủ mới được mở gợi ý!' });
    }

    const facts = room.players.p2?.secret?.facts || [];
    const maxH = Math.min(3, facts.length);
    if (room.hintsRevealed >= maxH) {
      return cb && cb({ ok: false, msg: 'Bạn đã mở hết toàn bộ gợi ý cho ván này rồi!' });
    }

    const hintText = facts[room.hintsRevealed];
    room.hintsRevealed += 1;
    room.qaHistory.push({
      id: Date.now(),
      isHint: true,
      hintIndex: room.hintsRevealed,
      text: hintText,
      time: Date.now()
    });

    if (cb) cb({ ok: true });
    broadcastRoom(room);
  });

  // 7. ĐẶT CÂU HỎI YES/NO
  socket.on('ask_question', async ({ text }, cb) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return cb && cb({ ok: false, msg: 'Không ở trong phòng!' });
    const room = rooms[user.roomId];
    if (!room || room.status !== 'playing') return cb && cb({ ok: false, msg: 'Trận đấu chưa bắt đầu!' });
    if (room.judgingGuess || room.aiThinking) return cb && cb({ ok: false, msg: 'Vui lòng chờ một giây...' });

    const side = room.players.p1?.id === socket.id ? 'p1' : room.players.p2?.id === socket.id ? 'p2' : null;
    if (!side || room.turnSide !== side || room.turnPhase !== 'asking') {
      return cb && cb({ ok: false, msg: 'Chưa tới lượt hỏi của bạn!' });
    }

    const qText = (text || '').trim().slice(0, 200);
    if (qText.length < 2) return cb && cb({ ok: false, msg: 'Hãy nhập câu hỏi rõ ràng hơn nhé!' });

    room.pendingQuestion = {
      id: Date.now(),
      bySide: side,
      byName: room.players[side].name,
      text: qText,
      time: Date.now()
    };
    room.turnPhase = 'answering';
    if (cb) cb({ ok: true });
    broadcastRoom(room);

    if (room.mode === 'pvai' && side === 'p1') {
      room.aiThinking = true;
      broadcastRoom(room);

      const aiRes = await aiOpponentAnswer(room.players.p2.secret, room.topic, qText, room.difficulty);
      if (!rooms[room.id] || room.status !== 'playing') return;

      room.aiThinking = false;
      room.qaHistory.push({
        id: room.pendingQuestion.id,
        bySide: 'p1',
        byName: room.players.p1.name,
        question: qText,
        answer: aiRes.answer,
        answerNote: aiRes.note,
        isGuess: false,
        time: Date.now()
      });
      room.pendingQuestion = null;
      room.turnSide = 'p2';
      room.turnPhase = 'asking';
      broadcastRoom(room);
      broadcastLobby();

      triggerAITurn(room);
    }
  });

  // 8. TRẢ LỜI 5 MỨC
  socket.on('answer_question', ({ answer, note }, cb) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return cb && cb({ ok: false, msg: 'Không ở trong phòng!' });
    const room = rooms[user.roomId];
    if (!room || room.status !== 'playing' || room.turnPhase !== 'answering' || !room.pendingQuestion) {
      return cb && cb({ ok: false, msg: 'Không có câu hỏi nào đang chờ trả lời!' });
    }

    const mySide = room.players.p1?.id === socket.id ? 'p1' : room.players.p2?.id === socket.id ? 'p2' : null;
    const expectedResponder = room.turnSide === 'p1' ? 'p2' : 'p1';
    if (!mySide || mySide !== expectedResponder) {
      return cb && cb({ ok: false, msg: 'Không phải lượt bạn trả lời!' });
    }

    const validAns = VALID_ANSWERS.includes(answer) ? answer : 'MAYBE';
    room.qaHistory.push({
      id: room.pendingQuestion.id,
      bySide: room.pendingQuestion.bySide,
      byName: room.pendingQuestion.byName,
      question: room.pendingQuestion.text,
      taunt: room.pendingQuestion.taunt || '',
      answer: validAns,
      answerNote: (note || '').trim().slice(0, 100),
      isGuess: false,
      time: Date.now()
    });

    room.pendingQuestion = null;
    room.turnSide = mySide;
    room.turnPhase = 'asking';

    if (cb) cb({ ok: true });
    broadcastRoom(room);
    broadcastLobby();
  });

  // 9. CHỐT ĐOÁN ĐÁP ÁN (VÔ SỐ LẦN — QUẢN TRÒ AI CHẤM & CÔNG BỐ)
  socket.on('submit_guess', async ({ guessText }, cb) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return cb && cb({ ok: false, msg: 'Không ở trong phòng!' });
    const room = rooms[user.roomId];
    if (!room || room.status !== 'playing') return cb && cb({ ok: false, msg: 'Trận đấu chưa bắt đầu!' });
    if (room.judgingGuess || room.aiThinking) return cb && cb({ ok: false, msg: 'Quản trò đang chấm đáp án...' });

    const side = room.players.p1?.id === socket.id ? 'p1' : room.players.p2?.id === socket.id ? 'p2' : null;
    if (!side || room.turnSide !== side || room.turnPhase !== 'asking') {
      return cb && cb({ ok: false, msg: 'Chỉ được chốt đáp án khi tới lượt của bạn!' });
    }

    const cleanGuess = (guessText || '').trim().slice(0, 100);
    if (!cleanGuess) return cb && cb({ ok: false, msg: 'Hãy nhập tên đáp án bạn muốn đoán!' });

    const targetSide = side === 'p1' ? 'p2' : 'p1';
    const targetSecret = room.players[targetSide].secret;

    room.judgingGuess = true;
    if (cb) cb({ ok: true });
    broadcastRoom(room);

    room.players[side].guessAttempts = (room.players[side].guessAttempts || 0) + 1;
    const verdict = await judgeGuessWithGameMaster(
      room.players[side].name,
      cleanGuess,
      targetSecret,
      room.topic.name
    );

    if (!rooms[room.id] || room.status !== 'playing') return;
    room.judgingGuess = false;

    room.qaHistory.push({
      id: Date.now(),
      bySide: side,
      byName: room.players[side].name,
      question: cleanGuess,
      isGuess: true,
      guessCorrect: verdict.correct,
      judgeAnnouncement: verdict.announcement,
      time: Date.now()
    });

    if (verdict.correct) {
      recordMatchResult(room, side, verdict.announcement);
      return;
    }

    room.turnSide = targetSide;
    room.turnPhase = 'asking';
    broadcastRoom(room);
    broadcastLobby();

    if (room.mode === 'pvai' && room.turnSide === 'p2') {
      triggerAITurn(room);
    }
  });

  // 10. CHAT KHÁN ĐÀI TRONG PHÒNG
  socket.on('spectator_chat', ({ text }) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return;
    const room = rooms[user.roomId];
    if (!room) return;

    const clean = (text || '').trim().slice(0, 160);
    if (!clean) return;

    const isPlayer = room.players.p1?.id === socket.id || room.players.p2?.id === socket.id;
    if (isPlayer && room.status === 'playing') return;

    room.spectatorChat.push({
      id: Date.now(),
      name: user.name,
      avatar: user.avatar,
      text: clean,
      time: Date.now()
    });
    if (room.spectatorChat.length > 60) room.spectatorChat.shift();
    broadcastRoom(room);
  });

  // 11. RỜI PHÒNG / NGẮT KẾT NỐI
  socket.on('leave_room', () => {
    removeUserFromRoom(socket.id, 'Chủ động rời phòng');
  });

  socket.on('disconnect', () => {
    removeUserFromRoom(socket.id, 'Mất kết nối');
    delete onlineUsers[socket.id];
    broadcastLobby();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🕵️‍♂️ Game "LÀ ẢI LÀ AI" (v4) đang chạy tại: http://localhost:${PORT}`);
});

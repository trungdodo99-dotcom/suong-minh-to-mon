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
  anime: {
    guide: 'BẮT BUỘC: Nhân vật trong Anime / Manga Nhật Bản nổi tiếng (KHÔNG chọn siêu anh hùng Mỹ hay nhân vật game). Ưu tiên các bộ nổi tiếng tại Việt Nam.',
    subAngles: [
      'Nhân vật trong các bộ Shonen kinh điển (One Piece, Naruto, Dragon Ball, Bleach, Hunter x Hunter)',
      'Nhân vật trong Anime hành động hiện đại siêu hot (Jujutsu Kaisen, Kimetsu no Yaiba, Attack on Titan, One Punch Man, Chainsaw Man, Black Clover, Sakamoto Days, Baki)',
      'Nhân vật trong Anime Isekai / Fantasy nổi tiếng (Tensei Shitara Slime Datta Ken, Mushoku Tensei, Re:Zero, Overlord, Sword Art Online, Seven Deadly Sins)',
      'Nhân vật trong truyện tranh tuổi thơ quen thuộc tại Việt Nam (Doraemon, Thám Tử Lừng Danh Conan, Cậu Bé Bút Chì, Pokemon, Yu-Gi-Oh!)',
      'Các nhân vật phản diện, thầy giáo hoặc nhân vật phụ cực kỳ nổi tiếng trong Anime/Manga'
    ]
  },
  vn_food: {
    guide: 'BẮT BUỘC: Các món ăn truyền thống, đặc sản vùng miền, món ăn đường phố hoặc món ăn vặt nổi tiếng của Việt Nam.',
    subAngles: [
      'Các món nước, bún, phở, mì trứ danh 3 miền Việt Nam (Phở, Bún bò Huế, Bún chả, Bún riêu, Hủ tiếu, Mì Quảng, Cao lầu, Bánh canh...)',
      'Các món cơm, xôi, bánh mặn truyền thống (Cơm tấm, Bánh mì, Bánh chưng, Bánh xèo, Bánh cuốn, Xôi xéo, Cơm gà...)',
      'Các món ăn vặt đường phố giới trẻ Việt Nam cực mê (Bánh tráng trộn, Bánh tráng nướng, Nem chua rán, Chân gà sả tắc, Trứng vịt lộn, Chè, Tào phớ...)',
      'Các món đặc sản vùng miền, món nhậu hoặc món cỗ ngày Tết (Thịt kho tàu, Chả cá Lã Vọng, Gỏi cuốn, Bò lá lốt, Nem nướng Nha Trang, Gà nướng cơm lam...)'
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
  anime: {
    topicName: 'Nhân Vật Anime & Manga Nhật Bản',
    topicDescription: 'Quy tụ các nhân vật chính, nhân vật phụ và phản diện nổi tiếng nhất trong các bộ Anime/Manga quen thuộc tại Việt Nam.',
    items: [
      { name: 'Monkey D. Luffy', aliases: ['Luffy', 'Mu Rom'], facts: ['Thuyền trưởng một băng hải tặc mơ ước tìm ra kho báu vĩ đại nhất', 'Cơ thể co giãn như cao su sau khi ăn một loại trái đặc biệt', 'Luôn đội chiếc mũ rơm và có vết sẹo nhỏ dưới mắt trái'] },
      { name: 'Roronoa Zoro', aliases: ['Zoro'], facts: ['Kiếm sĩ tóc xanh lá cực kỳ trung thành trong một băng hải tặc nổi tiếng', 'Sử dụng phong cách chiến đấu 3 thanh kiếm, một thanh ngậm ở miệng', 'Nổi tiếng với căn bệnh mù đường kinh niên dù đi đường thẳng'] },
      { name: 'Vinsmoke Sanji', aliases: ['Sanji'], facts: ['Đầu bếp tóc vàng lịch lãm với cặp lông mày xoăn đặc trưng', 'Chỉ dùng đôi chân bốc lửa để chiến đấu vì muốn giữ đôi tay nấu ăn', 'Nguyên tắc sống tuyệt đối không bao giờ đánh phụ nữ'] },
      { name: 'Tony Tony Chopper', aliases: ['Chopper'], facts: ['Bác sĩ nhỏ nhắn dễ thương của một băng hải tặc nổi tiếng', 'Là một chú tuần lộc mũi xanh biết nói tiếng người nhờ trái ác quỷ', 'Rất thích ăn kẹo bông và hay bị nhầm là con gấu trúc hoặc chồn'] },
      { name: 'Shanks Tóc Đỏ', aliases: ['Shanks', 'Toc Do'], facts: ['Một trong Tứ Hoàng đầy quyền lực trên biển cả dù không ăn trái ác quỷ', 'Bị mất cánh tay trái khi cứu một cậu bé khỏi quái vật biển', 'Có 3 vết sẹo dài trên mắt trái và là người tặng chiếc mũ rơm huyền thoại'] },
      { name: 'Son Goku', aliases: ['Goku', 'Kakarot'], facts: ['Chiến binh ngoài hành tinh lớn lên trên Trái Đất, cực mê đấu với kẻ mạnh', 'Sở hữu chiêu chưởng năng lượng màu xanh dương và khả năng biến tóc vàng', 'Ăn khỏe vô đối và đã nhiều lần cứu vũ trụ khỏi diệt vong'] },
      { name: 'Vegeta', aliases: ['Ca Dic', 'Cadic'], facts: ['Hoàng tử đầy kiêu hãnh của một chủng tộc chiến binh ngoài hành tinh', 'Ban đầu là kẻ thù nhưng về sau trở thành đồng đội và kình địch của nhân vật chính', 'Có mái tóc dựng ngược trán chữ M và kết hôn với một nữ thiên tài giàu có'] },
      { name: 'Piccolo', aliases: ['Pocolo', 'Picolo'], facts: ['Chiến binh da xanh lá đến từ hành tinh khác, có đôi tai nhọn và hai râu trên trán', 'Khởi đầu là đại ma vương nhưng sau lại trở thành người thầy tận tụy dạy con của đối thủ', 'Thường mặc áo choàng trắng nặng trịch và đội khăn xếp trên đầu'] },
      { name: 'Frieza', aliases: ['Fide', 'Dai de Fide'], facts: ['Bạo chúa vũ trụ tàn ác đứng sau vụ hủy diệt cả một hành tinh chiến binh', 'Sở hữu nhiều hình dạng biến đổi, nổi bật nhất là dạng cuối toàn thân trắng tím và dạng vàng kim', 'Giọng điệu lúc nào cũng lịch sự giả tạo nhưng cực kỳ độc ác'] },
      { name: 'Naruto Uzumaki', aliases: ['Naruto'], facts: ['Cậu bé mồ côi bị dân làng xa lánh vì mang trong mình phong ấn quái thú 9 đuôi', 'Ước mơ lớn nhất là trở thành người đứng đầu ngôi làng ninja', 'Mặc bộ đồ màu cam đen nổi bật và cực kỳ nghiện ăn mì Ramen'] },
      { name: 'Sasuke Uchiha', aliases: ['Sasuke'], facts: ['Thiên tài lạnh lùng sống sót sau vụ thảm sát cả gia tộc ninja danh giá', 'Sở hữu đôi mắt đỏ đặc biệt có khả năng sao chép nhẫn thuật và tạo lửa đen', 'Từng bỏ làng đi tìm sức mạnh trả thù anh trai trước khi trở về bảo vệ làng trong bóng tối'] },
      { name: 'Kakashi Hatake', aliases: ['Kakashi', 'Thay Kakashi'], facts: ['Người thầy ninja tóc bạc luôn đeo khẩu trang che kín nửa dưới khuôn mặt', 'Thường xuyên đi muộn và hay đọc tiểu thuyết người lớn ngay trước mặt học trò', 'Nổi danh với biệt danh Ninja Sao Chép nhờ một bên mắt đỏ che dưới băng trán'] },
      { name: 'Itachi Uchiha', aliases: ['Itachi'], facts: ['Thiên tài ninja từng gia nhập tổ chức phản diện mặc áo choàng mây đỏ', 'Chấp nhận mang tiếng phản bội cả gia tộc để giữ hòa bình cho ngôi làng và bảo vệ em trai', 'Bậc thầy ảo thuật gắn liền với hình ảnh đàn quạ đen'] },
      { name: 'Madara Uchiha', aliases: ['Madara'], facts: ['Huyền thoại ninja thời cổ đại từng cùng bạn thân sáng lập nên làng Lá', 'Một mình áp đảo cả liên minh hàng vạn nhẫn giả khi được hồi sinh trong đại chiến', 'Nổi tiếng với câu nói thể hiện sự bá đạo khi thả liên tiếp hai thiên thạch từ trên trời'] },
      { name: 'Gojo Satoru', aliases: ['Gojo', 'Thay Gojo'], facts: ['Người thầy mạnh nhất giới chú thuật sư, tính cách tự tin và hay trêu chọc học trò', 'Có mái tóc trắng, đôi mắt xanh lấp lánh và thường đeo bịt mắt đen', 'Sở hữu kỹ năng tạo khoảng cách vô hạn khiến mọi đòn đánh không thể chạm tới'] },
      { name: 'Ryomen Sukuna', aliases: ['Sukuna', 'Vua Nguyen Hon'], facts: ['Thực thể cổ đại tàn bạo được mệnh danh là Vua của các Lời Nguyền', 'Sức mạnh bị chia nhỏ và phong ấn trong 20 ngón tay khô bị nguyền rủa', 'Nổi tiếng với các nhát chém vô hình tàn phá cả một khu phố chỉ trong chớp mắt'] },
      { name: 'Yuji Itadori', aliases: ['Itadori', 'Yuji'], facts: ['Nam sinh cấp 3 tóc hồng có thể chất siêu phàm, rất giàu lòng trắc ẩn', 'Nuốt phải một ngón tay bị nguyền rủa để cứu bạn nên trở thành vật chứa của quỷ vương', 'Sử dụng võ thuật cận chiến kết hợp đòn đánh tia chớp đen cực mạnh'] },
      { name: 'Megumi Fushiguro', aliases: ['Megumi', 'Fushiguro'], facts: ['Học sinh chú thuật tóc đen dựng đứng, tính cách trầm tĩnh và nghiêm túc', 'Sử dụng thuật thức điều khiển bóng tối để triệu hồi các thức thần như chó sói, chim ưng', 'Thường xuyên sẵn sàng tung lá bài tẩy triệu hồi sinh vật mạnh nhất dù phải liều mạng'] },
      { name: 'Tanjiro Kamado', aliases: ['Tanjiro'], facts: ['Cậu bé kiếm sĩ nhân hậu gia nhập đội diệt quỷ sau bi kịch của cả gia đình', 'Luôn cõng chiếc hộp gỗ chứa em gái trên lưng khi đi làm nhiệm vụ', 'Có khứu giác siêu nhạy và mặc áo haori kẻ caro xanh lá - đen'] },
      { name: 'Nezuko Kamado', aliases: ['Nezuko'], facts: ['Cô bé bị biến thành quỷ nhưng vẫn giữ được nhân tính và bảo vệ con người', 'Luôn ngậm một ống tre màu xanh trên miệng và hồi sức bằng cách ngủ thay vì ăn thịt', 'Có thể thu nhỏ cơ thể chui vào hộp gỗ hoặc hóa lớn chiến đấu bằng lửa hồng'] },
      { name: 'Zenitsu Agatsuma', aliases: ['Zenitsu'], facts: ['Kiếm sĩ tóc vàng cực kỳ nhát gan, hễ gặp quỷ là khóc lóc đòi bỏ chạy', 'Chỉ bộc lộ sức mạnh thật sự khi rơi vào trạng thái ngất xỉu hoặc ngủ say', 'Chỉ dùng thành thạo đúng một thức duy nhất của hơi thở sấm sét nhưng đạt đến cảnh giới tối thượng'] },
      { name: 'Kyojuro Rengoku', aliases: ['Rengoku', 'Viem Tru'], facts: ['Kiếm sĩ cấp cao tóc vàng rực pha đỏ, tính cách nhiệt huyết và luôn cười sảng khoái', 'Rất thích ăn cơm hộp bento trên tàu hỏa và liên tục khen ngon', 'Hy sinh anh dũng trên chuyến tàu vô tận để bảo vệ toàn bộ hành khách'] },
      { name: 'Muzan Kibutsuji', aliases: ['Muzan', 'Chua Quy'], facts: ['Thủy tổ của toàn bộ loài quỷ, sống hàng nghìn năm và cực kỳ sợ ánh nắng mặt trời', 'Thường thay đổi ngoại hình thành quý ông mặc vest, phụ nữ hoặc trẻ em để ẩn náu', 'Rất giống một ông hoàng nhạc Pop nổi tiếng ngoài đời ở tạo hình mặc vest đội mũ trắng'] },
      { name: 'Doraemon', aliases: ['Do re mon', 'Meo May'], facts: ['Nhân vật đến từ tương lai thế kỷ 22 để giúp đỡ một cậu học sinh hậu đậu', 'Có chiếc túi thần kỳ trước bụng chứa vô số món bảo bối vi diệu', 'Cực kỳ mê bánh rán nhân đậu đỏ nhưng lại sợ chuột chết khiếp'] },
      { name: 'Nobita Nobi', aliases: ['Nobita'], facts: ['Cậu học sinh tiểu học đeo kính tròn, hậu đậu và thường xuyên nhận điểm 0', 'Sở hữu hai tài năng cực đỉnh là bắn súng bách phát bách trúng và ngủ trong 3 giây', 'Hễ bị bạn bè bắt nạt là chạy về nhà khóc lóc cầu cứu người bạn màu xanh'] },
      { name: 'Jaian', aliases: ['Chaien', 'Takeshi Goda'], facts: ['Cậu bé to con nóng tính, hay bắt nạt bạn bè cùng khu phố nhưng rất sợ mẹ', 'Đam mê ca hát mãnh liệt nhưng giọng hát có sức công phá như vũ khí hủy diệt', 'Trong các chuyến phiêu lưu dài tập lại cực kỳ nghĩa khí và sẵn sàng xả thân vì bạn'] },
      { name: 'Conan Edogawa', aliases: ['Conan', 'Shinichi Kudo'], facts: ['Thám tử trung học thiên tài bị teo nhỏ thành học sinh tiểu học do uống thuốc độc', 'Đeo cặp kính định vị, đồng hồ bắn kim gây mê và dùng nơ đổi giọng để phá án', 'Nổi tiếng với lời nguyền đi du lịch đến đâu là chỗ đó xảy ra án mạng'] },
      { name: 'Kaito Kid', aliases: ['Kid', 'Kaito Kuroba'], facts: ['Siêu trộm lịch lãm mặc bộ vest trắng, áo choàng bay và đội mũ chóp cao', 'Luôn gửi thư báo trước cho cảnh sát trước khi đến đánh cắp những viên đá quý đắt giá', 'Bậc thầy ảo thuật, cải trang và có gương mặt giống hệt nhân vật chính của bộ truyện'] },
      { name: 'Ran Mori', aliases: ['Ran'], facts: ['Nữ sinh trung học dịu dàng, chung thủy chờ đợi cậu bạn thanh mai trúc mã trở về', 'Cao thủ võ thuật Karate có cú đá mạnh đến mức đập vỡ cả cột bê tông', 'Gây ấn tượng mạnh với lọn tóc nhọn dựng đứng đặc trưng trên đỉnh đầu'] },
      { name: 'Shinnosuke Nohara', aliases: ['Shin', 'Cau be but chi', 'Shin chan'], facts: ['Cậu bé 5 tuổi tinh nghịch sống tại Nhật Bản với cặp lông mày rậm đặc trưng', 'Cực kỳ thích chọc ghẹo các chị gái xinh đẹp, mê siêu nhân và ghét cay ghét đắng ớt chuông', 'Hay có điệu nhảy khoe mông khiến bố mẹ phải đau đầu suốt ngày'] },
      { name: 'Pikachu', aliases: ['Pika'], facts: ['Linh vật màu vàng có hai chấm đỏ trên má và chiếc đuôi hình tia sét', 'Luôn từ chối chui vào quả cầu thu phục mà thích ngồi trên vai người bạn đồng hành', 'Chiêu thức nổi tiếng nhất là phóng dòng điện hàng trăm nghìn vôn'] },
      { name: 'Saitama', aliases: ['One Punch Man', 'Ao choang hoi'], facts: ['Siêu anh hùng làm việc cho vui, tập luyện gập bụng chạy bộ đến mức rụng sạch tóc', 'Hạ gục hầu hết mọi quái vật cấp thảm họa chỉ bằng đúng một cú đấm', 'Mặc đồ vàng áo choàng trắng và cực kỳ quan tâm các đợt giảm giá siêu thị'] },
      { name: 'Genos', aliases: ['Quy Nguoi May'], facts: ['Cậu thanh niên nửa người nửa máy cực kỳ nghiêm túc, luôn mang sổ tay ghi chép lời thầy', 'Tôn sùng một anh hùng đầu trọc làm sư phụ sau khi chứng kiến sức mạnh vô đối của anh', 'Thường xuyên bị quái vật đánh tan xác thành đống sắt vụn rồi lại được tiến sĩ nâng cấp'] },
      { name: 'Garou', aliases: ['Tho San Anh Hung'], facts: ['Võ sĩ thiên tài từng là học trò xuất sắc nhất của võ đường nhưng lại đứng về phía quái vật', 'Tự xưng là Thợ Săn Anh Hùng, càng bị đánh thương nặng càng tiến hóa mạnh hơn', 'Sở hữu mái tóc dựng nhọn hai bên và kỹ thuật võ thuật phản đòn cực kỳ điêu luyện'] },
      { name: 'Eren Yeager', aliases: ['Eren'], facts: ['Cậu bé lớn lên trong những bức tường cao khổng lồ với khao khát tự do cháy bỏng', 'Có khả năng hóa thân thành người khổng lồ sau khi tự cắn vào tay mình', 'Từ một chàng trai nhiệt huyết bảo vệ nhân loại đã biến thành nhân vật phản diện gây chấn động ở cuối phim'] },
      { name: 'Levi Ackerman', aliases: ['Levi', 'Binh truong Levi'], facts: ['Người lính mạnh nhất nhân loại trong cuộc chiến chống lại các sinh vật khổng lồ', 'Dáng người thấp bé, gương mặt luôn lạnh tanh và cực kỳ ám ảnh sạch sẽ', 'Thuộc Trinh Sát Đoàn và nổi tiếng với kỹ thuật xoay chém tốc độ chóng mặt'] },
      { name: 'Mikasa Ackerman', aliases: ['Mikasa'], facts: ['Nữ chiến binh sở hữu sức mạnh thể chất vượt xa người thường trong quân đội diệt người khổng lồ', 'Luôn quấn chặt chiếc khăn choàng màu đỏ quanh cổ vì đó là kỷ vật quan trọng nhất', 'Sẵn sàng đối đầu với cả thế giới để bảo vệ cậu bạn nuôi lớn cùng mình'] },
      { name: 'Ichigo Kurosaki', aliases: ['Ichigo'], facts: ['Nam sinh cấp 3 tóc cam có khả năng nhìn thấy linh hồn từ khi còn nhỏ', 'Vô tình nhận lấy sức mạnh Tử Thần để bảo vệ gia đình khỏi các ác linh mang mặt nạ trắng', 'Cầm thanh đao đen khổng lồ với tuyệt chiêu phóng sóng năng lượng màu đen đỏ'] },
      { name: 'Sosuke Aizen', aliases: ['Aizen'], facts: ['Một trong những phản diện mưu mô bậc nhất anime, ban đầu đóng vai đội trưởng đeo kính hiền lành', 'Vuốt ngược mái tóc và bẻ gãy kính khi lộ bản chất thật khiến người xem ngỡ ngàng', 'Sở hữu thanh kiếm có khả năng thôi miên hoàn toàn ngũ quan của đối thủ'] },
      { name: 'Gon Freecss', aliases: ['Gon'], facts: ['Cậu bé tóc đen dựng đứng mặc đồ xanh lá lên đường thi tuyển làm Thợ Săn để tìm bố', 'Tính cách ngây thơ, kiên cường và sử dụng chiếc cần câu làm vũ khí lúc đầu hành trình', 'Sở hữu đòn đánh dựa trên trò chơi Oẳn Tù Tì với cú đấm tích tụ năng lượng cực mạnh'] },
      { name: 'Killua Zoldyck', aliases: ['Killua'], facts: ['Cậu bé tóc trắng xuất thân từ gia tộc sát thủ khét tiếng nhất thế giới', 'Cực kỳ thích ăn sô-cô-la, đi ván trượt và có thể chịu đựng mọi loại độc dược lẫn điện giật', 'Chuyển hóa năng lượng của mình thành điện để di chuyển với tốc độ thần tốc'] },
      { name: 'Hisoka Morow', aliases: ['Hisoka'], facts: ['Gã ảo thuật gia lập dị ăn mặc như chú hề với hình giọt nước và ngôi sao vẽ trên mặt', 'Dùng những lá bài sắc như dao và năng lượng dẻo dính như kẹo cao su để chiến đấu', 'Chỉ có hứng thú săn đuổi những đối thủ có tiềm năng phát triển cực mạnh'] },
      { name: 'Rimuru Tempest', aliases: ['Rimuru', 'Slime'], facts: ['Nhân viên văn phòng chuyển sinh sang dị giới trong hình dạng một sinh vật mềm màu xanh', 'Sở hữu kỹ năng nuốt chửng để học chiêu thức và xây dựng cả một quốc gia ma vật hùng mạnh', 'Thường hóa thành dáng người tóc xanh nhạt và kết nghĩa bạn thân với một con rồng bão tố'] },
      { name: 'Diablo', aliases: ['Noir'], facts: ['Ác ma nguyên thủy cực kỳ mạnh mẽ nhưng lại tình nguyện làm quản gia cho một vị chúa tể', 'Mặc bộ vest đen lịch lãm, tóc đen có lọn đỏ vàng và tuyệt đối cuồng tín chủ nhân của mình', 'Rất thích giảng đạo về sự vĩ đại của chủ nhân cho bất kỳ ai dám tỏ thái độ bất kính'] },
      { name: 'Rudeus Greyrat', aliases: ['Rudeus', 'Rudy'], facts: ['Chàng trai chuyển sinh sang thế giới kiếm và phép thuật với ký ức của kiếp trước', 'Bộc lộ thiên tài ma pháp từ khi còn bé xíu, có thể thi triển phép không cần đọc chú', 'Được dạy dỗ bởi nữ pháp sư tóc xanh và về sau có cuộc sống gia đình với ba người vợ'] },
      { name: 'Natsuki Subaru', aliases: ['Subaru'], facts: ['Chàng trai bình thường bị dịch chuyển sang dị giới khi vừa bước ra khỏi cửa hàng tiện lợi', 'Không có siêu sức mạnh chiến đấu mà chỉ sở hữu lời nguyền quay ngược thời gian mỗi khi chết', 'Luôn mặc bộ đồ thể thao quen thuộc và trải qua vô số lần đau đớn để cứu bạn bè'] },
      { name: 'Rem', aliases: ['Rem ReZero'], facts: ['Cô hầu gái tộc quỷ tóc xanh ngắn che một bên mắt làm việc tại một dinh thự quý tộc', 'Chiến đấu cực kỳ dữ dội bằng quả cầu gai xích sắt nhưng lại vô cùng dịu dàng với người mình yêu', 'Từng có câu tỏ tình kinh điển nhưng lại bị nam chính đáp lại bằng một câu nói gây tranh cãi nhất lịch sử anime'] },
      { name: 'Denji', aliases: ['Nguoi Cua', 'Chainsaw Man'], facts: ['Chàng trai nghèo khổ sống cùng chú chó quỷ nhỏ màu cam để trả nợ cho xã hội đen', 'Chỉ cần giật sợi dây trước ngực là đầu và hai tay biến thành những lưỡi cưa máy đẫm máu', 'Ước mơ ban đầu vô cùng giản dị chỉ là được ăn bánh mì phết mứt và có bạn gái'] },
      { name: 'Makima', aliases: ['Makima'], facts: ['Nữ lãnh đạo tóc đỏ cam xinh đẹp, điềm tĩnh nhưng mang khí chất cực kỳ đáng sợ trong cục săn quỷ', 'Sở hữu đôi mắt vàng có nhiều vòng tròn đồng tâm và thao túng người khác bằng lời nói dịu dàng', 'Thực chất là con quỷ đại diện cho nỗi sợ bị kiểm soát và chi phối'] },
      { name: 'Anya Forger', aliases: ['Anya'], facts: ['Cô bé tóc hồng nhỏ nhắn được một điệp viên và một nữ sát thủ nhận làm con nuôi', 'Sở hữu năng lực đọc suy nghĩ của người khác nhưng lại cực kỳ dốt học ở trường', 'Rất mê ăn đậu phộng, thích xem phim hoạt hình điệp viên và có biểu cảm cười nhếch mép thành meme'] },
      { name: 'Light Yagami', aliases: ['Kira', 'Yagami Light'], facts: ['Nam sinh trung học thiên tài có điểm số đứng đầu toàn quốc nhưng cảm thấy thế giới quá nhàm chán', 'Nhặt được một cuốn sổ đen từ trên trời rơi xuống có thể lấy mạng bất kỳ ai bị ghi tên vào', 'Tự xưng là vị thần của thế giới mới và đấu trí căng thẳng với thám tử bí ẩn nhất thế giới'] },
      { name: 'L Lawliet', aliases: ['L', 'Tham tu L'], facts: ['Thám tử bí ẩn số một thế giới với đôi mắt thâm quầng, tóc đen rối bù và luôn đi chân đất', 'Có thói quen ngồi xổm trên ghế, cầm tách trà bằng hai đầu ngón tay và ăn đồ ngọt liên tục', 'Cả thế giới chỉ biết đến anh qua một chữ cái duy nhất hiện trên màn hình máy tính'] },
      { name: 'Asta', aliases: ['Asta'], facts: ['Cậu bé mồ côi sinh ra hoàn toàn không có chút ma lực nào trong thế giới ai cũng dùng phép thuật', 'Bù lại bằng cơ bắp luyện tập điên cuồng và cuốn sách phép thuật 5 lá chứa thanh kiếm chém tan ma pháp', 'Cực kỳ hay la hét ầm ĩ và ước mơ trở thành Ma Pháp Vương'] },
      { name: 'Meliodas', aliases: ['Meliodas', 'Doi truong'], facts: ['Chủ quán rượu nhỏ dáng người như thiếu niên tóc vàng nhưng thực chất đã sống hơn 3000 năm', 'Đội trưởng của nhóm hiệp sĩ huyền thoại mang tên bảy đại tội, đại diện cho Phẫn Nộ', 'Sở hữu chiêu thức phản đòn toàn bộ đòn tấn công phép thuật mạnh gấp đôi lại phía kẻ địch'] },
      { name: 'Yujiro Hanma', aliases: ['Yujiro', 'Sinh vat manh nhat hanh tinh'], facts: ['Người đàn ông được mệnh danh là Sinh vật mạnh nhất hành tinh với cơ lưng nổi hình mặt quỷ', 'Mạnh đến mức các siêu cường quân sự trên thế giới phải ký hiệp ước hòa bình với riêng ông ta', 'Bậc thầy mọi môn võ thuật và từng tay không đấm dừng cả một trận động đất'] }
    ]
  },
  vn_food: {
    topicName: 'Các Món Ăn Nổi Tiếng Việt Nam',
    topicDescription: 'Đủ mọi món nước, món khô, cơm xôi, đặc sản 3 miền và món ăn vặt đường phố quen thuộc của ẩm thực Việt Nam.',
    items: [
      { name: 'Phở bò', aliases: ['Pho', 'Pho bo'], facts: ['Món nước quốc hồn quốc túy của Việt Nam, thường ăn nóng vào buổi sáng', 'Nước dùng ninh từ xương cùng gia vị thơm như hồi, quế, thảo quả và gừng nướng', 'Sợi bánh màu trắng dẹt, ăn kèm hành lá, chanh, ớt và quẩy nóng'] },
      { name: 'Phở gà', aliases: ['Pho ga'], facts: ['Phiên bản nước dùng trong và thanh ngọt hơn so với món nước nổi tiếng nhất Việt Nam', 'Thịt có lớp da vàng óng giòn sần sật, thường ăn kèm lá chanh thái chỉ thơm lừng', 'Rất hay được gọi thêm trứng non hoặc tràng kê béo bùi'] },
      { name: 'Phở cuốn', aliases: ['Pho cuon'], facts: ['Đặc sản nổi tiếng quanh khu vực hồ Trúc Bạch ở Hà Nội', 'Dùng lá bánh trắng mềm nguyên bản chưa thái sợi để cuộn thịt bò xào và rau thơm', 'Chấm vào bát nước mắm chua ngọt có đu đủ xanh thái mỏng'] },
      { name: 'Bún chả', aliases: ['Bun cha', 'Bun cha Ha Noi'], facts: ['Đặc sản trứ danh của Hà Nội, từng được cựu Tổng thống Mỹ Obama ngồi ăn ở quán bình dân', 'Thịt nướng trên than hoa thơm lừng thả vào bát nước chấm ấm chua ngọt có dưa góp', 'Ăn kèm bún lá, rau sống tươi và rất hợp khi gọi thêm nem cua bể'] },
      { name: 'Bún bò Huế', aliases: ['Bun bo Hue', 'Bun bo'], facts: ['Món nước đậm đà cay nồng xuất xứ từ vùng đất Cố đô miền Trung', 'Nước dùng nổi bật với mùi sả đập dập và mắm ruốc, dùng loại sợi to tròn', 'Thường có thịt chân giò, tiết luộc, chả cua và ăn kèm hoa chuối thái sợi'] },
      { name: 'Bún đậu mắm tôm', aliases: ['Bun dau mam tom', 'Bun dau'], facts: ['Món ăn dân dã miền Bắc bày đầy đặn trên một chiếc mẹt tre lót lá chuối', 'Gồm bún lá cắt miếng, đậu rán vàng giòn, chả cốm, thịt chân giò luộc và nem rán', 'Linh hồn nằm ở bát nước chấm màu tím đánh sủi bọt với quất, đường và ớt tươi'] },
      { name: 'Bún riêu cua', aliases: ['Bun rieu', 'Bun rieu cua'], facts: ['Món nước dân dã có vị chua thanh tự nhiên nhờ giấm bỗng và cà chua chưng', 'Phần nổi bật trên mặt bát là lớp gạch đồng màu vàng cam béo ngậy thơm lừng', 'Thường ăn kèm đậu rán, giò tai, thịt bò chần và rau sống thái nhỏ'] },
      { name: 'Bún thang', aliases: ['Bun thang'], facts: ['Món nước cầu kỳ bậc nhất của người Hà Nội xưa, từng cần tới hơn 20 nguyên liệu', 'Trên mặt bát xếp đẹp như bức tranh với trứng tráng thái chỉ, giò lụa, thịt gà xé và củ cải khô', 'Nước dùng cực trong, ngọt thanh và thường thêm chút mắm tôm cùng tinh dầu cà cuống'] },
      { name: 'Bún cá', aliases: ['Bun ca'], facts: ['Món nước thanh mát phổ biến từ Hải Phòng, Hà Nội đến các tỉnh ven biển', 'Nguyên liệu chính được lọc xương, tẩm bột chiên vàng giòn rụm hoặc hấp mềm', 'Nước dùng chua nhẹ nấu với cà chua, thì là, hành hoa và hay ăn kèm rau cần hoặc dọc mùng'] },
      { name: 'Bún mọc', aliases: ['Bun moc'], facts: ['Món nước nhẹ bụng rất được chuộng ăn sáng ở miền Bắc', 'Điểm nhấn là những viên giò sống trộn mộc nhĩ nấm hương vo tròn thả chín trong nồi nước dùng', 'Thường nấu cùng măng khô hoặc sườn non và ăn kèm dọc mùng giòn sần sật'] },
      { name: 'Bún thịt nướng', aliases: ['Bun thit nuong'], facts: ['Món trộn không chan nước dùng rất phổ biến ở miền Nam và miền Trung', 'Trong tô gồm sợi trắng tươi, thịt heo ướp sả nướng cháy cạnh, chả giò chiên và đồ chua', 'Rưới mỡ hành, rắc đậu phộng rang và chan nước mắm chua ngọt trộn đều lên ăn'] },
      { name: 'Bún mắm', aliases: ['Bun mam'], facts: ['Món nước mang hương vị cực kỳ nồng đậm đặc trưng của vùng sông nước miền Tây Nam Bộ', 'Nước lèo nấu từ các loại cá lên men đặc trưng vùng Tây Nam Bộ nên mùi rất mạnh', 'Topping đầy ắp tôm, mực, heo quay giòn bì, cà tím và ăn kèm bông súng, rau đắng'] },
      { name: 'Mì Quảng', aliases: ['Mi Quang'], facts: ['Đặc sản nức tiếng của xứ Quảng miền Trung, không chan đầy nước mà chỉ xăm xắp dưới đáy tô', 'Sợi mì bản to, dày, màu trắng hoặc vàng nghệ ăn kèm thịt gà, tôm, trứng cút', 'Bắt buộc phải có bánh tráng mè nướng bẻ vụn, đậu phộng rang và rau sống tươi'] },
      { name: 'Cao lầu', aliases: ['Cao lau', 'Cao lau Hoi An'], facts: ['Món đặc sản gắn liền với phố cổ Hội An, khó tìm thấy đúng vị ở nơi khác', 'Sợi mì màu vàng nâu dai giòn đặc biệt tương truyền phải ngâm nước tro củi và nước giếng cổ', 'Ăn kèm thịt xá xíu, da heo chiên giòn vuông nhỏ và chan rất ít nước sốt đậm đà'] },
      { name: 'Hủ tiếu Nam Vang', aliases: ['Hu tieu', 'Hu tieu Nam Vang'], facts: ['Món ăn sáng cực kỳ quen thuộc của người dân Sài Gòn và Nam Bộ, có thể ăn nước hoặc ăn khô', 'Sợi nhỏ hơi dai trong, nước dùng ninh từ xương heo và tôm khô có vị ngọt dịu', 'Đầy đặn với thịt băm, tôm luộc, gan tim heo, trứng cút và không thể thiếu hành phi, cần tây'] },
      { name: 'Bánh đa cua Hải Phòng', aliases: ['Banh da cua'], facts: ['Món ăn biểu tượng của thành phố hoa phượng đỏ', 'Dùng loại sợi bản dẹt có màu nâu sẫm đặc trưng ăn rất dai bùi', 'Nước dùng nấu từ cua đồng ăn kèm chả lá lốt, tôm, bề bề và rau muống chần'] },
      { name: 'Bánh canh cua', aliases: ['Banh canh', 'Banh canh cua'], facts: ['Món nước có phần nước dùng sánh sệt đặc trưng màu cam đỏ bắt mắt rất nổi tiếng ở Sài Gòn', 'Sợi to tròn, trắng trong và mềm trơn làm từ bột gạo pha bột năng', 'Thường có thịt cua xé, chả cua, trứng cút, huyết heo và chấm kèm muối ớt xanh'] },
      { name: 'Miến lươn', aliases: ['Mien luon'], facts: ['Món ăn bổ dưỡng nổi tiếng ở Hà Nội và xứ Nghệ, có thể ăn kiểu trộn khô hoặc chan nước', 'Sợi trong suốt làm từ củ dong riềng ăn dai mềm', 'Nguyên liệu chính là loài cá da trơn đồng quê được chiên giòn rụm hoặc xào mềm đậm đà'] },
      { name: 'Bánh mì', aliases: ['Banh mi', 'Banh mi Viet Nam'], facts: ['Món ăn đường phố Việt Nam nổi tiếng toàn cầu, được đưa thẳng vào từ điển Oxford', 'Vỏ nướng giòn rụm, bên trong kẹp pate, thịt nguội, chả lụa, đồ chua và rau mùi', 'Cực kỳ tiện lợi để cầm tay ăn sáng hoặc ăn lót dạ mọi lúc mọi nơi'] },
      { name: 'Cơm tấm', aliases: ['Com tam', 'Com tam suon bi cha'], facts: ['Món ăn bình dân biểu tượng của Sài Gòn nấu từ những hạt gạo bị vỡ nhỏ', 'Đĩa đầy đủ thường có miếng sườn nướng than, bì sợi thính, chả trứng hấp và trứng ốp la', 'Không thể thiếu mỡ hành bóng bẩy, đồ chua và chén nước mắm pha sánh ngọt'] },
      { name: 'Cơm rang dưa bò', aliases: ['Com rang dua bo', 'Com chien dua bo'], facts: ['Món ăn quốc dân trong các quán ăn đêm và quán cơm bình dân miền Bắc', 'Hạt gạo đảo săn vàng óng với trứng, ăn cùng thịt bò xào cải muối chua giòn', 'Thường kèm thêm bát nước dùng nóng có hành hoa và chút dưa góp cho đỡ ngấy'] },
      { name: 'Cơm gà Hội An', aliases: ['Com ga', 'Com ga Hoi An'], facts: ['Đặc sản nổi tiếng miền Trung với phần hạt có màu vàng ươm béo ngậy từ nước luộc và nghệ', 'Thịt gà ta xé phay bóp hành tây, rau răm và tiêu chanh thơm nức', 'Ăn kèm gỏi đu đủ cà rốt, tương ớt đặc trưng và chén súp lòng mề nóng'] },
      { name: 'Cơm hến', aliases: ['Com hen'], facts: ['Món ăn dân dã giá rẻ nhưng có tới hơn chục loại nguyên liệu trứ danh của xứ Huế', 'Dùng gạo nấu để nguội trộn cùng loài nhuyễn thể nước ngọt nhỏ xíu xào đậm vị', 'Nổi bật với vị cay xè của ớt chưng, tóp mỡ giòn, đậu phộng rang, mắm ruốc và bát nước luộc nóng'] },
      { name: 'Cơm lam', aliases: ['Com lam'], facts: ['Món ăn đặc trưng của đồng bào vùng núi Tây Bắc và Tây Nguyên', 'Gạo nếp ngâm rồi nhồi vào bên trong ống tre hoặc ống nứa tươi nướng chín trên bếp lửa', 'Khi ăn phải chẻ bỏ lớp vỏ cháy bên ngoài, chấm cùng muối vừng hoặc ăn với gà nướng'] },
      { name: 'Xôi xéo', aliases: ['Xoi xeo'], facts: ['Món ăn sáng bình dân quen thuộc của người Hà Nội, thường gói trong lá chuối hoặc lá sen', 'Gạo nếp đồ với nghệ tạo màu vàng tươi, bên trên thái lát mỏng một khối đậu xanh đồ mịn', 'Rưới đẫm mỡ gà bóng nhẫy và phủ ngập hành phi vàng giòn rụm'] },
      { name: 'Xôi gấc', aliases: ['Xoi gac'], facts: ['Món ăn có màu đỏ cam rực rỡ tượng trưng cho sự may mắn trong ngày Tết và đám cưới', 'Gạo nếp trộn với thịt một loại quả có gai vỏ đỏ trước khi đem đồ chín', 'Vị dẻo ngọt nhẹ, thường rắc thêm dừa nạo sợi hoặc ăn kèm giò lụa'] },
      { name: 'Cháo lòng', aliases: ['Chao long'], facts: ['Món ăn nóng hổi dân dã cực hợp ăn vào sáng sớm hoặc những ngày trời se lạnh', 'Nấu từ gạo rang và nước luộc nội tạng nên có màu hơi sẫm cùng vị béo ngọt đặc trưng', 'Ăn kèm dồi nướng hoặc luộc, gan, tim, tiết, quẩy giòn và thật nhiều hành lá, tiêu bắc'] },
      { name: 'Cháo sườn', aliases: ['Chao suon'], facts: ['Món ăn chiều ấm bụng cực kỳ được lòng học sinh, sinh viên và trẻ nhỏ ở Hà Nội', 'Không nấu từ hạt gạo nguyên mà xay mịn thành bột rồi quấy sánh mượt trong nước ninh xương', 'Thường rắc đầy ruốc bông, bẻ quẩy giòn vào trộn cùng và thêm chút bột ớt cay'] },
      { name: 'Bánh chưng', aliases: ['Banh chung'], facts: ['Món truyền thống hình vuông không thể thiếu trên mâm cỗ Tết cổ truyền miền Bắc', 'Gói bằng lá dong xanh bên ngoài, bên trong là gạo nếp, đỗ xanh và thịt ba chỉ ướp tiêu', 'Gắn liền với sự tích hoàng tử Lang Liêu thời vua Hùng'] },
      { name: 'Bánh tét', aliases: ['Banh tet'], facts: ['Món bánh truyền thống ngày Tết đặc trưng của miền Trung và miền Nam', 'Gói bằng lá chuối thành đòn hình trụ tròn dài, khi ăn dùng chính dây lạt cắt từng khoanh', 'Ngoài nhân đậu xanh thịt mỡ còn có phiên bản nhân chuối ngọt đỏ au rất lạ miệng'] },
      { name: 'Bánh xèo', aliases: ['Banh xeo'], facts: ['Tên gọi bắt nguồn từ âm thanh vui tai phát ra khi đổ bột vào chảo dầu nóng', 'Lớp vỏ màu vàng ươm giòn rụm nhờ bột nghệ, bên trong có nhân tôm, thịt và giá đỗ', 'Thường dùng rau cải xanh hoặc bánh tráng cuốn lại chấm nước mắm chua ngọt'] },
      { name: 'Bánh khọt', aliases: ['Banh khot'], facts: ['Đặc sản nức tiếng của vùng biển Vũng Tàu và miền Nam, hình dáng tròn nhỏ vừa một miếng ăn', 'Đổ bột gạo pha nước cốt dừa vào từng ô khuôn nhỏ bằng đất nung hoặc gang cho giòn đáy', 'Chính giữa đặt một con tôm tươi đỏ au, rắc mỡ hành và bột tôm cháy lên trên'] },
      { name: 'Bánh cuốn', aliases: ['Banh cuon', 'Banh uot'], facts: ['Món ăn sáng mềm mượt làm từ bột gạo tráng cực mỏng trên mặt vải căng nồi hơi nước', 'Bên trong thường cuộn nhân thịt băm mộc nhĩ, rắc hành phi vàng rụm lên trên', 'Ăn kèm chả quế hoặc chả lụa cùng bát nước mắm pha ấm'] },
      { name: 'Bánh bột lọc', aliases: ['Banh bot loc'], facts: ['Món bánh đặc sản xứ Huế nhỏ xinh có lớp vỏ dai dẻo trong suốt nhìn thấu nhân bên trong', 'Bên trong nổi bật với con tôm rim đỏ au và miếng thịt ba chỉ mặn ngọt', 'Có thể gói lá chuối hấp hoặc luộc trần, chấm cùng nước mắm ngọt thật cay'] },
      { name: 'Bánh bèo', aliases: ['Banh beo'], facts: ['Món ăn vặt dân dã rất nổi tiếng ở miền Trung, thường được đổ trong từng chiếc chén nhỏ xíu', 'Làm từ bột gạo hấp mềm trắng muốt, ăn hết một lúc có thể xếp chồng hàng chục cái chén', 'Phía trên rắc đầy tôm chấy màu cam, tóp mỡ giòn hoặc da heo chiên và chan nước mắm ngọt'] },
      { name: 'Bánh giò', aliases: ['Banh gio'], facts: ['Món ăn chiều nóng hổi bọc trong lá chuối xanh, tạo hình giống kim tự tháp úp ngược', 'Vỏ làm từ bột gạo tẻ nấu dẻo mịn mềm tan trong miệng, nhân thịt băm mộc nhĩ trứng cút', 'Ở Hà Nội hay ăn kèm giò lụa, chả cốm, nem chua và tương ớt cùng dưa góp'] },
      { name: 'Bánh gối', aliases: ['Banh goi', 'Banh xep'], facts: ['Món ăn vặt chiên giòn cực hot vào mùa đông ở Hà Nội, hình bán nguyệt có viền xếp ly đẹp mắt', 'Lớp vỏ bột mì rán phồng vàng rụm, bên trong đầy nhân thịt băm, miến, mộc nhĩ và lạp xưởng', 'Cắt miếng vừa ăn rồi chấm nước mắm chua ngọt có đu đủ cà rốt và rau sống'] },
      { name: 'Bánh bao', aliases: ['Banh bao'], facts: ['Món ăn sáng tiện lợi màu trắng tròn mềm xốp được làm chín bằng cách hấp hơi', 'Phiên bản phổ biến nhất tại Việt Nam có nhân thịt băm, miến, mộc nhĩ và trứng cút hoặc trứng muối', 'Hay được đặt giữ nóng trong tủ kính tại các tiệm ven đường hoặc cửa hàng tiện lợi'] },
      { name: 'Bánh trôi nước', aliases: ['Banh troi', 'Banh troi nuoc', 'Che troi nuoc'], facts: ['Món ăn truyền thống gắn liền với ngày Tết Hàn Thực mùng 3 tháng 3 âm lịch', 'Vỏ làm từ bột nếp nặn thành viên tròn trắng muốt, luộc nổi lên là chín', 'Bên trong bọc viên đường phên nâu hoặc nhân đậu xanh ngọt bùi, rắc vừng rang lên trên'] },
      { name: 'Bánh tráng trộn', aliases: ['Banh trang tron'], facts: ['Món ăn vặt đường phố quốc dân cực kỳ được học sinh, sinh viên trên cả nước yêu thích', 'Trộn các sợi bột gạo dẻo cùng khô bò, trứng cút, xoài xanh bào sợi, đậu phộng và rau răm', 'Nổi bật với vị chua cay mặn ngọt nhờ muối tôm Tây Ninh, sa tế và nước quất'] },
      { name: 'Bánh tráng nướng', aliases: ['Banh trang nuong', 'Pizza Viet Nam'], facts: ['Món ăn vặt nóng hổi giòn tan nổi tiếng bậc nhất tại chợ đêm Đà Lạt', 'Được du khách nước ngoài ví von là phiên bản Pizza của Việt Nam', 'Nướng trực tiếp trên than hồng với trứng cút, hành lá, thịt băm, khô bò và rưới tương ớt sốt béo'] },
      { name: 'Gỏi cuốn', aliases: ['Goi cuon', 'Nem cuon'], facts: ['Món ăn thanh mát không dùng dầu mỡ chiên rán, rất hay xuất hiện trong thực đơn giảm cân', 'Lớp vỏ mỏng trong suốt cuốn chặt tôm luộc, thịt ba chỉ, bún tươi, xà lách và lá hẹ', 'Thường chấm cùng tương đậu phộng béo ngậy hoặc nước mắm chua ngọt'] },
      { name: 'Nem rán', aliases: ['Nem ran', 'Cha gio'], facts: ['Món chiên vàng giòn rụm gần như không bao giờ vắng mặt trong mâm cỗ truyền thống Việt Nam', 'Gói bằng bánh đa nem cuộn nhân thịt băm, miến, mộc nhĩ, nấm hương, cà rốt và trứng gà', 'Miền Bắc và miền Nam gọi món này bằng hai cái tên hoàn toàn khác nhau'] },
      { name: 'Nem chua rán', aliases: ['Nem chua ran'], facts: ['Món ăn vặt vỉa hè huyền thoại gắn liền với các quán trà chanh tại Hà Nội', 'Làm từ thịt heo xay trộn bì thái sợi, tẩm bột chiên xù rồi chiên vàng giòn bên ngoài dẻo bên trong', 'Chấm tương ớt cay và hay ăn kèm củ đậu hoặc xoài xanh thái miếng cho đỡ ngấy'] },
      { name: 'Nem nướng Nha Trang', aliases: ['Nem nuong', 'Nem nuong Nha Trang'], facts: ['Đặc sản nổi tiếng miền biển Khánh Hòa nhưng nay phủ sóng khắp cả nước', 'Thịt xay quết dẻo nướng thơm trên than hoa ăn kèm bánh tráng chiên giòn, bún và rau sống', 'Điểm ăn tiền nhất là bát nước chấm màu vàng cam sánh đặc nóng hổi nấu từ gạo nếp và thịt băm'] },
      { name: 'Chả cá Lã Vọng', aliases: ['Cha ca La Vong', 'Cha ca Ha Noi'], facts: ['Món đặc sản lâu đời bậc nhất của Hà Nội đến mức có hẳn một con phố cổ mang tên món ăn này', 'Cá lăng tẩm ướp nghệ và mẻ nướng trước rồi mới mang ra bàn đảo nóng trên chảo mỡ xèo xèo', 'Bắt buộc phải đảo cùng thật nhiều thì là, hành hoa rồi ăn với bún, lạc rang và mắm tôm'] },
      { name: 'Bò lá lốt', aliases: ['Bo la lot', 'Bo cuon la lot'], facts: ['Món nướng vỉa hè tỏa khói thơm nức mũi cả một góc phố mỗi buổi chiều tối', 'Thịt băm tẩm ướp sả, ngũ vị hương rồi gói gọn trong từng chiếc lá xanh có mùi thơm nồng', 'Khi nướng chín tỏa mùi đặc trưng, thường ăn kèm bún, bánh hỏi, đồ chua và chấm mắm nêm'] },
      { name: 'Bò né', aliases: ['Bo ne'], facts: ['Món ăn sáng hoặc tối nóng hổi phục vụ ngay trên chiếc chảo gang hình con vật đang xèo xèo khói', 'Tên gọi vui tai xuất phát từ việc thực khách hay phải nghiêng người tránh dầu mỡ bắn ra lúc mới bưng lên', 'Trên chảo có thịt bít tết mềm, trứng ốp la, pate, xúc xích và chấm cùng bánh mì giòn'] },
      { name: 'Thịt kho tàu', aliases: ['Thit kho tau', 'Thit kho trung', 'Thit kho hot vit'], facts: ['Món mặn đậm đà truyền thống rất quen thuộc trong bữa cơm gia đình và mâm cỗ Tết miền Nam', 'Thịt ba chỉ cắt miếng vuông lớn ninh mềm nhừ với nước dừa tươi lên màu nâu cánh gián đẹp mắt', 'Không thể thiếu những quả trứng vịt luộc bóc vỏ kho chung thấm đẫm gia vị'] },
      { name: 'Cá kho tộ', aliases: ['Ca kho to'], facts: ['Món ăn đưa cơm kinh điển của mâm cơm gia đình miền Nam và miền Tây', 'Nấu trong chiếc nồi đất nhỏ giúp giữ nhiệt lâu và làm nước sốt kẹo sánh đậm đà', 'Thường dùng cá lóc hoặc cá basa cắt khúc, kho cùng nước màu, tiêu sọ, ớt và tóp mỡ'] },
      { name: 'Canh chua cá lóc', aliases: ['Canh chua', 'Canh chua ca loc'], facts: ['Món canh giải nhiệt thanh mát cực kỳ nổi tiếng của ẩm thực Nam Bộ', 'Vị chua ngọt hài hòa nấu từ me chín, dứa (thơm), cà chua, đậu bắp, giá đỗ và bạc hà', 'Khi múc ra tô luôn rắc thêm ngò om, ngò gai thơm nồng và vài lát ớt đỏ'] },
      { name: 'Trứng vịt lộn', aliases: ['Trung vit lon', 'Hot vit lon'], facts: ['Món ăn bổ dưỡng bình dân nhưng thường khiến nhiều du khách nước ngoài giật mình e ngại', 'Thường luộc chín rồi đặt vào chén nhỏ, đập vỏ húp phần nước ngọt bên trong trước', 'Bắt buộc phải ăn kèm rau răm, gừng tươi thái sợi và muối tiêu chanh tắc'] },
      { name: 'Chân gà sả tắc', aliases: ['Chan ga sa tac'], facts: ['Món ăn vặt và mồi nhậu gây nghiện cực hot với giới trẻ Việt Nam những năm gần đây', 'Nguyên liệu luộc chín rồi ngâm nước đá cho giòn sần sật, sau đó trộn nước mắm chua ngọt', 'Ngập tràn mùi thơm tươi mát của sả thái lát, lá chanh, ớt cay và những lát quất xanh'] },
      { name: 'Chè bưởi', aliases: ['Che buoi'], facts: ['Món tráng miệng ngọt mát nổi tiếng có xuất xứ từ miền Tây Nam Bộ', 'Điểm đặc biệt nhất là phần cùi trắng của một loại trái cây được sơ chế khéo để ăn giòn sần sật không hề đắng', 'Nấu sánh cùng đậu xanh bùi bùi và chan lớp nước cốt dừa béo ngậy lên trên'] },
      { name: 'Tào phớ', aliases: ['Tao pho', 'Tau hu', 'Tau hu nuoc duong'], facts: ['Món ăn vặt giải nhiệt mùa hè gắn liền với tiếng rao hàng rong khắp các con ngõ', 'Làm từ đậu nành đông mềm trắng mịn như mây, múc từng lát mỏng vào bát bằng miếng vỏ trai hoặc thìa dẹt', 'Chan nước đường hoa nhài hoặc nước đường gừng ấm, ngày nay hay thêm trân châu và thạch đen'] }
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

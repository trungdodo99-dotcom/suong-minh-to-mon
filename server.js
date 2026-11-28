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

// ================= CẤU HÌNH 2 GEMINI API KEY =================
// 1. API CŨ: Quản trò (Chọn chủ đề, mô tả, nhân vật bí mật & chấm đáp án)
const API_GAMEMASTER_KEY = [
  "AQ",
  "Ab8RN6LN_YaX7XDjf57tn3vuLb9ElSJMh4yvsvMoy656cN3d_w"
].join(".");

// 2. API MỚI: Đối thủ AI Thám Tử (Suy luận, đặt câu hỏi Yes/No & trả lời trong chế độ 1vAI)
const API_OPPONENT_KEY = [
  "AQ",
  "Ab8RN6JL4-HHio2luYxQteDiY-KU-Aa6MPHA5Y8sW291x5oPQg"
].join(".");

const cachedModelsByKey = {};

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

// ================= KHO DỰ PHÒNG NẾU API BẬN =================
const FALLBACK_DECKS = [
  {
    topicName: 'Nghệ Sĩ & Drama Showbiz Việt',
    topicDescription: 'Các ca sĩ, rapper, diễn viên, KOL Việt Nam từng gây bão mạng xã hội, có bản hit lớn hoặc drama chấn động dư luận.',
    items: [
      { name: 'Jack - J97', aliases: ['Jack', 'J97', 'Trinh Tran Phuong Tuan'], facts: ['Ca sĩ quê Bến Tre, nổi lên từ Hồng Nhan, Bạc Phận, Sóng Gió', 'Từng có drama ồn ào tình cảm và tranh chấp công ty cũ', 'Cộng đồng fan gọi là Đóm'] },
      { name: 'Sơn Tùng M-TP', aliases: ['Son Tung', 'MTP', 'Nguyen Thanh Tung'], facts: ['Nam ca sĩ quê Thái Bình, chủ tịch M-TP Entertainment', 'Nổi tiếng với Lạc Trôi, Hãy Trao Cho Anh, Chúng Ta Của Hiện Tại', 'Từng dính ồn ào xoay quanh MV và chuyện tình cảm kín tiếng'] },
      { name: 'Trấn Thành', aliases: ['Tran Thanh', 'Huynh Tran Thanh'], facts: ['MC, diễn viên, đạo diễn phim điện ảnh trăm tỷ (Bố Già, Mai)', 'Kết hôn với ca sĩ Hari Won', 'Hay gây tranh luận trên mạng xã hội vì các phát ngôn và cảm xúc'] },
      { name: 'Độ Mixi', aliases: ['Do Mixi', 'Phung Thanh Do', 'Toc Truong'], facts: ['Streamer hàng đầu Việt Nam quê Cao Bằng', 'Trưởng nhóm Refund Gaming, hay livestream nói chuyện và chơi game', 'Từng vướng lùm xùm bị nhắc nhở về ngôn từ và hình ảnh trên sóng'] },
      { name: 'ViruSs', aliases: ['Viruss', 'Dang Tien Hoang'], facts: ['Streamer, nhạc sĩ, nhà sản xuất nội dung nổi tiếng', 'Từng sáng tác Thằng Điên, Trời Giấu Trời Mang Đi', 'Từng gây bão mạng với các drama tình cảm và tranh luận âm nhạc'] },
      { name: 'HIEUTHUHAI', aliases: ['Hieu Thu Hai', 'Tran Minh Hieu'], facts: ['Rapper sinh năm 1999 thuộc tổ đội GERDNANG', 'Quán quân Anh Trai Say Hi, thành viên 2 Ngày 1 Đêm', 'Sở hữu nhiều bản hit như Ngủ Một Mình, Không Thể Say'] }
    ]
  },
  {
    topicName: 'Sao Quốc Tế & Drama Toàn Cầu',
    topicDescription: 'Ngôi sao âm nhạc, điện ảnh, tỷ phú hoặc nhân vật giải trí toàn cầu thường xuyên lên mặt báo vì tài năng và scandal.',
    items: [
      { name: 'Taylor Swift', aliases: ['Taylor'], facts: ['Nữ ca sĩ nhạc Pop/Country người Mỹ sở hữu The Eras Tour tỷ đô', 'Nổi tiếng viết nhạc về người yêu cũ và cuộc chiến bản quyền album', 'Đạt kỷ lục nhiều giải Grammy Album của năm nhất'] },
      { name: 'Elon Musk', aliases: ['Musk'], facts: ['Tỷ phú gốc Nam Phi, CEO Tesla và SpaceX', 'Mua lại Twitter và đổi tên thành X, sáng lập xAI (Grok)', 'Liên tục gây tranh cãi trên mạng xã hội về công nghệ và chính trị'] },
      { name: 'Cristiano Ronaldo', aliases: ['CR7', 'Ronaldo'], facts: ['Siêu sao bóng đá người Bồ Đào Nha, chủ nhân 5 Quả Bóng Vàng', 'Từng khoác áo Man Utd, Real Madrid, Juventus và Al Nassr', 'Kênh YouTube đạt hàng chục triệu sub chỉ trong vài ngày'] },
      { name: 'G-Dragon', aliases: ['GD', 'Kwon Ji Yong'], facts: ['Trưởng nhóm huyền thoại BIGBANG của K-pop', 'Biểu tượng thời trang toàn cầu, chủ thương hiệu PEACEMINUSONE', 'Từng trải qua vụ điều tra oan gây chấn động truyền thông Hàn Quốc'] }
    ]
  },
  {
    topicName: 'Các Hãng Xe Hơi Nổi Tiếng Thế Giới',
    topicDescription: 'Thương hiệu ô tô từ phổ thông đến siêu xe hạng sang, xe điện đang làm mưa làm gió trên toàn cầu và tại Việt Nam.',
    items: [
      { name: 'VinFast', aliases: ['Vin Fast'], facts: ['Hãng xe điện của Việt Nam thuộc tập đoàn Vingroup', 'Nổi bật với các dòng VF3, VF5, VF8, VF9', 'Niêm yết trên sàn chứng khoán Mỹ và có nhà máy tại Hải Phòng'] },
      { name: 'Toyota', aliases: ['Toyota Motor'], facts: ['Hãng xe lớn nhất Nhật Bản, nổi tiếng bền bỉ và giữ giá', 'Các mẫu xe quen thuộc tại VN: Vios, Camry, Fortuner, Innova', 'Có thương hiệu xe sang riêng là Lexus'] },
      { name: 'Mercedes-Benz', aliases: ['Mercedes', 'Mec', 'Merc'], facts: ['Thương hiệu xe sang lâu đời của Đức với logo ngôi sao 3 cánh', 'Nổi tiếng với các dòng C-Class, E-Class, S-Class và G63', 'Thường được giới nghệ sĩ và doanh nhân ưa chuộng'] },
      { name: 'Ferrari', aliases: ['Ngua chom'], facts: ['Hãng siêu xe thể thao huyền thoại của Ý với logo chú ngựa chồm', 'Gắn liền với màu sơn đỏ đặc trưng và đội đua F1 danh tiếng', 'Nổi tiếng với quy định cực khắt khe dành cho khách mua xe'] }
    ]
  },
  {
    topicName: 'Nhân Vật Lịch Sử Việt Nam & Thế Giới',
    topicDescription: 'Các vị anh hùng, danh tướng, nhà phát minh, lãnh tụ có tầm ảnh hưởng sâu rộng trong lịch sử.',
    items: [
      { name: 'Trần Hưng Đạo', aliases: ['Tran Quoc Tuan', 'Hung Dao Vuong'], facts: ['Danh tướng kiệt xuất thời nhà Trần của Việt Nam', 'Chỉ huy 3 lần đánh thắng quân Nguyên - Mông và trận Bạch Đằng', 'Tác giả bài Hịch Tướng Sĩ nổi tiếng'] },
      { name: 'Albert Einstein', aliases: ['Einstein'], facts: ['Nhà vật lý lý thuyết thiên tài người Đức gốc Do Thái', 'Cha đẻ của Thuyết Tương Đối và công thức E = mc^2', 'Nổi tiếng với mái tóc bạc bù xù và bức ảnh thè lưỡi'] },
      { name: 'Napoleon Bonaparte', aliases: ['Napoleon'], facts: ['Hoàng đế và nhà quân sự lừng danh của nước Pháp', 'Gắn liền với trận thua lịch sử tại Waterloo', 'Thường được nhắc đến với chiếc mũ hai sừng và vóc dáng thấp'] },
      { name: 'Nguyễn Huệ', aliases: ['Quang Trung', 'Vua Quang Trung'], facts: ['Anh hùng áo vải Tây Sơn, vị hoàng đế bách chiến bách thắng', 'Nổi tiếng với chiến thắng Ngọc Hồi - Đống Đa đại phá quân Thanh', 'Hành quân thần tốc ra Bắc vào dịp Tết Kỷ Dậu 1789'] }
    ]
  }
];

const TOPIC_PREF_DESCRIPTIONS = {
  hot_drama: 'ƯU TIÊN CAO NHẤT: Các nhân vật nghệ sĩ, ca sĩ, rapper, streamer, KOL, diễn viên đang có drama, scandal hoặc siêu hot gần đây tại Việt Nam và thế giới (thời điểm 2024-2026). Thỉnh thoảng có thể xen kẽ chủ đề thú vị khác nhưng 80% ưu tiên nghệ sĩ/drama hot.',
  vn_showbiz: 'BẮT BUỘC: Nghệ sĩ, ca sĩ, rapper, streamer, KOL hoặc nhân vật giải trí Việt Nam nổi tiếng hoặc có drama/xu hướng hot gần đây.',
  global_star: 'BẮT BUỘC: Nghệ sĩ, ngôi sao giải trí, vận động viên, tỷ phú hoặc nhân vật có drama/hot toàn cầu (US-UK, K-pop, C-biz, Hollywood...).',
  car_brands: 'BẮT BUỘC: Các hãng xe hơi nổi tiếng trên thế giới và Việt Nam (xe phổ thông, xe sang, siêu xe, xe điện).',
  history: 'BẮT BUỘC: Các nhân vật lịch sử nổi tiếng của Việt Nam hoặc thế giới (vua chúa, danh tướng, nhà khoa học, danh nhân).',
  anime_game: 'BẮT BUỘC: Các nhân vật Anime, Manga, Siêu anh hùng hoặc Game cực kỳ nổi tiếng mà giới trẻ đều biết.',
  random: 'NGẪU NHIÊN ĐA DẠNG: Có thể là con người HOẶC đồ vật/thương hiệu/động vật/món ăn/hãng xe/địa danh nổi tiếng. Vẫn ưu tiên các chủ đề gần gũi, dễ gây cười hoặc đang hot.'
};

// ================= HÀM QUẢN TRÒ (DÙNG API CŨ) =================
async function generateRoundWithGameMaster(topicPref = 'hot_drama', usedTargets = []) {
  const prefGuide = TOPIC_PREF_DESCRIPTIONS[topicPref] || TOPIC_PREF_DESCRIPTIONS.hot_drama;
  const avoidList = usedTargets.length > 0 ? `KHÔNG ĐƯỢC chọn lại các đáp án đã chơi sau: ${usedTargets.join(', ')}.` : '';

  const systemPrompt = `Bạn là Quản Trò của game đoán nhân vật Yes/No tên là "Là ải là ai" bằng tiếng Việt.
Nhiệm vụ: Chọn 1 chủ đề hấp dẫn (không nhất thiết lúc nào cũng là con người, có thể là hãng xe, thương hiệu, nhân vật lịch sử, nhưng hãy tuân thủ yêu cầu chủ đề bên dưới), viết mô tả ngắn cho chủ đề đó, và chọn ĐÚNG 2 đối tượng/nhân vật KHÁC NHAU nhưng CÙNG THUỘC CHỦ ĐỀ ĐÓ (đủ nổi tiếng để người Việt Nam biết và đặt câu hỏi Yes/No đoán ra được).

CHỈ TRẢ VỀ DUY NHẤT 1 ĐỐI TƯỢNG JSON HỢP LỆ theo đúng định dạng sau, không thêm bất kỳ chữ nào bên ngoài JSON:
{
  "topicName": "Tên chủ đề ngắn gọn (3-8 từ)",
  "topicDescription": "Mô tả phạm vi chủ đề trong 1-2 câu rõ ràng để 2 người chơi dễ hình dung.",
  "p1Target": {
    "name": "Tên chuẩn phổ biến nhất của nhân vật/đối tượng 1",
    "aliases": ["Biệt danh 1", "Tên viết tắt nếu có"],
    "facts": ["Đặc điểm nổi bật 1", "Đặc điểm nổi bật 2", "Đặc điểm hoặc drama/dấu ấn 3"]
  },
  "p2Target": {
    "name": "Tên chuẩn phổ biến nhất của nhân vật/đối tượng 2 (PHẢI KHÁC đối tượng 1)",
    "aliases": ["Biệt danh 2", "Tên viết tắt nếu có"],
    "facts": ["Đặc điểm nổi bật 1", "Đặc điểm nổi bật 2", "Đặc điểm hoặc drama/dấu ấn 3"]
  }
}`;

  const userPrompt = `Yêu cầu chủ đề: ${prefGuide}\n${avoidList}\nHãy tạo vòng chơi mới thật thú vị, độ khó vừa phải, nổi tiếng tại Việt Nam.`;

  try {
    const raw = await callGeminiText(API_GAMEMASTER_KEY, systemPrompt, userPrompt, 0.95);
    const parsed = extractJSON(raw);
    if (
      parsed &&
      parsed.topicName &&
      parsed.topicDescription &&
      parsed.p1Target?.name &&
      parsed.p2Target?.name &&
      normalizeVN(parsed.p1Target.name) !== normalizeVN(parsed.p2Target.name)
    ) {
      return {
        topic: {
          name: String(parsed.topicName).trim(),
          description: String(parsed.topicDescription).trim()
        },
        p1Secret: {
          name: String(parsed.p1Target.name).trim(),
          aliases: Array.isArray(parsed.p1Target.aliases) ? parsed.p1Target.aliases.map(String) : [],
          facts: Array.isArray(parsed.p1Target.facts) ? parsed.p1Target.facts.slice(0, 4).map(String) : []
        },
        p2Secret: {
          name: String(parsed.p2Target.name).trim(),
          aliases: Array.isArray(parsed.p2Target.aliases) ? parsed.p2Target.aliases.map(String) : [],
          facts: Array.isArray(parsed.p2Target.facts) ? parsed.p2Target.facts.slice(0, 4).map(String) : []
        },
        source: 'AI_GAMEMASTER'
      };
    }
  } catch (err) {
    console.error('GameMaster fallback do loi:', err.message);
  }

  // Fallback chọn từ kho dự phòng
  let deck = FALLBACK_DECKS[0];
  if (topicPref === 'car_brands') deck = FALLBACK_DECKS[2];
  else if (topicPref === 'history') deck = FALLBACK_DECKS[3];
  else if (topicPref === 'global_star') deck = FALLBACK_DECKS[1];
  else deck = FALLBACK_DECKS[Math.floor(Math.random() * FALLBACK_DECKS.length)];

  const shuffled = [...deck.items].sort(() => Math.random() - 0.5);
  return {
    topic: { name: deck.topicName, description: deck.topicDescription },
    p1Secret: shuffled[0],
    p2Secret: shuffled[1],
    source: 'FALLBACK'
  };
}

async function verifyGuessWithGameMaster(guessText, targetSecret, topicName) {
  const gNorm = normalizeVN(guessText);
  if (!gNorm) return { correct: false, reason: 'Đáp án trống.' };

  const allValidNames = [targetSecret.name, ...(targetSecret.aliases || [])].map(normalizeVN).filter(Boolean);
  for (const valid of allValidNames) {
    if (gNorm === valid || (gNorm.length >= 4 && valid.includes(gNorm)) || (valid.length >= 4 && gNorm.includes(valid))) {
      return { correct: true, reason: `Trùng khớp chính xác với ${targetSecret.name}!` };
    }
  }

  try {
    const sys = `Bạn là trọng tài chấm đáp án game đoán nhân vật.
Hãy kiểm tra xem câu trả lời của người chơi có chỉ CÙNG MỘT nhân vật/đối tượng với đáp án bí mật không (chấp nhận tên thật, nghệ danh, biệt danh phổ biến hoặc sai chính tả nhẹ; KHÔNG chấp nhận nếu đoán chung chung hoặc khác đối tượng).
Chỉ trả về JSON: {"correct": true hoặc false, "reason": "Giải thích cực ngắn dưới 15 từ"}`;
    const usr = `Chủ đề: ${topicName}\nĐáp án bí mật: "${targetSecret.name}" (Tên gọi khác: ${(targetSecret.aliases || []).join(', ')})\nNgười chơi đoán: "${guessText}"`;
    const raw = await callGeminiText(API_GAMEMASTER_KEY, sys, usr, 0.1);
    const parsed = extractJSON(raw);
    if (parsed && typeof parsed.correct === 'boolean') {
      return { correct: parsed.correct, reason: parsed.reason || '' };
    }
  } catch (e) {
    console.error('Loi cham dap an:', e.message);
  }

  return { correct: false, reason: 'Chưa đúng đáp án bí mật!' };
}

// ================= HÀM ĐỐI THỦ AI THÁM TỬ (DÙNG API MỚI) =================
async function aiOpponentAnswer(aiSecret, topic, questionText) {
  const sys = `Bạn đang là người chơi giữ thẻ bí mật trong game hỏi đáp Yes/No "Là ải là ai".
Đáp án bí mật BẠN ĐANG GIỮ: "${aiSecret.name}" (Biệt danh: ${(aiSecret.aliases || []).join(', ')})
Chủ đề: ${topic.name} (${topic.description})
Thông tin tham khảo về đáp án của bạn: ${(aiSecret.facts || []).join('; ')}.

Nhiệm vụ: Trả lời TRUNG THỰC, CHÍNH XÁC câu hỏi Yes/No của đối thủ về "${aiSecret.name}".
Quy tắc:
1. Chỉ chọn 1 trong 3 nhãn: "YES" (nếu đúng), "NO" (nếu sai), hoặc "MAYBE" (nếu mơ hồ, không hoàn toàn đúng/sai hoặc tùy góc nhìn).
2. Viết kèm 1 câu bình luận ngắn (tối đa 12 từ) mang phong cách tự tin, hơi trêu đối thủ, TUYỆT ĐỐI KHÔNG tiết lộ tên "${aiSecret.name}" hay đưa ra gợi ý lộ liễu.
3. Chỉ trả về JSON hợp lệ: {"answer": "YES"|"NO"|"MAYBE", "note": "..."}`;

  const usr = `Đối thủ hỏi bạn: "${questionText}"`;

  try {
    const raw = await callGeminiText(API_OPPONENT_KEY, sys, usr, 0.3);
    const parsed = extractJSON(raw);
    if (parsed && ['YES', 'NO', 'MAYBE'].includes(parsed.answer)) {
      return {
        answer: parsed.answer,
        note: String(parsed.note || '').slice(0, 120)
      };
    }
  } catch (err) {
    console.error('Loi AI Opponent tra loi:', err.message);
  }

  return { answer: 'MAYBE', note: 'Câu này hơi lắt léo, tính là không chắc nhé!' };
}

async function aiOpponentThinkAndAct(topic, aiHistory, guessesLeft, aiSecretName) {
  const askedLines = aiHistory.map((item, idx) => {
    if (item.isGuess) {
      return `${idx + 1}. [ĐOÁN THỬ] "${item.question}" => KẾT QUẢ: SAI (KHÔNG PHẢI đối tượng này!)`;
    }
    const ansLabel = item.answer === 'YES' ? 'CÓ (YES)' : item.answer === 'NO' ? 'KHÔNG (NO)' : 'KHÔNG CHẮC (MAYBE)';
    return `${idx + 1}. [HỎI] "${item.question}" => ĐỐI THỦ TRẢ LỜI: ${ansLabel}${item.answerNote ? ` (${item.answerNote})` : ''}`;
  }).join('\n');

  const questionCount = aiHistory.filter(i => !i.isGuess).length;

  const sys = `Bạn là "AI Thám Tử" - cao thủ suy luận trong game đoán nhân vật nổi tiếng bằng câu hỏi Yes/No tên là "Là ải là ai".
Chủ đề trận đấu: "${topic.name}"
Mô tả chủ đề: "${topic.description}"
(Lưu ý nhỏ: Thẻ của riêng bạn là "${aiSecretName}", nên đáp án của đối thủ CHẮC CHẮN KHÁC "${aiSecretName}".)

Số câu bạn đã hỏi: ${questionCount}. Số lượt đoán sai còn lại: ${guessesLeft}.

CHIẾN THUẬT SUY LUẬN BẮT BUỘC:
1. Luôn dùng chiến thuật chia đôi không gian tìm kiếm (Binary Search):
   - Những câu đầu tiên: hỏi phân loại lớn (Ví dụ nếu là người: Là người Việt Nam phải không? Là nam phải không? Nổi tiếng chủ yếu trong mảng âm nhạc/ca hát phải không? Sinh sau năm 1990 phải không? Từng có drama ồn ào lớn gần đây phải không? — Nếu là hãng xe/vật thể: Có nguồn gốc từ châu Á phải không? Là thương hiệu xe sang/siêu xe phải không? Logo có hình động vật phải không?...).
   - Các câu tiếp theo: dựa chặt chẽ vào lịch sử CÓ/KHÔNG để khoanh vùng cực hẹp (tác phẩm/sản phẩm tiêu biểu, nhóm/công ty, đặc điểm nhận diện đặc trưng).
2. TUYỆT ĐỐI KHÔNG lặp lại câu hỏi đã hỏi hoặc hỏi câu thừa đã biết từ trước.
3. Khi đã thu hẹp xuống còn 1-2 ứng viên cực kỳ chắc chắn (hoặc đã hỏi từ 5 câu trở lên và rất tự tin), hãy chọn "action": "guess" và điền ĐÚNG TÊN đối tượng vào "text". Đừng đoán bừa quá sớm khi mới hỏi 1-2 câu!
4. Nếu chọn "action": "ask", "text" phải là ĐÚNG 1 câu hỏi Yes/No rõ ràng, ngắn gọn bằng tiếng Việt (không hỏi câu lựa chọn "A hay B?").

CHỈ TRẢ VỀ JSON HỢP LỆ:
{
  "action": "ask" hoặc "guess",
  "text": "Câu hỏi Yes/No sắc bén HOẶC Tên nhân vật bạn chốt đoán",
  "taunt": "1 câu gáy nhẹ/nhận xét suy luận cực ngắn dưới 14 từ"
}`;

  const usr = askedLines
    ? `Lịch sử các câu bạn đã hỏi đối thủ và câu trả lời:\n${askedLines}\n\nHãy suy luận bước tiếp theo tốt nhất!`
    : `Đây là câu hỏi ĐẦU TIÊN của bạn trong chủ đề "${topic.name}". Hãy đặt 1 câu hỏi Yes/No phân loại rộng thông minh nhất!`;

  try {
    const raw = await callGeminiText(API_OPPONENT_KEY, sys, usr, 0.55);
    const parsed = extractJSON(raw);
    if (parsed && (parsed.action === 'ask' || parsed.action === 'guess') && parsed.text) {
      // Nếu AI mới hỏi < 2 câu mà đòi đoán bừa thì ép chuyển sang hỏi tiếp
      if (parsed.action === 'guess' && questionCount < 2) {
        return {
          action: 'ask',
          text: `Đối tượng của bạn có nguồn gốc từ Việt Nam phải không?`,
          taunt: 'Để mình khoanh vùng địa lý trước đã!'
        };
      }
      return {
        action: parsed.action,
        text: String(parsed.text).trim().slice(0, 180),
        taunt: String(parsed.taunt || 'Để xem bạn giấu ai nào...').slice(0, 110)
      };
    }
  } catch (err) {
    console.error('Loi AI Opponent dat cau hoi:', err.message);
  }

  const fallbackQuestions = [
    'Đối tượng bí mật của bạn có phải là người Việt Nam (hoặc thương hiệu Việt Nam) không?',
    'Đối tượng này có phải là con người thật đang còn sống không?',
    'Đối tượng này có nổi tiếng mạnh mẽ trong khoảng 3 năm gần đây không?',
    'Tên gọi phổ biến của đối tượng này có từ 2 từ trở lên phải không?'
  ];
  return {
    action: 'ask',
    text: fallbackQuestions[questionCount % fallbackQuestions.length],
    taunt: 'Suy luận cẩn trọng từng bước nào!'
  };
}

// ================= QUẢN LÝ TÀI KHOẢN (ĐĂNG KÝ LÀ VÀO NGAY) =================
let accounts = {};

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch (e) {
    accounts = {};
  }
}

function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
  } catch (e) {}
}

loadAccounts();

const onlineUsers = {}; // socketId -> { id, usernameKey, name, avatar, roomId }
const rooms = {};       // roomId -> Room
let roomCounter = 100;

function getLeaderboard() {
  return Object.values(accounts)
    .map(a => ({
      usernameKey: a.usernameKey,
      name: a.name,
      avatar: a.avatar || '🕵️',
      wins: a.wins || 0,
      losses: a.losses || 0
    }))
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses)
    .slice(0, 20);
}

function getLobbyState() {
  const roomList = Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    mode: r.mode,
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
    onlineUsers: usersList,
    leaderboard: getLeaderboard()
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
      usernameKey: pl.usernameKey,
      name: pl.name,
      avatar: pl.avatar,
      isAI: Boolean(pl.isAI),
      guessesLeft: pl.guessesLeft,
      secret: canSeeSecret ? pl.secret : null
    };
  };

  return {
    id: room.id,
    name: room.name,
    mode: room.mode,
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
    aiThinking: Boolean(room.aiThinking)
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

  const loserSide = winnerSide === 'p1' ? 'p2' : 'p1';
  const winner = room.players[winnerSide];
  const loser = room.players[loserSide];

  if (winner && !winner.isAI && accounts[winner.usernameKey]) {
    accounts[winner.usernameKey].wins = (accounts[winner.usernameKey].wins || 0) + 1;
  }
  if (loser && !loser.isAI && accounts[loser.usernameKey]) {
    accounts[loser.usernameKey].losses = (accounts[loser.usernameKey].losses || 0) + 1;
  }
  saveAccounts();
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
  room.players.p1.guessesLeft = 3;
  room.players.p2.guessesLeft = 3;
  room.players.p1.secret = null;
  room.players.p2.secret = null;

  broadcastRoom(room);
  broadcastLobby();

  const round = await generateRoundWithGameMaster(room.topicPref, room.usedTargets);
  if (!rooms[room.id]) return; // Phong da bi huy trong luc cho

  room.topic = round.topic;
  room.players.p1.secret = round.p1Secret;
  room.players.p2.secret = round.p2Secret;
  room.usedTargets.push(round.p1Secret.name, round.p2Secret.name);
  if (room.usedTargets.length > 24) room.usedTargets = room.usedTargets.slice(-24);

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

  // Cho 1.2 giay tao cam giac tu nhien
  await new Promise(r => setTimeout(r, 1200));
  if (!rooms[room.id] || room.status !== 'playing' || room.turnSide !== 'p2') return;

  const aiHistory = room.qaHistory.filter(item => item.bySide === 'p2');
  const decision = await aiOpponentThinkAndAct(
    room.topic,
    aiHistory,
    room.players.p2.guessesLeft,
    room.players.p2.secret?.name || ''
  );

  if (!rooms[room.id] || room.status !== 'playing' || room.turnSide !== 'p2') return;
  room.aiThinking = false;

  if (decision.action === 'guess') {
    const verdict = await verifyGuessWithGameMaster(decision.text, room.players.p1.secret, room.topic.name);
    room.qaHistory.push({
      id: Date.now(),
      bySide: 'p2',
      byName: room.players.p2.name,
      question: decision.text,
      taunt: decision.taunt,
      isGuess: true,
      guessCorrect: verdict.correct,
      answerNote: verdict.reason,
      time: Date.now()
    });

    if (verdict.correct) {
      recordMatchResult(room, 'p2', `🤖 AI Thám Tử đã phá án chính xác: "${room.players.p1.secret.name}"!`);
      return;
    } else {
      room.players.p2.guessesLeft -= 1;
      if (room.players.p2.guessesLeft <= 0) {
        recordMatchResult(room, 'p1', `🎉 AI Thám Tử đã dùng hết 3 lượt đoán sai! ${room.players.p1.name} chiến thắng!`);
        return;
      }
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
    // Neu nguoi choi roi phong 1vAI -> dong phong va thong bao khan gia
    Object.keys(room.spectators).forEach(sid => {
      if (onlineUsers[sid]) onlineUsers[sid].roomId = null;
      io.to(sid).emit('kicked_to_lobby', `Phòng "${room.name}" đã đóng do chủ phòng rời trận.`);
    });
    delete rooms[room.id];
    broadcastLobby();
    return;
  }

  // Che do PvP
  if (room.status === 'playing') {
    const otherSide = leavingSide === 'p1' ? 'p2' : 'p1';
    const leaverName = room.players[leavingSide]?.name || 'Người chơi';
    recordMatchResult(room, otherSide, `🏳️ ${leaverName} đã rời trận giữa chừng (${reasonMsg || 'Bỏ cuộc'})!`);
  }

  room.players[leavingSide] = null;

  // Neu con p2 ma p1 roi -> don p2 len lam p1 & host
  if (!room.players.p1 && room.players.p2 && !room.players.p2.isAI) {
    room.players.p1 = room.players.p2;
    room.players.p2 = null;
    room.hostId = room.players.p1.id;
    room.status = 'waiting';
  } else if (room.players.p1 && !room.players.p2) {
    if (room.status !== 'finished') room.status = 'waiting';
  }

  // Neu khong con nguoi choi nao -> xoa phong
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

  // 1. ĐĂNG KÝ TẠO ACC -> VÀO ĐƯỢC LUÔN
  socket.on('register', ({ name, password, avatar }, cb) => {
    const cleanName = (name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    const cleanPass = (password || '').trim();
    if (!cleanName || cleanName.length < 2) {
      return cb({ ok: false, msg: 'Tên hiển thị phải có ít nhất 2 ký tự!' });
    }
    if (!cleanPass || cleanPass.length < 3) {
      return cb({ ok: false, msg: 'Mật khẩu phải có ít nhất 3 ký tự!' });
    }

    const key = cleanName.toLowerCase();
    if (accounts[key]) {
      return cb({ ok: false, msg: 'Tên tài khoản này đã tồn tại! Hãy chọn tên khác hoặc chuyển sang Đăng nhập.' });
    }

    accounts[key] = {
      usernameKey: key,
      name: cleanName,
      password: cleanPass,
      avatar: avatar || '🕵️',
      wins: 0,
      losses: 0,
      createdAt: Date.now()
    };
    saveAccounts();

    onlineUsers[socket.id] = {
      id: socket.id,
      usernameKey: key,
      name: cleanName,
      avatar: accounts[key].avatar,
      roomId: null
    };

    broadcastLobby();
    return cb({
      ok: true,
      user: {
        id: socket.id,
        usernameKey: key,
        name: cleanName,
        avatar: accounts[key].avatar,
        wins: 0,
        losses: 0
      },
      lobby: getLobbyState()
    });
  });

  // 2. ĐĂNG NHẬP VÀO LUÔN
  socket.on('login', ({ name, password }, cb) => {
    const cleanName = (name || '').trim().replace(/\s+/g, ' ');
    const cleanPass = (password || '').trim();
    const key = cleanName.toLowerCase();
    const acc = accounts[key];

    if (!acc) {
      return cb({ ok: false, msg: 'Không tìm thấy tài khoản này! Hãy bấm sang tab "Tạo tài khoản" để vào chơi ngay.' });
    }
    if (acc.password !== cleanPass) {
      return cb({ ok: false, msg: 'Sai mật khẩu rồi!' });
    }

    // Da nick cu neu dang online noi khac
    for (const [sid, u] of Object.entries(onlineUsers)) {
      if (u.usernameKey === key && sid !== socket.id) {
        removeUserFromRoom(sid, 'Đăng nhập ở thiết bị khác');
        delete onlineUsers[sid];
        io.to(sid).emit('force_logout', 'Tài khoản của bạn vừa được đăng nhập ở nơi khác!');
      }
    }

    onlineUsers[socket.id] = {
      id: socket.id,
      usernameKey: key,
      name: acc.name,
      avatar: acc.avatar || '🕵️',
      roomId: null
    };

    broadcastLobby();
    return cb({
      ok: true,
      user: {
        id: socket.id,
        usernameKey: key,
        name: acc.name,
        avatar: acc.avatar || '🕵️',
        wins: acc.wins || 0,
        losses: acc.losses || 0
      },
      lobby: getLobbyState()
    });
  });

  // 3. TẠO PHÒNG (PvP hoặc 1 vs AI)
  socket.on('create_room', async ({ mode, topicPref, roomName }, cb) => {
    const user = onlineUsers[socket.id];
    if (!user) return cb({ ok: false, msg: 'Bạn chưa đăng nhập!' });

    if (user.roomId) removeUserFromRoom(socket.id);

    roomCounter += 1;
    const roomId = `ROOM_${roomCounter}`;
    const validMode = mode === 'pvai' ? 'pvai' : 'pvp';
    const validPref = TOPIC_PREF_DESCRIPTIONS[topicPref] ? topicPref : 'hot_drama';
    const title = (roomName || '').trim().slice(0, 32) || (
      validMode === 'pvai'
        ? `🤖 ${user.name} đấu trí AI Thám Tử`
        : `⚔️ Sàn đấu của ${user.name}`
    );

    const newRoom = {
      id: roomId,
      name: title,
      mode: validMode,
      topicPref: validPref,
      status: 'waiting',
      hostId: socket.id,
      players: {
        p1: {
          id: socket.id,
          usernameKey: user.usernameKey,
          name: user.name,
          avatar: user.avatar,
          isAI: false,
          guessesLeft: 3,
          secret: null
        },
        p2: validMode === 'pvai' ? {
          id: 'AI_OPPONENT',
          usernameKey: 'ai_tham_tu',
          name: 'AI Thám Tử',
          avatar: '🤖',
          isAI: true,
          guessesLeft: 3,
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
      aiThinking: false
    };

    rooms[roomId] = newRoom;
    user.roomId = roomId;

    cb({ ok: true, room: serializeRoomForSocket(newRoom, socket.id) });
    broadcastLobby();

    if (validMode === 'pvai') {
      await startMatchInRoom(newRoom);
    }
  });

  // 4. THAM GIA PHÒNG (LÀM ĐỐI THỦ HOẶC KHÁN GIẢ XEM CUỘC CHIẾN)
  socket.on('join_room', ({ roomId, asSpectator }, cb) => {
    const user = onlineUsers[socket.id];
    if (!user) return cb({ ok: false, msg: 'Bạn chưa đăng nhập!' });

    const room = rooms[roomId];
    if (!room) return cb({ ok: false, msg: 'Phòng không còn tồn tại!' });

    if (user.roomId) removeUserFromRoom(socket.id);

    const canJoinAsPlayer = !asSpectator && room.mode === 'pvp' && !room.players.p2 && room.status === 'waiting';
    if (canJoinAsPlayer) {
      room.players.p2 = {
        id: socket.id,
        usernameKey: user.usernameKey,
        name: user.name,
        avatar: user.avatar,
        isAI: false,
        guessesLeft: 3,
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

  // 5. ĐỔI CHỦ ĐỀ & BẮT ĐẦU TRẬN / TÁI ĐẤU
  socket.on('update_topic_pref', ({ topicPref }) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return;
    const room = rooms[user.roomId];
    if (!room || room.hostId !== socket.id) return;
    if (TOPIC_PREF_DESCRIPTIONS[topicPref]) {
      room.topicPref = topicPref;
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

  // 6. ĐẶT CÂU HỎI YES/NO
  socket.on('ask_question', async ({ text }, cb) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return cb && cb({ ok: false, msg: 'Không ở trong phòng!' });
    const room = rooms[user.roomId];
    if (!room || room.status !== 'playing') return cb && cb({ ok: false, msg: 'Trận đấu chưa bắt đầu!' });

    const side = room.players.p1?.id === socket.id ? 'p1' : room.players.p2?.id === socket.id ? 'p2' : null;
    if (!side || room.turnSide !== side || room.turnPhase !== 'asking') {
      return cb && cb({ ok: false, msg: 'Chưa tới lượt hỏi của bạn!' });
    }

    const qText = (text || '').trim().slice(0, 180);
    if (qText.length < 3) return cb && cb({ ok: false, msg: 'Hãy nhập câu hỏi rõ ràng hơn nhé!' });

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

    // Nếu đối thủ là AI Thám Tử -> gọi API mới trả lời tự động
    if (room.mode === 'pvai' && side === 'p1') {
      room.aiThinking = true;
      broadcastRoom(room);

      const aiRes = await aiOpponentAnswer(room.players.p2.secret, room.topic, qText);
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

      // Kích hoạt lượt hỏi/suy luận của AI
      triggerAITurn(room);
    }
  });

  // 7. TRẢ LỜI CÓ / KHÔNG / KHÔNG CHẮC
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

    const validAns = ['YES', 'NO', 'MAYBE'].includes(answer) ? answer : 'MAYBE';
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
    // Đổi lượt sang người vừa trả lời đi hỏi lại
    room.turnSide = mySide;
    room.turnPhase = 'asking';

    if (cb) cb({ ok: true });
    broadcastRoom(room);
    broadcastLobby();
  });

  // 8. CHỐT ĐOÁN ĐÁP ÁN
  socket.on('submit_guess', async ({ guessText }, cb) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return cb && cb({ ok: false, msg: 'Không ở trong phòng!' });
    const room = rooms[user.roomId];
    if (!room || room.status !== 'playing') return cb && cb({ ok: false, msg: 'Trận đấu chưa bắt đầu!' });

    const side = room.players.p1?.id === socket.id ? 'p1' : room.players.p2?.id === socket.id ? 'p2' : null;
    if (!side || room.turnSide !== side || room.turnPhase !== 'asking') {
      return cb && cb({ ok: false, msg: 'Chỉ được đoán đáp án khi đang ở lượt hỏi của bạn!' });
    }

    const cleanGuess = (guessText || '').trim().slice(0, 100);
    if (!cleanGuess) return cb && cb({ ok: false, msg: 'Hãy nhập tên đáp án bạn muốn đoán!' });

    const targetSide = side === 'p1' ? 'p2' : 'p1';
    const targetSecret = room.players[targetSide].secret;

    if (cb) cb({ ok: true });
    const verdict = await verifyGuessWithGameMaster(cleanGuess, targetSecret, room.topic.name);
    if (!rooms[room.id] || room.status !== 'playing') return;

    room.qaHistory.push({
      id: Date.now(),
      bySide: side,
      byName: room.players[side].name,
      question: cleanGuess,
      isGuess: true,
      guessCorrect: verdict.correct,
      answerNote: verdict.reason,
      time: Date.now()
    });

    if (verdict.correct) {
      recordMatchResult(room, side, `🏆 ${room.players[side].name} đã đoán trúng đáp án "${targetSecret.name}"!`);
      return;
    }

    room.players[side].guessesLeft -= 1;
    if (room.players[side].guessesLeft <= 0) {
      recordMatchResult(
        room,
        targetSide,
        `💥 ${room.players[side].name} đã dùng hết 3 lượt đoán sai! ${room.players[targetSide].name} giành chiến thắng!`
      );
      return;
    }

    // Đoán sai -> mất lượt, chuyển sang đối thủ
    room.turnSide = targetSide;
    room.turnPhase = 'asking';
    broadcastRoom(room);
    broadcastLobby();

    if (room.mode === 'pvai' && room.turnSide === 'p2') {
      triggerAITurn(room);
    }
  });

  // 9. CHAT KHÁN ĐÀI (CHỈ KHÁN GIẢ XEM TRONG LÚC ĐẤU ĐỂ KHÔNG SPOIL)
  socket.on('spectator_chat', ({ text }) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.roomId) return;
    const room = rooms[user.roomId];
    if (!room) return;

    const clean = (text || '').trim().slice(0, 160);
    if (!clean) return;

    const isPlayer = room.players.p1?.id === socket.id || room.players.p2?.id === socket.id;
    if (isPlayer && room.status === 'playing') return; // Đấu thủ không chat khán đài khi đang đánh

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

  // 10. RỜI PHÒNG / NGẮT KẾT NỐI
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
  console.log(`🕵️‍♂️ Game "LÀ ẢI LÀ AI" đang chạy tại: http://localhost:${PORT}`);
});

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
// 动态接口禁用缓存，保证实时数据不被浏览器/代理缓存（大量用户不同时间提交也能实时看到）
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// 设备标识 Cookie：服务器签发（httpOnly，页面 JS 不可读、更抗伪造），清 localStorage 也不丢
app.use((req, res, next) => {
  if (!req.cookies.device_id) {
    res.cookie('device_id', 'd-' + crypto.randomUUID(), {
      httpOnly: true,
      maxAge: 365 * 24 * 3600 * 1000,
      sameSite: 'lax',
    });
  }
  next();
});

const DATA_DIR = path.join(__dirname, 'data');
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const DB_FILE = path.join(DATA_DIR, 'quiz.db');
// 确保数据目录存在（git 克隆/全新环境没有 data/ 时自动创建）
fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// ---------- 载入题库 ----------
const questionsData = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
const sections = questionsData.sections;

// ---------- 初始化 SQLite 数据库 ----------
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    section_id TEXT NOT NULL,
    device_id TEXT,
    ts INTEGER NOT NULL,
    answers_json TEXT NOT NULL,
    correct INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    UNIQUE(nickname, section_id)
  );
  CREATE INDEX IF NOT EXISTS idx_answers_section ON answers(section_id);

  CREATE TABLE IF NOT EXISTS owners (
    nickname TEXT PRIMARY KEY,
    device_id TEXT NOT NULL
  );
`);

const stmtInsertAnswer = db.prepare(`
  INSERT INTO answers (nickname, section_id, device_id, ts, answers_json, correct, total)
  VALUES (@nickname, @sectionId, @deviceId, @ts, @answersJson, @correct, @total)
  ON CONFLICT(nickname, section_id) DO UPDATE SET
    device_id = excluded.device_id,
    ts = excluded.ts,
    answers_json = excluded.answers_json,
    correct = excluded.correct,
    total = excluded.total
`);
const stmtUpsertOwner = db.prepare('INSERT INTO owners (nickname, device_id) VALUES (?, ?) ON CONFLICT(nickname) DO UPDATE SET device_id = excluded.device_id');

// ---------- 内存缓存（启动时从数据库载入） ----------
let records = []; // { nickname, sectionId, deviceId, ts, answers: [{questionId, answer, correct}] }
let owners = {};  // nickname -> deviceId（同名昵称防撞）

function loadFromDb() {
  const rows = db.prepare('SELECT nickname, section_id, device_id, ts, answers_json FROM answers ORDER BY ts').all();
  records = rows.map((r) => ({
    nickname: r.nickname,
    sectionId: r.section_id,
    deviceId: r.device_id,
    ts: r.ts,
    answers: JSON.parse(r.answers_json),
  }));

  owners = {};
  db.prepare('SELECT nickname, device_id FROM owners').all().forEach((o) => { owners[o.nickname] = o.device_id; });
}
loadFromDb();

const sectionById = (id) => sections.find((s) => s.id === id);

// 昵称清洗：去除 HTML 危险字符与控制字符（防 XSS 存储）
function sanitizeNickname(s) {
  return String(s)
    .replace(/[\u0000-\u001F\u007F<>"'`\\&]/g, '')
    .trim()
    .slice(0, 20);
}

// ---------- 计算实时状态 ----------
function computeState() {
  const sectionStats = sections.map((sec) => {
    const secRecords = records.filter((r) => r.sectionId === sec.id);
    const latest = new Map();
    secRecords.forEach((r) => latest.set(r.nickname, r));

    const qCounts = sec.questions.map((q) => {
      let correct = 0, wrong = 0;
      latest.forEach((r) => {
        r.answers.forEach((a) => {
          if (a.questionId === q.id) { if (a.correct) correct++; else wrong++; }
        });
      });
      const answered = correct + wrong;
      // 每个选项的选择人数与占比
      const options = (q.options || []).map((o) => {
        let count = 0;
        latest.forEach((r) => {
          r.answers.forEach((a) => {
            if (a.questionId === q.id && a.answer === o) count++;
          });
        });
        return { text: o, count, pct: answered ? Math.round(count / answered * 100) : 0 };
      });
      return {
        id: q.id,
        text: q.text,
        type: q.type,
        correct,
        wrong,
        answered,
        rate: answered ? Math.round(correct / answered * 100) : 0,
        correctAnswer: q.answer,
        explain: q.explain,
        options,
      };
    });

    const correctTotal = qCounts.reduce((s, q) => s + q.correct, 0);
    const answeredTotal = qCounts.reduce((s, q) => s + q.correct + q.wrong, 0);
    // 实时动态排名：按当前板块正确率降序，正确率相同则答题时间早者优先
    const ranking = [...latest.values()]
      .map((r) => {
        const total = r.answers.length;
        const correct = r.answers.filter((a) => a.correct).length;
        return { nickname: r.nickname, correct, total, rate: total ? Math.round(correct / total * 100) : 0, ts: r.ts };
      })
      .sort((a, b) => b.rate - a.rate || a.ts - b.ts)
      .map((u, i) => ({ ...u, rank: i + 1 }));

    return {
      id: sec.id,
      title: sec.title,
      subtitle: sec.subtitle,
      questionCount: sec.questions.length,
      participants: latest.size,
      correctTotal,
      answeredTotal,
      questions: qCounts,
      ranking,
    };
  });

  const userMap = new Map();
  sections.forEach((sec) => {
    const latest = new Map();
    records.filter((r) => r.sectionId === sec.id).forEach((r) => latest.set(r.nickname, r));
    latest.forEach((r) => {
      const u = userMap.get(r.nickname) || { nickname: r.nickname, correct: 0, total: 0, sections: 0, lastTs: 0 };
      u.correct += r.answers.filter((a) => a.correct).length;
      u.total += r.answers.length;
      u.sections += 1;
      u.lastTs = Math.max(u.lastTs, r.ts);
      userMap.set(r.nickname, u);
    });
  });

  // 总览排名：答对题数降序，同分按最后提交时间早者优先，名次唯一递增（1,2,3…）
  const users = [...userMap.values()].sort((a, b) => b.correct - a.correct || a.lastTs - b.lastTs);
  users.forEach((u, i) => { u.rank = i + 1; });

  return {
    updatedAt: Date.now(),
    totalUsers: users.length,
    totalCorrect: sectionStats.reduce((s, x) => s + x.correctTotal, 0),
    totalAnswered: sectionStats.reduce((s, x) => s + x.answeredTotal, 0),
    sections: sectionStats,
    users,
  };
}

// ---------- 计算实时状态（带缓存：提交时才重算，查询直接读缓存） ----------
let cachedState = null;
let cachedStateJson = null; // 连序列化结果也缓存，查询零计算零序列化

function getStateJson() {
  if (!cachedStateJson) {
    cachedState = computeState();
    cachedStateJson = JSON.stringify(cachedState);
  }
  return cachedStateJson;
}

function invalidateState() {
  cachedState = null;
  cachedStateJson = null;
}

// ---------- 公开 API ----------
app.get('/api/meta', (req, res) => {
  res.json({ publicUrl: PUBLIC_URL });
});

app.get('/api/sections', (req, res) => {
  res.json(sections.map((s) => ({ id: s.id, title: s.title, subtitle: s.subtitle, questionCount: s.questions.length })));
});

app.get('/api/questions', (req, res) => {
  const sec = sectionById(req.query.section);
  if (!sec) return res.status(404).json({ ok: false, error: '板块不存在' });
  res.json({
    section: { id: sec.id, title: sec.title, subtitle: sec.subtitle },
    questions: sec.questions.map((q) => ({ id: q.id, type: q.type, text: q.text, options: q.options })),
  });
});

app.get('/api/state', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.send(getStateJson());
});

app.get('/api/qr', async (req, res) => {
  const t = (req.query.t || '').toString();
  if (!t) return res.status(400).json({ ok: false, error: '缺少内容' });
  try {
    const dataUrl = await QRCode.toDataURL(t, { width: 360, margin: 1, errorCorrectionLevel: 'M' });
    res.json({ ok: true, dataUrl });
  } catch (e) {
    res.status(400).json({ ok: false, error: '二维码生成失败' });
  }
});

app.get('/api/check-nickname', (req, res) => {
  const nickname = sanitizeNickname(req.query.nickname || '');
  const device = String(req.cookies.device_id || req.query.deviceId || '').trim();
  if (!nickname) return res.json({ ok: true, taken: false });
  const taken = !!(owners[nickname] && owners[nickname] !== device);
  res.json({ ok: true, taken, error: taken ? '该昵称已被使用，请更换一个昵称' : '' });
});

// 构造某条记录的逐题答题结果（用于返回给用户展示）
function buildResults(sec, rec) {
  return sec.questions.map((q) => {
    const a = rec.answers.find((x) => x.questionId === q.id);
    return {
      questionId: q.id,
      yourAnswer: a ? a.answer : '',
      correctAnswer: q.answer,
      correct: a ? a.correct : false,
      explain: q.explain,
    };
  });
}

// 查询某用户（昵称）在某板块的答题结果（用于再次扫码时直接展示）
app.get('/api/my-result', (req, res) => {
  const nickname = String(req.query.nickname || '').trim();
  const section = String(req.query.section || '');
  const rec = records.find((r) => r.nickname === nickname && r.sectionId === section);
  if (!rec) return res.json({ submitted: false });
  const sec = sectionById(section);
  if (!sec) return res.json({ submitted: false });
  res.json({ submitted: true, results: buildResults(sec, rec) });
});

app.post('/api/submit', (req, res) => {
  const { nickname, section, answers, deviceId } = req.body || {};
  if (!nickname || !section || !Array.isArray(answers)) {
    return res.status(400).json({ ok: false, error: '参数错误' });
  }
  const nicknameClean = sanitizeNickname(nickname);
  if (!nicknameClean) return res.status(400).json({ ok: false, error: '请填写昵称' });

  // 设备标识优先取服务器 Cookie（httpOnly，难以伪造），兼容旧客户端传的 deviceId
  const device = String(req.cookies.device_id || deviceId || '').trim();
  if (!device) return res.status(400).json({ ok: false, error: '设备标识缺失，请重新扫码进入' });

  if (owners[nicknameClean] && owners[nicknameClean] !== device) {
    return res.status(409).json({ ok: false, error: '该昵称已被使用，请更换一个昵称' });
  }

  const sec = sectionById(section);
  if (!sec) return res.status(404).json({ ok: false, error: '板块不存在' });

  // 同一板块限提交一次（防止看完答案后重交刷分）
  const existIdx = records.findIndex((r) => r.nickname === nicknameClean && r.sectionId === section);
  if (existIdx >= 0) {
    return res.status(409).json({
      ok: false,
      alreadySubmitted: true,
      error: '你已提交过该板块，不能重复提交',
      results: buildResults(sec, records[existIdx]),
    });
  }

  const answerList = [];
  for (const a of answers) {
    const q = sec.questions.find((x) => x.id === a.questionId);
    if (!q) continue;
    answerList.push({ questionId: q.id, answer: a.answer, correct: (a.answer === q.answer) });
  }
  if (answerList.length === 0) return res.status(400).json({ ok: false, error: '没有有效答案' });

  const ts = Date.now();
  const correct = answerList.filter((a) => a.correct).length;

  // 写入数据库
  stmtInsertAnswer.run({
    nickname: nicknameClean,
    sectionId: section,
    deviceId: device,
    ts,
    answersJson: JSON.stringify(answerList),
    correct,
    total: answerList.length,
  });
  stmtUpsertOwner.run(nicknameClean, device);

  // 更新内存缓存
  owners[nicknameClean] = device;
  const rec = { nickname: nicknameClean, sectionId: section, deviceId: device, ts, answers: answerList };
  records.push(rec);
  invalidateState();

  res.json({ ok: true, results: buildResults(sec, rec) });
});

// ---------- 页面路由 ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/answer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'answer.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/final', (req, res) => res.sendFile(path.join(__dirname, 'public', 'final.html')));

app.listen(PORT, () => {
  console.log('==============================================');
  console.log('  民法典宣讲答题系统已启动');
  console.log('  本机/公网访问: ' + (PUBLIC_URL || ('http://localhost:' + PORT)));
  console.log('  数据存储: SQLite 数据库 data/quiz.db');
  console.log('==============================================');
});

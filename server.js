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
// 动态接口禁用缓存，保证实时数据不被浏览器/代理缓存
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// 设备标识 Cookie（httpOnly，身份即设备，无需昵称）
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

// 公网地址（防御：修复重复协议头 https://https://x → https://x）
const PUBLIC_URL = (() => {
  const u = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return u.replace(/^https?:\/\/(https?:\/\/)/i, '$1');
})();

const PORT = process.env.PORT || 3000;

// ---------- 载入题库 ----------
const questionsData = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
const sections = questionsData.sections;

// ---------- 初始化 SQLite 数据库（身份 = 设备，无昵称） ----------
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
// 大改版迁移：旧版表结构含 nickname → 丢弃旧表（清空旧答题数据）
const oldCols = db.prepare('PRAGMA table_info(answers)').all();
if (oldCols.some((c) => c.name === 'nickname')) {
  db.exec('DROP TABLE IF EXISTS answers; DROP TABLE IF EXISTS owners;');
  console.log('已检测到旧版数据表结构，执行大改版迁移（清空旧答题数据）');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    section_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    answers_json TEXT NOT NULL,
    correct INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    UNIQUE(device_id, section_id)
  );
  CREATE INDEX IF NOT EXISTS idx_answers_section ON answers(section_id);
`);

const stmtInsertAnswer = db.prepare(`
  INSERT INTO answers (device_id, section_id, ts, answers_json, correct, total)
  VALUES (@deviceId, @sectionId, @ts, @answersJson, @correct, @total)
  ON CONFLICT(device_id, section_id) DO UPDATE SET
    ts = excluded.ts,
    answers_json = excluded.answers_json,
    correct = excluded.correct,
    total = excluded.total
`);

// ---------- 内存缓存（启动时从数据库载入） ----------
let records = []; // { deviceId, sectionId, ts, answers: [{questionId, answer, correct}] }

function loadFromDb() {
  const rows = db.prepare('SELECT device_id, section_id, ts, answers_json FROM answers ORDER BY ts').all();
  records = rows.map((r) => ({
    deviceId: r.device_id,
    sectionId: r.section_id,
    ts: r.ts,
    answers: JSON.parse(r.answers_json),
  }));
}
loadFromDb();

const sectionById = (id) => sections.find((s) => s.id === id);

// ---------- 计算实时状态（无排名，仅各板块答题情况；带缓存） ----------
let cachedStateJson = null;
function getStateJson() {
  if (!cachedStateJson) cachedStateJson = JSON.stringify(computeState());
  return cachedStateJson;
}
function invalidateState() { cachedStateJson = null; }

function computeState() {
  const sectionStats = sections.map((sec) => {
    const secRecords = records.filter((r) => r.sectionId === sec.id);
    const latest = new Map(); // 每设备每板块一条
    secRecords.forEach((r) => latest.set(r.deviceId, r));

    const qCounts = sec.questions.map((q) => {
      let correct = 0, wrong = 0;
      latest.forEach((r) => {
        r.answers.forEach((a) => {
          if (a.questionId === q.id) { if (a.correct) correct++; else wrong++; }
        });
      });
      const answered = correct + wrong;
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
        background: q.background,
        correct,
        wrong,
        answered,
        rate: answered ? Math.round(correct / answered * 100) : 0,
        correctAnswer: q.answer,
        explain: q.explain,
        options,
      };
    });

    return {
      id: sec.id,
      title: sec.title,
      subtitle: sec.subtitle,
      questionCount: sec.questions.length,
      participants: latest.size,
      questions: qCounts,
    };
  });

  return { updatedAt: Date.now(), sections: sectionStats };
}

// 构造某条记录的逐题答题结果
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
    questions: sec.questions.map((q) => ({ id: q.id, type: q.type, text: q.text, options: q.options, background: q.background })),
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

// 该设备在某板块的答题结果（再次扫码直接展示）
app.get('/api/my-result', (req, res) => {
  const device = String(req.cookies.device_id || req.query.deviceId || '').trim();
  const section = String(req.query.section || '');
  const rec = records.find((r) => r.deviceId === device && r.sectionId === section);
  if (!rec) return res.json({ submitted: false });
  const sec = sectionById(section);
  if (!sec) return res.json({ submitted: false });
  res.json({ submitted: true, results: buildResults(sec, rec) });
});

// 该设备累计统计（跨板块）
app.get('/api/my-stats', (req, res) => {
  const device = String(req.cookies.device_id || req.query.deviceId || '').trim();
  let total = 0, correct = 0;
  records.filter((r) => r.deviceId === device).forEach((r) => {
    correct += r.answers.filter((a) => a.correct).length;
    total += r.answers.length;
  });
  res.json({ total, correct });
});

app.post('/api/submit', (req, res) => {
  const { section, answers, deviceId } = req.body || {};
  if (!section || !Array.isArray(answers)) {
    return res.status(400).json({ ok: false, error: '参数错误' });
  }
  // 身份 = 设备（优先服务器 Cookie，兼容旧客户端传的 deviceId）
  const device = String(req.cookies.device_id || deviceId || '').trim();
  if (!device) return res.status(400).json({ ok: false, error: '设备标识缺失，请重新扫码进入' });

  const sec = sectionById(section);
  if (!sec) return res.status(404).json({ ok: false, error: '板块不存在' });

  // 同一设备同一板块限提交一次
  const existIdx = records.findIndex((r) => r.deviceId === device && r.sectionId === section);
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

  stmtInsertAnswer.run({
    deviceId: device,
    sectionId: section,
    ts,
    answersJson: JSON.stringify(answerList),
    correct,
    total: answerList.length,
  });

  const rec = { deviceId: device, sectionId: section, ts, answers: answerList };
  records.push(rec);
  invalidateState();

  res.json({ ok: true, results: buildResults(sec, rec) });
});

// ---------- 页面路由 ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/answer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'answer.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));

app.listen(PORT, () => {
  console.log('==============================================');
  console.log('  民法典宣讲答题系统已启动（大改版：无昵称、无排名）');
  console.log('  本机/公网访问: ' + (PUBLIC_URL || ('http://localhost:' + PORT)));
  console.log('  数据存储: SQLite 数据库 data/quiz.db');
  console.log('==============================================');
});

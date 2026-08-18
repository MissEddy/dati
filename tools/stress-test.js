#!/usr/bin/env node
/**
 * 压力测试脚本：模拟大量用户并发答题 + 高频查询，观察系统稳定性
 * 用法：
 *   BASE=http://localhost:3000 N=300 node tools/stress-test.js
 *   N     并发答题用户数（默认 200）
 *   BASE  服务地址（默认 http://localhost:3000）
 *   POLLS 并发查询 /api/state 的次数（默认 50）
 */
const BASE = process.env.BASE || 'http://localhost:3000';
const N = parseInt(process.env.N || '200', 10);
const POLLS = parseInt(process.env.POLLS || '50', 10);
const SECTION = process.env.SECTION || 'zz'; // 总则编，5 题，负载更重
const PREFIX = process.env.PREFIX || '';     // 批次前缀：多轮压测不删数据时用于区分昵称

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.json() };
}

async function main() {
  console.log(`=== 压测开始：BASE=${BASE} 并发答题=${N} 并发查询=${POLLS} 板块=${SECTION} ===`);

  // 1. 取该板块题目（生成答案用）
  const q = await fetchJson(`${BASE}/api/questions?section=${SECTION}`);
  if (!q.body.questions) { console.error('板块加载失败', q); return; }
  const questions = q.body.questions;

  // 2. 并发提交：N 个唯一用户同时答题
  const submitStart = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => {
    const answers = questions.map(qq => ({ questionId: qq.id, answer: pick(qq.options) }));
    const t0 = performance.now();
    return fetchJson(`${BASE}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `${PREFIX}压测用户${i + 1}`, section: SECTION, deviceId: `${PREFIX}dev-${i + 1}`, answers }),
    }).then(r => ({ ...r, ms: performance.now() - t0 }));
  }));
  const submitTotal = Date.now() - submitStart;
  const ok = results.filter(r => r.status === 200 && r.body.ok);
  const dup = results.filter(r => r.status === 409);       // 应无（昵称唯一）
  const fail = results.filter(r => r.status !== 200 && r.status !== 409);
  const times = results.map(r => r.ms).sort((a, b) => a - b);
  const pct = (p) => times[Math.floor(times.length * p)];
  console.log(`\n--- 提交结果 ---`);
  console.log(`总耗时(全部完成): ${submitTotal}ms | 吞吐: ${(N / (submitTotal / 1000)).toFixed(0)} 请求/秒`);
  console.log(`成功: ${ok.length} | 重复拦截: ${dup.length} | 失败: ${fail.length}`);
  console.log(`响应时间: 最小=${times[0].toFixed(0)}ms 平均=${(times.reduce((a, b) => a + b, 0) / N).toFixed(0)}ms p95=${pct(0.95).toFixed(0)}ms 最大=${times[times.length - 1].toFixed(0)}ms`);
  if (fail.length) console.log('失败样本:', JSON.stringify(fail.slice(0, 3)));

  // 3. 并发查询 /api/state（模拟多块大屏 1 秒轮询风暴）
  const pollStart = Date.now();
  const pollResults = await Promise.all(Array.from({ length: POLLS }, async () => {
    const t0 = performance.now();
    const r = await fetchJson(`${BASE}/api/state`);
    return { status: r.status, ms: performance.now() - t0 };
  }));
  const pollTotal = Date.now() - pollStart;
  const pollTimes = pollResults.map(r => r.ms).sort((a, b) => a - b);
  const pollFail = pollResults.filter(r => r.status !== 200).length;
  console.log(`\n--- ${POLLS} 次并发查询 /api/state（含 ${N} 条数据）---`);
  console.log(`总耗时: ${pollTotal}ms | 失败: ${pollFail}`);
  console.log(`响应时间: 最小=${pollTimes[0].toFixed(0)}ms 平均=${(pollTimes.reduce((a, b) => a + b, 0) / pollTimes.length).toFixed(0)}ms p95=${pollTimes[Math.floor(pollTimes.length * 0.95)].toFixed(0)}ms 最大=${pollTimes[pollTimes.length - 1].toFixed(0)}ms`);

  // 4. 一致性/健康检查：压测后新用户还能提交吗？状态对吗？
  const after = await fetchJson(`${BASE}/api/state`);
  const s = after.body.sections.find(x => x.id === SECTION);
  console.log(`\n--- 压测后一致性 ---`);
  console.log(`该板块参与者=${s ? s.participants : '?'}（应=${N}） 总答对=${after.body.totalCorrect} 总答题=${after.body.totalAnswered}`);
  const newUser = await fetchJson(`${BASE}/api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: `${PREFIX}压测后新用户`, section: SECTION, deviceId: `${PREFIX}dev-last`, answers: questions.map(qq => ({ questionId: qq.id, answer: pick(qq.options) })) }),
  });
  console.log(`压测后新用户提交: ${newUser.status === 200 && newUser.body.ok ? '成功 ✓' : '失败 ✗ ' + JSON.stringify(newUser.body)}`);
  console.log(`\n=== 压测结束 ===`);
}

main().catch(e => { console.error('压测脚本异常', e); process.exit(1); });

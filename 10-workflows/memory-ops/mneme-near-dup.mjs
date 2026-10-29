// 只读分析：活跃记忆里的语义近重复 + 归档体积构成。不改库。
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

// 库路径从环境推导，不硬编码用户名。可用 DSH_HOME 覆盖。
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const db = new DatabaseSync(process.env.MNEME_DB ?? path.join(DSH_HOME, 'memory', 'memory.db'));
const rows = db.prepare(`
  SELECT id, title, content, type, importance, archived, forgotten,
         length(content) AS clen, length(embedding) AS elen, embedding, created_at, updated_at
  FROM memories
`).all();

const act = rows.filter(r => r.forgotten === 0 && r.archived === 0);
const arc = rows.filter(r => r.archived === 1);

const sum = a => a.reduce((s, r) => s + (r.clen || 0), 0);
console.log('--- 体积构成 ---');
console.log(`活跃 ${act.length} 条 / ${(sum(act) / 1024).toFixed(1)} K 字符`);
console.log(`归档 ${arc.length} 条 / ${(sum(arc) / 1024).toFixed(1)} K 字符`);
console.log(`归档占正文体积 ${(sum(arc) / (sum(act) + sum(arc)) * 100).toFixed(1)}%`);
console.log('归档条中带向量的 =', arc.filter(r => r.elen > 0).length, '（归档不参与召回，这些向量是死重）');

// ---- 活跃条语义近重复 ----
const items = act.filter(r => r.elen > 0).map(r => ({
  id: r.id, title: (r.title || '').trim(), clen: r.clen, imp: r.importance,
  type: r.type, ts: r.updated_at || r.created_at,
  v: (() => { try { return Float32Array.from(JSON.parse(r.embedding)); } catch { return null; } })(),
})).filter(x => x.v && x.v.length === 512);

// 归一化（embedder 已 normalize，这里兜底）
for (const it of items) {
  let n = 0; for (let i = 0; i < it.v.length; i++) n += it.v[i] * it.v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < it.v.length; i++) it.v[i] /= n;
}

const pairs = [];
for (let i = 0; i < items.length; i++) {
  const a = items[i], va = a.v;
  for (let j = i + 1; j < items.length; j++) {
    const b = items[j], vb = b.v;
    let s = 0;
    for (let k = 0; k < 512; k++) s += va[k] * vb[k];
    if (s >= 0.85) pairs.push([s, a, b]);
  }
}
pairs.sort((x, y) => y[0] - x[0]);

const cnt = t => pairs.filter(p => p[0] >= t).length;
console.log('\n--- 活跃条语义近重复（余弦）---');
console.log('参与计算 =', items.length, '条');
console.log(`  ≥0.95: ${cnt(0.95)} 对 | ≥0.92: ${cnt(0.92)} 对 | ≥0.90: ${cnt(0.90)} 对 | ≥0.85: ${cnt(0.85)} 对`);

const show = (t, n) => {
  console.log(`\n===== 相似度 ≥${t} 的前 ${n} 对 =====`);
  for (const [s, a, b] of pairs.filter(p => p[0] >= t).slice(0, n)) {
    console.log(`\n${s.toFixed(4)}  ${a.id.slice(0, 8)} vs ${b.id.slice(0, 8)}`);
    console.log(`   A imp=${a.imp} len=${a.clen} ${a.type} ${a.ts}  ${a.title}`);
    console.log(`   B imp=${b.imp} len=${b.clen} ${b.type} ${b.ts}  ${b.title}`);
  }
};
show(0.92, 15);

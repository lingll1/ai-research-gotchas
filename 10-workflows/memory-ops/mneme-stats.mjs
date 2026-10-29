import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

// 库路径从环境推导，不硬编码用户名。可用 DSH_HOME 覆盖。
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const db = new DatabaseSync(process.env.MNEME_DB ?? path.join(DSH_HOME, 'memory', 'memory.db'));
const g = s => db.prepare(s).get();
const n = s => g(s).c;
console.log('总条数      =', n('SELECT COUNT(*) c FROM memories'));
console.log('活跃        =', n('SELECT COUNT(*) c FROM memories WHERE forgotten=0 AND archived=0'));
console.log('归档        =', n('SELECT COUNT(*) c FROM memories WHERE archived=1'));
console.log('活跃缺向量  =', n("SELECT COUNT(*) c FROM memories WHERE forgotten=0 AND archived=0 AND (embedding IS NULL OR embedding='')"));
console.log('归档带向量  =', n('SELECT COUNT(*) c FROM memories WHERE archived=1 AND embedding IS NOT NULL'), '（死重，不参与召回）');
console.log('活跃正文    =', n('SELECT SUM(length(content)) c FROM memories WHERE forgotten=0 AND archived=0'), '字符');
console.log('归档正文    =', n('SELECT SUM(length(content)) c FROM memories WHERE archived=1'), '字符');
// vector_meta 的列名随版本变过（model_hash / dimension 不一定都在），所以先探列再取值
const vmCols = db.prepare('PRAGMA table_info(vector_meta)').all().map(r => r.name);
const vm = db.prepare('SELECT * FROM vector_meta LIMIT 1').get();
console.log('向量台账列  =', vmCols.join(', ') || '(表不存在)');
console.log('向量台账    =', vm ? JSON.stringify(vm) : '(空表)');
const dup = db.prepare(`
  SELECT title, COUNT(*) c FROM memories
  WHERE forgotten=0 AND archived=0
  GROUP BY lower(trim(title)) HAVING c > 1
`).all();
console.log('活跃同标题组=', dup.length, '组');
db.close();

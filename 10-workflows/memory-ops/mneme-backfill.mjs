// 一次性 backfill：把记忆库里缺 embedding 的条目用本地 bge-small-zh 补齐，
// 并写入 vector_meta 的 model_hash/dimension（与插件内部算法完全一致）。
// 目的：插件自带的 autoReindexOnBoot 每次启动最多补 500 条（index.js:103 maxTotal=500），
// 上千条要多次启动才补完，所以在插件外一次性做完。
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 路径全部从环境推导，不硬编码用户名。可用 DSH_HOME / DSH_PROFILE / MNEME_DB 覆盖。
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const PROFILE = process.env.DSH_PROFILE ?? "desktop";
const MNEME = pathToFileURL(
  path.join(DSH_HOME, "profiles", PROFILE, "node_modules", "@modusensus", "dsh-mneme", "src")
).href;
const { LocalEmbedder } = await import(`${MNEME}/local-embedder.js`);

const DB = process.env.MNEME_DB ?? path.join(DSH_HOME, "memory", "memory.db");
const MODEL = "Xenova/bge-small-zh-v1.5";
const BATCH = 16;
const COMMIT_EVERY = 20; // batches

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 与 src/local-embedder.js hashString 完全一致的 djb2，保证 model_hash 指纹对得上
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
const fingerprint = `${MODEL}#${hashString(MODEL)}`;

const db = new DatabaseSync(DB);
db.exec("PRAGMA busy_timeout = 10000");

// 只补「活跃」记忆：store.js:1285/1313/1349 表明检索、embeddedCount、needsEmbedding
// 全部只看 archived=0 AND forgotten=0；归档行（3566 条）永远不会参与召回，
// 给它们算向量纯属烧 CPU。
const FILTER =
  "embedding IS NULL OR embedding = ''";
const ACTIVE = "forgotten = 0 AND archived = 0";
const todo = db.prepare(
  `SELECT id, title, content FROM memories WHERE (${FILTER}) AND ${ACTIVE}`
).all();
log(`待补齐 ${todo.length} 条（指纹 ${fingerprint}）`);
if (!todo.length) {
  log("无需 backfill");
  process.exit(0);
}

const emb = new LocalEmbedder({
  model: MODEL,
  dimension: 512,
  batchSize: BATCH,
  logger: { info: () => {}, warn: (m) => log("  [warn]", m) }
});
await emb.init();
log("embedder ready");

const update = db.prepare("UPDATE memories SET embedding = ?, updated_at = ? WHERE id = ?");
const t0 = Date.now();
let done = 0;
let failed = 0;
const now = () => new Date().toISOString();

for (let i = 0; i < todo.length; i += BATCH) {
  const chunk = todo.slice(i, i + BATCH);
  const texts = chunk.map((r) => `${r.title ?? ""}\n${r.content ?? ""}`.trim());
  let vectors;
  try {
    vectors = await emb.embed(texts);
  } catch (e) {
    failed += chunk.length;
    log(`  batch@${i} 嵌入失败：${e.message}`);
    continue;
  }
  db.exec("BEGIN");
  try {
    for (let j = 0; j < chunk.length; j++) {
      const v = vectors[j];
      if (!Array.isArray(v) || !v.length) { failed++; continue; }
      update.run(JSON.stringify(v), now(), chunk[j].id);
      done++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    failed += chunk.length;
    log(`  batch@${i} 写入失败：${e.message}`);
  }
  if ((i / BATCH) % COMMIT_EVERY === 0) {
    const secs = (Date.now() - t0) / 1000;
    log(`  进度 ${Math.min(i + BATCH, todo.length)}/${todo.length}  ${done} 条已写  ${secs.toFixed(0)}s  ${(done / secs || 0).toFixed(1)} 条/秒  rss ${Math.round(process.memoryUsage().rss / 1048576)}MB`);
  }
}

// 写指纹（与 vector-index.markModel 等价）
const meta = db.prepare(
  "INSERT INTO vector_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);
meta.run("model_hash", fingerprint);
meta.run("dimension", "512");
meta.run("updated_at", new Date().toISOString());

const left = db.prepare(
  `SELECT COUNT(*) c FROM memories WHERE (embedding IS NULL OR embedding = '') AND forgotten = 0 AND archived = 0`
).get().c;
const total = db.prepare("SELECT COUNT(*) c FROM memories WHERE forgotten = 0 AND archived = 0").get().c;
log(`完成：写入 ${done} 条，失败 ${failed}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
log(`库内：${total} 条记忆，仍有 ${left} 条无向量`);
db.close();

# 记忆库运维：统计 / 近重复 / 补齐向量 / 生产路径探针

针对 `dsh-mneme` 的 SQLite 记忆库（默认 `~/.dsh/memory/memory.db`）。四个脚本都只读或「只补向量」，不删数据。

## 先说一个最容易犯的错：用错入口

装了多个记忆插件时，它们的存储**互相独立**：

| 工具 | 属于 | 查的是哪个库 |
|---|---|---|
| `memory_recall` / `memory_remember` / `memory_index` | dsh-evolve | evolve 自己的库（字段有 `reinforcedAt`、`crystallizedAt`） |
| `memory_search` | dsh-mneme | `memory.db`，4600+ 条，带 512 维向量 |
| `hindsight_search_knowledge_pages` | Hindsight | 知识页，另一套 |

拿 `memory_recall` 去查 mneme 的库、看到空结果或低分，得出「检索是垃圾」的结论——这是最典型的误判。判断向量检索到底行不行，要用 `memory_search mode=vector`，并且**构造一个和记忆原文关键词完全不重合的问法**：关键词重合时 BM25 就能命中，看不出向量有没有工作。

真正的验证例子：查「后台脚本不能弹黑窗口 静默运行」，top1 命中「开机/登录自启动脚本必须无窗口静默运行」，top3 是「直调 powershell.exe 导致闪黑框」。三条词面完全不重合，纯语义命中。

## 四个脚本

### `mneme-stats.mjs` — 基准线

```bash
node mneme-stats.mjs
```

输出总条数 / 活跃 / 归档 / 活跃缺向量 / 归档带向量 / 正文字符 / 向量台账 / 活跃同标题组数。

改记忆库之前先跑一遍存个底。任何「优化」之后用它对比，否则你无法证明自己改好了还是改坏了。

### `mneme-near-dup.mjs` — 语义近重复扫描

```bash
node mneme-near-dup.mjs
```

把活跃条的 512 维向量两两算余弦，按阈值分档统计，并列出 ≥0.92 的前 15 对（带标题、长度、类型、时间）。只读，不改库。

**阈值怎么定**：实测一份 760 条活跃记忆的库，

| 阈值 | 对数 |
|---|---|
| ≥ 0.95 | 2 |
| ≥ 0.92 | 11 |
| ≥ 0.90 | 45 |
| ≥ 0.85 | **664** |

从 45 跳到 664——0.85 这个档位全是噪声，因为库里话题本来就集中（同一个人的同一个项目）。**可信阈值取 0.92**。这个数字不能照抄：换一个话题分散的库，0.85 可能就是对的。方法是看「哪一档开始数量暴涨」，暴涨的那一档就是噪声区。

**看标题查重是不够的**：同一件事换个说法，标题完全不同。反过来，标题相同但内容讲的是两回事（不同年份的同名考试、不同版本的同一份材料）也不该合并。余弦分数只是候选，最终要人读一遍。

### `mneme-backfill.mjs` — 补齐缺失向量

```bash
node mneme-backfill.mjs
```

找出 `embedding IS NULL` 的**活跃**条（`forgotten=0 AND archived=0`），用本地 bge-small-zh 逐批补上，同时写 `vector_meta` 的指纹。

**为什么需要它**：插件自带的 `autoReindexOnBoot` 每次启动最多补 500 条（`index.js:103` 的 `maxTotal=500`），几千条要十几次启动才补完。而且——这条是实测出来的——**批量写入的记忆不会自动算向量**。两次批量写入分别留下 7 条和 8 条共 15 条活跃记忆 `embedding` 为 NULL，时间戳集中在两个瞬间。这些条目在向量检索里等于不存在。

耗时参考：15 条约 1 秒（13.6 条/秒，rss 305 MB）。全量 760 条约 75 秒。

只补活跃条：归档条（3600 条左右）永远不参与召回，`store.js` 里检索/计数/`needsEmbedding` 全部带 `archived=0 AND forgotten=0` 条件。给它们算向量纯属烧 CPU。

### `mneme-prodpath-check.mjs` — 生产路径探针

```bash
node mneme-prodpath-check.mjs
```

走插件**真实的默认路径**（`defaultModelCacheDir` / `defaultRuntimeDir`）加载 ONNX，embed 两句话 + 一个查询，打印相似度，最后一行输出纯 ASCII 的：

```
PROBE_OK dim=512
```

这是给迁移脚本当判据用的。**验收标记必须是纯 ASCII**，原因见 [`../dsh-junction-migrate/`](../dsh-junction-migrate/)：曾经拿英文 `available` 去匹配 CLI 的中文输出「状态：可用」，碰上 GBK/UTF-8 乱码，判据永远不成立，导致迁移成功后自动回滚。

正常输出形如：

```
defaultModelCacheDir = <...>\models
defaultRuntimeDir    = <...>\runtime
vectors = 2 dim = 512
sim_self = 1.0000 sim_cross = 0.4231
sim_query = 0.5xxx
elapsed_ms = 469
PROBE_OK dim=512
```

`sim_self` 必须接近 1.0（自相似），`sim_cross` 明显低于它。两个值都接近 1 说明向量被退化成常量了。

## 表结构的两个坑

### `vector_meta` 是 key-value 表，不是宽表

第一版统计脚本写 `SELECT model_hash, dimension, updated_at FROM vector_meta`，直接报 `no such column: model_hash`。它只有两列：`key`、`value`。

```
key=model_hash   value=Xenova/bge-small-zh-v1.5#b9becc7f
key=dimension    value=512
key=updated_at   value=<ISO 时间>
```

正确写法是先探列再决定：

```js
const cols = db.prepare('PRAGMA table_info(vector_meta)').all().map(c => c.name);
const rows = db.prepare('SELECT * FROM vector_meta').all();
```

### 指纹必须和插件内部算法一致

`model_hash` 是 `模型名#djb2(模型名)` 的十六进制。自己拼错一个字符，插件就认为「模型换了」，触发全量重算。用与 `src/local-embedder.js` 里 `hashString` 完全相同的 djb2（`h = 5381; h = ((h<<5)+h+charCode) >>> 0`）。

## 已知的、没修的两个盲区

1. **关键词召回有 500 条截断**：`service.js:421-430` 的 `bm25Recall` 每次查询现建索引，但只取 `store.list({ limit: 500 })`。活跃记忆超过 500 条时，后面的条目进不了关键词通路（向量通路没有这个限制）。`limit` 是插件里的硬编码，改源码会破坏插件完整性校验，所以没动。
2. **归档条仍带向量**：约 1300 条归档记忆还挂着 embedding，是死重（十几 MB）。清掉不会缩小文件（SQLite 不自动回收页），而一旦 `unarchive` 又得重算，所以留着了。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_HOME` | `%USERPROFILE%\.dsh` | DSH 数据目录 |
| `DSH_PROFILE` | `desktop` | 哪个 profile 的 `node_modules` 里找插件 |
| `MNEME_DB` | `<DSH_HOME>\memory\memory.db` | 库路径 |

## 改库之前

先备份三件套，缺一个就可能恢复不了：

```powershell
Copy-Item memory.db, memory.db-wal, memory.db-shm -Destination <backup-dir>
```

WAL 模式下 `memory.db` 单独拷出来可能是旧状态，正在写的内容在 `-wal` 里。

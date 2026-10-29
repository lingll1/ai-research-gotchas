// 生产路径自检：走 mneme 插件真实的默认路径（defaultModelCacheDir / defaultRuntimeDir），
// 验证 junction 迁移后 embedder 仍能加载并产出向量。不读写记忆库，纯隔离探针。
// 最后一行输出 PROBE_OK dim=<n> 供迁移脚本做纯 ASCII 匹配（避免中文/编码导致的误判）。
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 路径全部从环境推导，不硬编码用户名。可用 DSH_HOME / DSH_PROFILE 覆盖。
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE ?? 'desktop';
const MNEME = pathToFileURL(path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', '@modusensus', 'dsh-mneme', 'src')).href;
const t0 = Date.now();
const { LocalEmbedder } = await import(`${MNEME}/local-embedder.js`);
const layout = await import(`${MNEME}/runtime/layout.js`).catch(() => ({}));
if (layout.defaultModelCacheDir) console.log('defaultModelCacheDir =', layout.defaultModelCacheDir());
if (layout.defaultRuntimeDir) console.log('defaultRuntimeDir   =', layout.defaultRuntimeDir());

const e = new LocalEmbedder({ logger: { warn: (...a) => console.log('[warn]', ...a), info() {}, debug() {} } });
await e.init();
const texts = ['开机自启动不能闪黑窗', 'C 盘固态出现 IO 重试'];
const vecs = await e.embed(texts);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const q = await e.embed(['怎么让后台脚本不弹窗口']);
console.log('vectors =', vecs.length, 'dim =', vecs[0].length);
console.log('sim_self =', dot(vecs[0], vecs[0]).toFixed(4), 'sim_cross =', dot(vecs[0], vecs[1]).toFixed(4));
console.log('sim_query =', dot(q[0], vecs[0]).toFixed(4));
console.log('elapsed_ms =', Date.now() - t0);
if (Array.isArray(vecs[0]) && vecs[0].length > 0) console.log(`PROBE_OK dim=${vecs[0].length}`);
else { console.log('PROBE_FAIL'); process.exitCode = 9; }

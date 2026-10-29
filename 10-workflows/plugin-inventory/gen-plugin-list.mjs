import fs from 'node:fs';
import path from 'node:path';

import os from 'node:os';

// 路径全部从环境推导，不硬编码用户名。
// DSH_HOME 默认 ~/.dsh；OUT 默认写到当前目录的 插件清单.md
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const PROFILE_ROOT = path.join(DSH_HOME, 'profiles');
const OUT = process.env.PLUGIN_LIST_OUT ?? path.join(process.cwd(), '插件清单.md');
const B = '`'; // 反引号常量，避免在模板里手写转义

const profiles = ['desktop', 'web', 'mirage'];
const md = [];
const P = (...xs) => md.push(...xs);

P('# 插件清单（仅来源关联，不含插件代码）', '');
P(`导出时间：**${new Date().toISOString().slice(0, 10)}**（实时读取 \`package.json\` + \`node_modules/<包名>/package.json\` 生成）`, '');
P('口径：**插件只做来源仓库关联，私人插件另外上传**。');
P('本文件只记录「装了哪些插件、从哪来、实际解析到哪个版本」，不复制任何插件源码。', '');
P('来源标记的含义：', '');
P('| 标记 | 含义 |', '|---|---|');
P('| `github:owner/repo` | 来自 GitHub 公开仓库，可 `dsh plugin add` 复装 |');
P('| `link:路径` | 本机自研插件，源码在本机某个目录，**不在本仓库内** |');
P('| 版本号 | npm 上的包，按版本号可复装 |');
P('| `https://codeload…/tar.gz` | 从 GitHub tag 直接打包安装（不在 npm 上） |', '');
P('「实装版本」是从 `node_modules/<包名>/package.json` 读出的**实际解析结果**，与声明的 spec 可能不同（`^` 范围升级、`link:` 指向本地目录）。', '');

const stats = {};
const uniqLink = new Set();

for (const prof of profiles) {
  const root = path.join(PROFILE_ROOT, prof);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    P(`## profile：${B}${prof}${B} —— 读不到 package.json`, '');
    continue;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const names = Object.keys(deps).sort((a, b) => a.localeCompare(b));
  const cnt = { link: 0, github: 0, npm: 0, tar: 0 };
  const rows = [];

  for (const name of names) {
    const spec = String(deps[name]);
    let ver = '—';
    try {
      ver = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch {
      ver = '*(未解析)*';
    }
    const t = spec.startsWith('link:') ? 'link'
      : spec.startsWith('github:') ? 'github'
      : spec.startsWith('http') ? 'tar' : 'npm';
    cnt[t]++;
    if (t === 'link') uniqLink.add(spec.slice(5));
    rows.push(`| ${B}${name}${B} | ${B}${spec}${B} | ${ver} |`);
  }

  stats[prof] = { total: names.length, ...cnt };
  P(`## profile：${B}${prof}${B}（依赖 **${names.length}** 个：npm ${cnt.npm} / link ${cnt.link} / github ${cnt.github} / tar ${cnt.tar}）`, '');
  P('| 插件 | 来源 | 实装版本 |', '|---|---|---|', ...rows, '');
}

P('## 汇总', '');
P('| profile | 依赖总数 | npm | link（本机自研） | github | tar |', '|---|---|---|---|---|---|');
for (const prof of profiles) {
  const s = stats[prof];
  if (!s) continue;
  P(`| ${B}${prof}${B} | ${s.total} | ${s.npm} | ${s.link} | ${s.github} | ${s.tar} |`);
}
P('');

const all = Object.values(stats).reduce((a, s) => a + s.total, 0);
P(`去重口径：三个 profile 的依赖条目合计 **${all}** 条；本机自研（${B}link:${B}）**唯一目录 ${uniqLink.size} 个**：`, '');
for (const d of [...uniqLink].sort()) P(`- ${B}${d}${B}`);
P('');

fs.writeFileSync(OUT, md.join('\n'), 'utf8');
console.log('写入 ' + OUT);
console.log('行数 ' + md.length);
console.log(JSON.stringify(stats));
console.log('唯一 link 目录 ' + uniqLink.size);

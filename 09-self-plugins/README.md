# 09 · 自研插件（源码分发）

## 为什么只有三个

本机 23 个 `link:` 插件目录，逐个查过上游：

| 结论 | 数量 | 处理 |
|---|---|---|
| GitHub 有同名上游 | 17 | 只记来源 → [`../08-plugin-sources/`](../08-plugin-sources/) |
| GitHub 查不到、确实是本机写的 | 3 | 源码放这里 |
| 上游不明、价值低未整理 | 3 | 不处理 |

判断「有没有改过上游」时有个坑：`git status` 会报几十到两百多项改动，看着像重度魔改，实际几乎全是 LF→CRLF 噪声。必须 `git diff --ignore-all-space --stat` 才是真实改动——`dsh-toolkit` 从 253 项降到 1 文件 2 行。详见 [`../08-plugin-sources/README.md`](../08-plugin-sources/README.md)。

## 装法

三个都是源码目录，未发布 npm（`package.json` 里 `private: true`）。把目录放到你的插件源码根，然后 link 安装：

```bash
dsh plugin add link:/path/to/dsh-v4-source-guard
dsh plugin add link:/path/to/dsh-watchdog-keeper
dsh plugin add link:/path/to/dsh-web-fetch-local
```

`link:` 安装不会复制代码，指向即生效——改完源码重启 DSH 就生效，不需要重装。代价是这个目录不能删、不能移动。

---

## dsh-v4-source-guard · 1.0.1

**解决什么**

DSH 的 session format v4 里，历史消息的 `source` 字段可能是 `{kind: 'plugin', plugin: 'X'}`。一旦卸载插件 X，旧会话里仍留着这个 kind，下次加载时校验不过 → **整个会话打不开**。症状极容易误判成「会话文件损坏」，实际只是插件没了。

这个插件在 `Session.append` 边界把退役的 source 归一化，让「卸载插件 → 想装回去」不再毁掉历史会话。

**范围**：只动 session append 路径上的 source 归一。不改消息正文、不改存储格式、不做数据迁移、不删除任何历史。

**限制**

- 依附宿主的 `Session.append` 钩子。DSH 大版本改了这个 seam 就得跟一次。
- 归一化是**保守重写**：认不出的 `kind: 'plugin'` 降级成通用来源，不猜「原本是哪个插件」——猜错比不猜更危险。
- 只在写入时归一，**已存在的坏会话不会自动修好**。要修历史得单独跑一个修复脚本（`DSH_V4_FIX_SCRIPT` 指向的就是那个入口）。

**上传版改了什么**：原版硬编码了用户的 profile 目录（唯一含用户名的点）和本机的修复脚本路径，现在两个都从 `DSH_V4_PROFILE` / `DSH_V4_FIX_SCRIPT` 环境变量读，而且**默认空**。空 = 跳过修复脚本这步，内存里的归一化照常工作——因为修复脚本是站点特定的，给不出通用默认值。这样比填一个「看起来像默认」的路径安全：填错的默认值会让插件静默地去改错目录。

---

## dsh-watchdog-keeper · 0.2.0

**解决什么**

DSH server 悄悄崩了，人还在等回复。这个插件从 server 内部读 watchdog 的心跳文件，暴露一个状态路由，并在状态翻转时记日志。

**默认 monitor-only**：只监控 + 暴露状态，**不保活、不复活**。要自动拉起必须显式配 `keepalive: true`。

为什么默认不开：自动复活会掩盖「为什么反复崩」。如果崩溃根因是插件冲突，自动拉起来只会变成重启循环，比停着更难查。先看清楚再决定要不要自动化。

**范围**：只读心跳文件 + 记录状态翻转。不接管进程生命周期，不 kill、不重启、不拉其他进程。

**限制**

- 心跳文件路径**没有默认值，必须自己配**（`heartbeatPath`）。空值时插件保持加载但不做事，只记一行「未配置」——指向一个从未存在过的路径会永远报「已死」，比老实说不干活更糟。
- 保活脚本路径同理；`keepalive: true` 但没配 `script` 会自动降级成 monitor-only 并说明原因（否则 powershell 会收到 `-File ""`）。
- 心跳文件不存在时按「未知」处理，不当作「已死」——两者要区分，否则第一次装就误报。
- 带单测：`node --test test/keeper.test.js`。

---

## dsh-web-fetch-local · 1.0.0

**解决什么**

给 web seam 注册一个最小的 `WebFetchProvider`，用 Node 内置 `fetch` 抓 URL，**带 SSRF 护栏**。

**护栏做了什么**：loopback、`10.x`、`172.16–31`、`192.168`、`169.254`、IPv6 ULA / link-local、`localhost` 一律拒；域名先 `dns.lookup({all:true})` 解析，逐个 IP 查，命中私网就拒。只放行 `http:` / `https:`。

**限制（重要，都是真实缺口）**

1. **重定向没复查**：`redirect: 'follow'`，私网检查只做在首次 URL 上。一个公网 URL 302 到 `127.0.0.1` 是能穿过去的。要补就在 `fetch` 里手动跟 3xx 并每次复查。
2. **DNS rebinding 窗口**：解析与请求是两次独立动作，恶意 DNS 可以在中间换 IP。单人 / 家用场景可接受，多租户场景不够。
3. **无 JS 渲染**：抓 SPA 只得到空壳 HTML。要渲染用 `dsh-browser-cdp`。
4. **无 cookie / 登录态**，不带任何凭据。
5. 200,000 字符截断，超出标 `truncated: true`。
6. 只判 `content-type` 含 `text/html` 为 `html`，其余一律 `text`——不解析、不转 markdown。

这个插件是「够用就行的本地兜底」，不是通用抓取器的替代品。

---

## 许可

本目录下**代码**以 **PolyForm Noncommercial License 1.0.0** 发布（见 [`LICENSE`](LICENSE)）：可自用、可修改、可分发，**不可商业使用**。

仓库其余部分（文档、踩坑条目）以 CC BY-NC-SA 4.0 发布（见仓库根 `LICENSE`）。

两者都不允许商业使用，区别在代码用 PolyForm 更合适——CC 系列没有处理专利授权，且对「源码 / 目标码」的界定在软件场景是模糊的。

`dsh-watchdog-keeper` 原带 MIT LICENSE，已按统一口径移除。

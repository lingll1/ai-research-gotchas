# dsh-v4-source-guard

运行时护栏：阻止任何插件把 **v4 会话格式已退役的消息来源** `{ kind: "plugin", plugin: "<name>" }` 写进会话日志。

## 它解决什么

DSH 0.1.7 的会话格式 v4 只接受「生产者自有」的 source kind。第三方插件（graphflow、hindsight、upstream-radar 等）仍在注入 v3 形状的消息源：

```js
source: { kind: "plugin", plugin: PLUGIN_ID, form: "instructions" }
```

写侧不校验，所以这类行能落盘；读侧（`dsh-session-format-v3-to-v4` 的 artifact 校验）才抛
`format v4 message requires a producer-owned source kind`，表现为「能进 UI、一发消息就 本轮运行失败」。

历史做法是用 `D:\dsh\fix-v4-source-kind.py` 逐个改插件文件——但插件装/更新（插件管理页、`dsh plugin add`）会把文件还原，补丁丢失，于是反复复发（第 4 次）。

本插件改用**运行时收口**：所有消息最终都经由 `Session.prototype.append` 落盘，护栏在这一层做规范化。插件文件被还原也不影响——它产生什么形状，落盘的永远是 v4 合法形状。

## 机制

1. `inject = ["sessions"]`，拿到 `SessionStore`。
2. 包住 `Session.prototype.append(type, data, ...opts)`：按 v4 的消息槽位取出消息对象
   （`user/message` → data 本身；`developer|system|assistant/message`、`tool/result` → `data.message`；
   `agent/inbox/spliced` → `data.inserted[]`；`session/title-llm-request` → `data.messages[]`）。
3. 只有 `source.kind === "plugin"` 时改写：丢弃 `plugin` 字段，换成生产者自有 kind。
4. 映射表与内核 v3→v4 迁移完全一致（逐字照抄 `dsh-session-format-v3-to-v4/lib/index.js`）：
   - `RENAMED_PRODUCERS`（compact→compact-checkpoint、tools-code-mode/tools-ptc→ptc-mode、dsh-compaction-basic→compact-basic、@deepseek-ai/dsh-system-prompt→runtime-context）
   - `RELEASED_SAME_NAME_PRODUCERS`（25 个已发布的同名生产者，保持原名）
   - `@deepseek-ai/dsh-system-prompt` + role=system → `system-prompt`
   - 其余 → `plugin:<plugin>`
5. 已存在会话（`sessions.list()`）、新建/分叉/恢复（包 `prepare`/`fork`）、以及 `session/event` 兜底，都打上补丁；`ctx.effect` 在卸载/HMR 时还原描述符，可重复应用。
6. 幂等：同一原型只包一次（`Symbol.for("dsh-v4-source-guard/patched")`），非裸 source 原样返回同一引用（不复制、不改身份）。
7. 任何异常都退回原始数据（`try/catch` → 原样 append），**不会**因为护栏让一轮对话失败。
8. 启动时还会异步补文件：`apply()` 2 秒后调用
   `python D:\dsh\fix-v4-source-kind.py --profile C:\Users\lin\.dsh\profiles\desktop`
   （`python` 不在 PATH 时回退 `py -3`；脚本不存在则跳过）。这样插件管理页装/更新后，
   即使没人手动跑修复，下一次启动也会把被 pnpm store 还原的文件重新打上补丁。
   路径可用 `DSH_V4_FIX_SCRIPT` / `DSH_V4_PROFILE` 覆盖（测试用）。

## 三层防护

1. **启动器预修**：`D:\dsh\start-dsh-desktop.ps1` 在启动桌面端之前先跑
   `fix-v4-source-kind.py --profile ...\desktop`，让本次启动加载的就是已修文件。
2. **运行时护栏**：本插件的 `append` 收口，插件文件被还原也不会写出非法 source。
3. **启动自愈**：本插件启动 2 秒后自动重跑文件修复，覆盖不走启动器的启动路径；
   本次启动由第 2 层兜底，下次启动文件已干净。

## 安装

```
plugin_manager install_bundle  target=D:\dsh\dsh-v4-source-guard
```

新装 bundle 走 HMR 直接生效（`application: "applied"`），不需要重启客户端。
桌面端建议通过 `D:\dsh\start-dsh-desktop.ps1`（或桌面快捷方式）启动；它会先跑文件修复，
再跑版本守卫，最后启动应用。

## 验证

```powershell
# 1) 静态：插件文件已无裸生产者（本护栏不依赖它，但保持干净）
py -3.12 D:\dsh\scan-v4-source-kind.py --profile C:\Users\lin\.dsh\profiles\desktop

# 2) 运行时：会话日志里 source kind 全合法
py -3.12 D:\dsh\.v4-guard-tests\scan-session.py "C:\Users\lin\.dsh\sessions\--D-dsh--\<session-id>\session.v4.jsonl.zstd"

# 3) 离线自测：10 项断言（假 Session/SessionStore）
& "C:\Program Files\nodejs\node.exe" D:\dsh\.v4-guard-tests\guard-selftest.mjs

# 4) 启动器预修：看日志中的 v4 fix 行
Select-String -Path D:\dsh\desktop-launcher.log -Pattern 'v4 fix|\[FIXED\]|\[PATTERN-MISSING\]'
```

自愈测试（不重启桌面端）：把 `D:\dsh\_work\v4-heal-test` 当作假 profile，在其中放一份
未修补的 `@roarpeng/graphflow/dsh/plugin.mjs`，用 `DSH_V4_PROFILE` 指向它加载本插件，
2 秒后检查文件里出现 `plugin:${PLUGIN_ID}` 和 `"plugin:graphflow-dsh"`。

实测（2026-10-18）：一个故意注入 v3 形状 source 的探针插件 `dsh-v4-repro` 触发后，落盘行是

```
type=user/message seq=809 source={"kind": "plugin:v4-repro", "form": "instructions"}
```

整份会话日志 `bare_kind_plugin=0`，该轮对话正常完成。

## 边界

- **扫描器会对本插件报几条 READER 提示**（注释里提到 `plugin` 这个字面量、以及 `index.js` 里的 `const RETIRED_KIND = "plugin"` 命中了「任意 `"plugin"` 字面量」的正则）。那是给人复核用的提示、不是生产者判定，`PRODUCER total` 仍为 0；不要为了消掉它把常量写成拼接字符串。
- **只管写侧**。已经写进旧会话文件的裸 source 行不会因此变合法；那些历史会话被恢复/校验时仍可能报原错误（需要单独修日志）。
- 不认识 source 形状的事件类型原样放行（保持数据身份不变），不会误改工具结果、inbox 之外的结构。
- 护栏本身是 profile 里的一个 bundle；把 profile 整个重置、或卸载本 bundle，护栏即失效（此时回退到「跑 `fix-v4-source-kind.py` 改文件」的旧办法）。
- `fix-v4-source-kind.py` 仍然有用：它让插件**自己**产出合法形状，是纵深防御的第一层；护栏是第二层，负责插件被还原时的兜底。

## 卸载

```
plugin_manager remove_bundle  dsh-v4-source-guard
```

`ctx.effect` 注册的清理函数会还原 `append` 描述符，无需重启。

# 10 · 工作流脚本

这里的脚本都是**踩完坑的成品**，不是示例代码。共同背景：Windows、要给一个长时间在线的 AI 宿主做运维、而且**不能弹窗打扰人、不能把自己搞死**。

## 目录

| 子目录 | 解决什么 | 最贵的一课 |
|---|---|---|
| [`silent-autostart/`](silent-autostart/) | 计划任务 / 开机自启静默无黑窗 | `powershell -WindowStyle Hidden` **不可靠**：标志在控制台分配之后才生效，照样闪 |
| [`dsh-junction-migrate/`](dsh-junction-migrate/) | 把大目录搬到别的盘 + 重启宿主 | DLL 被 mmap 就删不掉（提权无效）；迁移脚本绝不能活在宿主进程树里 |
| [`memory-ops/`](memory-ops/) | 记忆库统计 / 近重复扫描 / 补齐向量 | 向量台账是 key-value 表不是宽表；批量写入**不会自动算向量** |
| [`plugin-inventory/`](plugin-inventory/) | 从 profile 生成插件来源清单 | `git status` 的几百项改动几乎全是 LF→CRLF 噪声 |
| [`disk-health/`](disk-health/) | 磁盘 SMART + 系统事件巡检 | 要盯「趋势和变化点」，不是绝对值 |

## 通用前提

**PowerShell 7**。路径 `C:\Program Files\PowerShell\7\pwsh.exe`，脚本里用 `PWSH_EXE` 环境变量可覆盖。Windows PowerShell 5.1 处理 BOM-less UTF-8 和类 Unix 路径的坑足够多，不值得省这一次判断。

**`.ps1` 带中文必须写 UTF-8 BOM**。不带 BOM 时，5.1 会按本地代码页解，中文变乱码；部分编辑器也会。用 `New-Object System.Text.UTF8Encoding($true)` 写，不要手拼 `\ufeff`。

**.vbs 必须纯 ASCII**。它在任何代码页下都可能被 `wscript.exe` 读，注释里写中文会在某些区域设置下直接语法错误。

**路径不硬编码**。所有脚本的路径都走「参数 → 环境变量 → 默认值」三级，默认值避开用户名。本机实际用法放在文档里说明，不写在代码里。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `PC_TUNE_DIR` | 运维脚本与日志的存放目录 | `%LOCALAPPDATA%\dsh-tune` |
| `DSH_HOME` | DSH 数据目录 | `%USERPROFILE%\.dsh` |
| `DSH_MNEME_TARGET` | 迁移目标目录（**必须给**） | 无 |
| `DSH_EXE` | DSH 可执行文件 | `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe` |
| `PWSH_EXE` | PowerShell 7 路径 | `C:\Program Files\PowerShell\7\pwsh.exe` |
| `MNEME_PROBE` | 探针脚本路径 | `../memory-ops/mneme-prodpath-check.mjs` |

## 一条总原则

**这些脚本都会动到你正在运行的东西。** 所以每一份都按同一个模式写：

1. 有 `-CheckOnly` 或 dry-run，先看清楚再动手
2. 每一步失败都有回滚，且回滚本身不依赖前面的成功
3. 「成功」的判据必须是**能证伪的**——真实读一个字节、跑一次推理、出现主窗口，而不是「命令没报错」

第 3 条最容易糊弄自己。本仓库里有两处反面教材：拿英文 `available` 去匹配中文 `状态：可用`（乱码必不匹配），和拿一个恒为 `unknown` 的字段当判据。两次都导致「迁移明明成功却自动回滚」。

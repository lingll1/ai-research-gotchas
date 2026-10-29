# 08 · DSH 插件来源对照表

本机 DSH 装了大量插件。这一目录**不复制插件代码**，只记录「装了什么、从哪来、该不该跟」。

## 为什么不放代码

三个理由，缺一不可：

1. **版权**。绝大多数插件是别人写的，npm 包或 GitHub 仓库，重复分发等于二次发行，无论许可宽不宽松都不该由我代劳。
2. **会腐烂**。上游一更新，仓库里复制的副本就是死代码。半年后有人 clone 下来，装到的是半年前的 bug 版本，比不装更糟。
3. **没必要**。`dsh plugin add <spec>` 一条命令就能拿到上游最新版，源码分发没有增量价值。

只有一种情况才打包代码：**GitHub 上查不到上游、确实是本机写的**——那部分在 [`../09-self-plugins/`](../09-self-plugins/)。

## 怎么复装

```bash
# npm 上的包（版本号即来源）
dsh plugin add dsh-context@0.56.2

# GitHub 仓库
dsh plugin add github:owner/repo

# GitHub tag 打包（不在 npm 上发布的那种）
dsh plugin add https://codeload.github.com/owner/repo/tar.gz/refs/tags/v1.1.78
```

装之前先读 [`../05-plugins/`](../05-plugins/)：DSH 插件的冲突几乎全部来自**同一个扩展点被两个插件抢**（同名 tool、同名 slot、同一个 `cordis.patch.yml` 键）。装之前跑一遍冲突预检，比装完崩了再回滚便宜得多。

`cordis.patch.yml` 的 `config` 是**整体替换不是深度合并**——两个插件写同一个键，后装的会把先装的整块配置覆盖掉。

## 空白 DSH 应该装什么

按「装上去立刻有用、且不改变客户端外观」筛选。这份清单假设你要的是一个能干活的 DSH，不是装修过的 DSH。

### 第一档：记忆与上下文

DSH 默认没有跨会话记忆。这一档解决「上次说的事这次还记得」。

| 插件 | 作用 | 备注 |
|---|---|---|
| `@modusensus/dsh-mneme` | 长期记忆（SQLite + 向量检索） | 核心。支持本地 ONNX embedding，见 [`../07-local-ai/local-embedding-memory.md`](../07-local-ai/local-embedding-memory.md) |
| `billion-context` | 上下文压缩（让长会话不爆窗口） | 与本仓库的压缩并行，不冲突 |
| `dsh-context` | `/context` 一类显式上下文管理 | 偏手动，用得少但需要时救命 |
| `@vectorize-io/hindsight-coding-agents` | 把仓库历史/决策沉淀成知识页 | 记忆的另一条腿：结构化的「本项目为什么这样」 |
| `dsh-evolve` | 把重复出现的工作模式结晶成 skill | 需要先有记忆条目才有效果 |

**注意**：这几个的记忆库**互相独立**。用 `memory_recall` 查 mneme 的库必然返回空或噪声，用 `memory_search` 查 dsh-evolve 的库同理。这个坑单独记在 [`../05-plugins/`](../05-plugins/) 里——「用错入口得出『检索是垃圾』的结论」是最常见的误判。

### 第二档：干活能力

| 插件 | 作用 |
|---|---|
| `dsh-office-tools` | docx / xlsx / pptx 读写。批量改 PPT 的地基，见 [`../07-local-ai/pptx-batch.md`](../07-local-ai/pptx-batch.md) |
| `dsh-browser-cdp` | 接一个真浏览器（CDP），比无头抓取稳 |
| `dsh-computer-use-win` | Windows UI Automation：找窗口、读控件树、点按钮。UIA 失明的程序还有 OCR 兜底 |
| `dsh-wsl` | WSL 命令通道，跨 Windows/Linux 不用切窗口 |
| `dsh-gitbash-shell` | 有 bash 语义的 shell，路径转换比 pwsh 顺手 |
| `dsh-deepread` | 大文件分段读，避免一次塞爆上下文 |
| `dsh-cost-meter` | 看 token 花在哪。长会话排查成本异常时唯一可信的尺子 |
| `dsh-tool-normalizer` | 抹平工具入参差异，减少「同义工具选错」 |

### 第三档：运维与自检

| 插件 | 作用 |
|---|---|
| `dsh-plugin-guard` | 装插件前后的一致性检查 |
| `dsh-ops-health` | 运行时健康快照（内存、事件循环、插件加载失败） |
| `dsh-watchdog-keeper` | 看守进程。源码在本仓库 [`../09-self-plugins/dsh-watchdog-keeper/`](../09-self-plugins/dsh-watchdog-keeper/) |
| `dsh-v4-source-guard` | 防止 profile 关键配置被静默改坏。源码在 [`../09-self-plugins/dsh-v4-source-guard/`](../09-self-plugins/dsh-v4-source-guard/) |
| `upstream-radar` | 追上游版本，判断「该不该升级」而不是「有没有新版」 |

### 明确不跟装的

**客户端 UI 个性化类**（本机在用，但不建议照抄）：

`@linxin666/dsh-client-ui-*`（git-graph / skill-explorer / task-board / web-ui-settings）、`dsh-composer-pin`、`dsh-settings-tidy`、`dsh-ui-tweaks`、`dsh-better-sidebar`、`dsh-whale-widget`、`dsh-plugin-wallpaper-engine`

理由不是它们不好，而是：这类插件改客户端 DOM 与布局，**DSH 每次升级前端都可能让它们碎**；碎了之后症状是「界面某块消失了」，很难第一时间归因到插件。而且它们解决的是审美问题，不是能力问题，别人跟着装大概率是负担。

**对抗与安全测试类**：不收录、不提供安装指引。

**一个已经死掉的**：`@deepseek-ai/dsh-experimental-plugin-market-bundle@0.2.1-alpha.4` 在本机装不上（依赖解析失败）。空白 DSH 用 `dshmarket` 或 `dsh-extension-hub` 代替。

## 完整清单

三档之外还有几十个插件（编辑器桥、搜索、格式转换、远程访问等），全表在 [`来源清单.md`](来源清单.md)，带来源标记与实装版本。

## 本机自研（`link:`）插件怎么处理

本机 23 个 `link:` 目录，逐个查过上游：

| 情况 | 数量 | 处理 |
|---|---|---|
| GitHub 有同名上游 | 17 | **只记来源**，代码不传（本机改动多为 CRLF 噪声，见下） |
| GitHub 无上游、本机自写 | 3 | 打包 → `../09-self-plugins/` |
| 上游不明但价值低 | 3 | 不处理 |

### 一个必须知道的判断陷阱

查「本机有没有改过上游」时，`git status` 会报几十到两百多项改动，看起来像重度魔改。实际几乎全是 **LF → CRLF 噪声**：文件在 Windows 上被检出成 CRLF，而 `core.autocrlf=false` 让 git 把换行符差异当成内容差异。

真实改动必须这样看：

```bash
git diff --ignore-all-space --stat
```

实测：`dsh-toolkit` 从 253 项降到 1 文件 2 行；`dsh-plugin-check` 从 50 项降到 5 文件 13 行；`dsh-ops-health` 降到 0。

**先忽略空白再判断有没有改过**，否则会把「上游代码 + 换行符」误当成自己的作品，然后打包分发别人的代码。

## 许可

本目录下的文字以 CC BY-NC-SA 4.0 发布（见仓库根 `LICENSE`）。**它不覆盖任何插件的代码**——那些代码的许可由各自的上游仓库决定，这里只是指路。

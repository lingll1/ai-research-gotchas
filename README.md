# AI 辅助科研与工具链踩坑合集

> 一个把「真踩过、真修过」的坑整理成可复用条目的仓库。
> 目标不是罗列知识，而是让下一个人（或者明天的自己）少花那两小时。

## 这是什么

三类内容混在一起：**做科研时的判断纪律**、**检索与文献的实际路径**、**AI 编码环境里的技术陷阱**。
每条尽量写清四件事：

| 字段 | 含义 |
|---|---|
| **现象** | 你看到什么、报什么错 |
| **根因** | 为什么会这样（不是"重试一下就好了"） |
| **做法** | 实际有效的操作，可直接抄 |
| **边界** | 这个结论在什么条件下成立、什么时候会失效 |

**"边界"是最重要的一栏。** 一条没有边界的经验，换个环境就是新的坑。

## 分类

### [01 科研方法](./01-research/)

- [验证纪律：没核实的不许写成事实](./01-research/verification-discipline.md) —— 证据分级、口径声明、列必引
- [先证伪自己，再怀疑环境](./01-research/falsify-yourself-first.md) —— 测试通路为什么不能与被测对象共用假设
- [改了文件 ≠ 已在跑](./01-research/reloaded-vs-changed.md) —— mtime 比对与线上探针
- [数据可复现：把脚本的结论从代码里赶出去](./01-research/no-hardcoded-conclusions.md) —— 为什么判决类文字必须现算

### [02 检索与文献](./02-search-literature/)

- [中文数据库为什么"连不上"，以及怎么绕](./02-search-literature/chinese-databases.md) —— 首页可达但检索被反爬的真相
- [DOI 核验与开放学术接口的限流脾气](./02-search-literature/doi-and-open-apis.md) —— Crossref / OpenAlex / Semantic Scholar / DOAJ 实测
- [参考文献：列必引，引必核](./02-search-literature/reference-rules.md) —— 悬空条目与格式一致性

### [03 标准格式](./03-formats/)

- [中文公文格式（GB/T 9704—2012）实务值](./03-formats/gb-t-9704-2012.md) —— 字号、行距、字体的实测取值，以及"仿宋_GB2312"这个常见误传
- [Markdown → docx → PDF 流水线](./03-formats/docx-pdf-pipeline.md) —— 字体嵌入、逐格 diff、页数校验

### [04 技能（Skills）](./04-skills/)

- [写一个能被正确触发的 skill](./04-skills/writing-a-skill.md) —— 描述怎么写给检索看，正文怎么写给执行看
- [示例：文献核验 skill](./04-skills/examples/reference-check.md) —— 一个可复制改写的骨架

### [05 插件与 MCP](./05-plugins/)

- [MCP Server 接不上的三个真实原因](./05-plugins/mcp-server-setup.md) —— realpath、npx 进程链、环境变量白名单
- [装插件之前先做预检](./05-plugins/preflight-checklist.md) —— 配置是"整体替换"不是"深度合并"

### [06 工具链](./06-toolchain/)

- [PowerShell 编码与转义：BOM、反引号、双引号](./06-toolchain/powershell-encoding.md) —— 中文注释导致语法报错的全过程
- [Git 与代码托管平台的坑](./06-toolchain/git-gotchas.md) —— 镜像代理改写、force-with-lease、amend 后的"神秘远端提交"
- [长跑命令：超时、后台与管道阻塞](./06-toolchain/long-running-commands.md) —— 为什么重定向会把子进程卡死

### [07 本地 AI 能力](./07-local-ai/)

- [本地批量图文识别：RapidOCR + 一个"该不该 OCR"的判据](./07-local-ai/local-image-ocr.md) —— 99 页课件 20 秒，靠的是跳过照片而不是加速识别
- [本地批量操作 PPT：读结构、写页面、为什么"就地改"是陷阱](./07-local-ai/pptx-batch.md) —— `.pptx` 是 zip+XML，改一处等于整份重写
- [给记忆库配一个本地小模型（512 维、22.9 MB、纯 CPU）](./07-local-ai/local-embedding-memory.md) —— DLL 常驻锁、纯 ASCII 探针验收、去重阈值怎么定

### [08 插件来源对照](./08-plugin-sources/)

- [插件全表：装了什么、从哪来、该不该跟](./08-plugin-sources/来源清单.md) —— 三个 profile、81 个插件的来源与实装版本
- [为什么不复制插件代码](./08-plugin-sources/README.md) —— 版权、会腐烂、没必要；以及 LF→CRLF 噪声怎么把「上游代码」骗成「自己的作品」

### [09 自研插件源码](./09-self-plugins/)

- [dsh-v4-source-guard](./09-self-plugins/dsh-v4-source-guard/) —— 卸载插件后旧会话打不开的修复
- [dsh-watchdog-keeper](./09-self-plugins/dsh-watchdog-keeper/) —— 守护进程心跳监护，默认只监控不复活
- [dsh-web-fetch-local](./09-self-plugins/dsh-web-fetch-local/) —— 带 SSRF 护栏的最小本地抓取器
- [这三个的限制与范围](./09-self-plugins/README.md) —— 每个都写清了做不到什么

### [10 工作流脚本](./10-workflows/)

- [让开机 / 唤醒后的计划任务彻底不弹窗](./10-workflows/silent-autostart/) —— `-WindowStyle Hidden` 为什么不管用，`StartWhenAvailable` 为什么让症状出现在唤醒后
- [把被进程 mmap 的大目录搬到别的盘](./10-workflows/dsh-junction-migrate/) —— DLL 常驻锁、脱离宿主进程树、可证伪验收与无条件回滚
- [记忆库运维](./10-workflows/memory-ops/) —— 统计基准线、语义近重复扫描、补齐缺失向量
- [插件来源清单生成](./10-workflows/plugin-inventory/) —— 从 profile 实时读，不手抄
- [磁盘健康巡检](./10-workflows/disk-health/) —— 盯趋势和变化点，不盯绝对值

## 怎么用

- **当作 checklist**：写到一半卡住时，先扫一眼对应分类的标题，比全文检索快。
- **别当作权威**：每条都标了实测环境。换操作系统、换版本、换网络环境，先自己验一遍再信。
- **欢迎补充反例**：如果哪条在你的环境里不成立，那是最有价值的信息 —— 请开 issue 说明你的环境与现象。

## 实测环境（大部分条目基于此）

- Windows 10 22H2（19045）+ PowerShell 7.x + Python 3.12 + Node.js 24
- 4 核 8 线程 Xeon E3-1271 v3 / 24 GB 内存 / 无 CUDA 的独立显卡 —— **注意这台机器没有 CUDA**，所以 07 分类里的所有耗时都是纯 CPU 数字
- 中国大陆网络环境（这一点对"检索""代码托管""镜像"类条目影响很大，境外读者请自行折算）

**这不是限定条件，只是诚实交代来源。** 很多坑与平台无关（比如"结论不许硬编码""先证伪自己"）。

## 不含什么

- 不含任何个人身份、机构、课题、路径、凭据信息 —— 所有脚本的路径都走「参数 → 环境变量 → 默认值」三级，默认值避开用户名
- 不含未公开的数据或尚未发表的研究内容
- 不针对任何具体产品做推荐或贬损，只描述观察到的行为
- **不含对抗 / 安全测试类插件**：既不收录也不给安装方式
- **不含客户端 UI 个性化插件的推荐**：08 里列了本机在用的，但明确写了「不必跟」

## 许可

文档与文字：[CC BY-NC-SA 4.0](./LICENSE)（署名 — 非商业性使用 — 相同方式共享 4.0 国际）。

`09-self-plugins/` 下的**代码**：[PolyForm Noncommercial 1.0.0](./09-self-plugins/LICENSE)。分层的理由：CC 系列没有处理专利授权，且对「源码 / 目标码」的界定在软件场景是模糊的，代码用 PolyForm 更合适。

**允许**：阅读、复制、修改、再分发、用于教学与个人研究，前提是署名、且衍生作品以同样的许可发布。

**不允许**：任何商业性使用 —— 包括但不限于把它打包进付费产品、用于商业咨询交付、用作企业内部培训营利用材料、整站镜像后挂广告。商业授权请单独联系作者。

**不覆盖**：`08-plugin-sources/` 里指到的那些插件代码，其许可由各自上游仓库决定；本仓库只是指路。

> 这不是"保留一切权利"。除商业用途外，用法基本不受限；选择 NC 类许可而不是更宽松的许可，只是不希望有人把踩过的坑包装成课程卖掉。

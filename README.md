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

## 怎么用

- **当作 checklist**：写到一半卡住时，先扫一眼对应分类的标题，比全文检索快。
- **别当作权威**：每条都标了实测环境。换操作系统、换版本、换网络环境，先自己验一遍再信。
- **欢迎补充反例**：如果哪条在你的环境里不成立，那是最有价值的信息 —— 请开 issue 说明你的环境与现象。

## 实测环境（大部分条目基于此）

- Windows 11 + PowerShell 7.x + Python 3.12 + Node.js 20+
- 中国大陆网络环境（这一点对"检索""代码托管""镜像"类条目影响很大，境外读者请自行折算）

**这不是限定条件，只是诚实交代来源。** 很多坑与平台无关（比如"结论不许硬编码""先证伪自己"）。

## 不含什么

- 不含任何个人身份、机构、课题、路径、凭据信息
- 不含未公开的数据或尚未发表的研究内容
- 不针对任何具体产品做推荐或贬损，只描述观察到的行为

## 许可

[MIT](./LICENSE)。拿去用、拿去改，不用署名。

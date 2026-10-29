# 从 profile 生成插件来源清单

## 为什么需要脚本

手写插件清单一定会错。错的方式还很隐蔽：你抄 `package.json` 里声明的 spec（`^0.56.2`），但 `node_modules` 里实际装的是别的版本；`link:` 类的条目更麻烦，spec 只是个路径，真实版本要去被链目录的 `package.json` 里读。

所以清单必须**从两处实时读**：

- `<profile>/package.json` → 声明了什么、从哪来（npm / github / link / tar）
- `<profile>/node_modules/<包名>/package.json` → 实际解析成什么版本

## 用法

```bash
# 默认：读 ~/.dsh/profiles/{desktop,web,mirage}，写到当前目录 插件清单.md
node gen-plugin-list.mjs

# 自定义
DSH_HOME=/path/to/.dsh PLUGIN_LIST_OUT=./清单.md node gen-plugin-list.mjs
```

输出是 Markdown：每个 profile 一张表（插件 / 来源 / 实装版本），末尾给出依赖总数与 npm / link / github / tar 的分类汇总，以及去重后的本机 `link:` 目录列表。

重跑即刷新，不需要手工维护。

## 来源分类怎么判

| spec 形态 | 归类 | 例 |
|---|---|---|
| `^1.2.3` / `1.2.3` / `latest` | npm | `0.56.2` |
| `github:owner/repo` | github | `github:yuhui-sama/dsh-agentsoul` |
| `link:路径` / `file:路径` | link（本机目录） | `link:D:/dsh/dsh-toolkit` |
| `http(s)://…tar.gz` | tar | `https://codeload.github.com/owner/repo/tar.gz/refs/tags/v1.1.78` |

`link:` 的实装版本必须去 `<path>/package.json` 读，不能从 spec 猜——路径里没有版本信息。

## 一个会把结论带偏的坑：LF → CRLF 噪声

生成清单之后你大概会想知道「这些 link 插件里，哪些是我改过的上游、哪些是我自己写的」。这时跑 `git status`，会看到几十到两百多项改动。看起来像重度魔改。

实际几乎全是换行符差异：文件在 Windows 上被检出成 CRLF，而仓库 `core.autocrlf=false` 让 git 把换行符变化当成内容变化。

真实改动必须加 `--ignore-all-space`：

```bash
git diff --ignore-all-space --stat
```

实测对比（同一批目录）：

| 插件 | 原始改动项 | 忽略空白后 |
|---|---|---|
| `dsh-toolkit` | 253 | 1 文件 2 行 |
| `dsh-plugin-check` | 50 | 5 文件 13 行 |
| `dsh-session-health` | 30 | 1 文件 4 行 |
| `dsh-ops-health` | 0 | 0 |

不先忽略空白，就会把「上游代码 + 换行符」误当成自己的作品，然后打包分发别人的代码。

## 判断「有没有上游」也要小心

同名不代表同源。实测遇到过三种情况：

1. **有 .git 且 remote 指向上游** → 直接 `git remote -v` 确认。
2. **有 .git 但没配 remote** → 不能说「无上游」，可能只是 clone 后删了 remote。要看提交历史、看代码风格。
3. **目录名和 GitHub 上的仓库同名，但实现完全不同** → 例如 `dsh-web-fetch-local`，GitHub 上有两个同名仓库，实现方式（是否带 SSRF 护栏、用什么 fetch）与自己这份不一样。这种情况按「自写」处理，但要在文档里注明「GitHub 上有同名项目，非同源」。

第 3 种最容易出错：只搜目录名、看到有结果就判定「有上游，不用上传」，结果别人的仓库里根本没有这段代码。

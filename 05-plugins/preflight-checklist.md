# 装插件之前先做预检

> 配置里最危险的一句话是"只改一个字段"——如果那份配置是**整体替换**语义，你改一个字段等于删掉其余所有字段，而且零报错。

## 现象

给一个已有的插件/MCP server 条目加一个配置项，改完重启，然后：

- 插件看起来还在，但某些功能莫名失效
- 原来能用的参数变成了默认值
- **没有任何报错**，日志干干净净

回滚配置文件就好了 —— 但你不知道自己当时改坏了什么。

## 根因：整条替换 vs 深度合并

配置合并有两种语义，长得几乎一样：

| 语义 | 行为 | 例子 |
|---|---|---|
| **深度合并**（deep merge） | 递归合并对象，只覆盖你写的键 | `{a:{x:1,y:2}}` + `{a:{x:9}}` → `{a:{x:9,y:2}}` |
| **整条替换**（replace） | 你写的对象**整个替换**原对象 | `{a:{x:1,y:2}}` + `{a:{x:9}}` → `{a:{x:9}}` |

很多配置系统（尤其是"patch"/"override"类文件）用的是**第二种**。

你以为自己在"加一个键"，实际在"用只含一个键的新对象替换掉整块"。

**最典型的坑**：patch 文件里写

```yaml
# 我以为：只把 timeout 改成 60
plugins:
  my-plugin:
    config:
      timeout: 60
```

原配置里 `config` 下还有 `apiBase`、`retries`、`headers` 三样 —— **全没了**。

## 做法

### 一、装/改之前先做三件事

**1. 备份**

```powershell
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
Copy-Item -Recurse -Path $profileDir -Destination "D:\backup\plugin-before-$stamp"
```

**2. 记录当前生效配置（不是文件内容）**

文件是"输入"，生效值是"输出"。改之前先把输出存下来：

```bash
mytool --dump-config > before.json      # 具体参数看你的工具
```

**3. 改完再 dump 一次，diff**

```bash
mytool --dump-config > after.json
diff before.json after.json
```

**这一步是整套流程的核心。** 它直接回答"我到底改了什么"，而不是"我以为改了什么"。

### 二、确认真实发布物，而不是仓库源码

从 git 仓库或 npm 包安装时，**实际运行的文件可能与源码不同**：

- 有构建步骤 → 跑的是 `dist/` 不是 `src/`
- 有 prepublish 脚本 → 发布的 `package.json` 可能与仓库里的不同
- 有文件白名单（npm 的 `files` 字段）→ 有些文件根本没发布

**做法**：`npm pack <pkg>` 解开，在**解包后的真实产物**上再验一次。

```bash
npm pack some-mcp-server@1.2.3
tar -xzf some-mcp-server-1.2.3.tgz
ls package/dist/            # 看入口文件真的存在吗
node package/dist/index.js  # 手动跑一次
```

### 三、检查冲突与版本漂移

装之前确认：

- **名字有没有被占用**：patch id、server 名、端口号
- **是不是装了多份**：同一个包在全局 / 项目 / 插件的 `node_modules` 里各有一份，版本还不同
- **依赖是否互斥**：两个插件锁了同一个包的不同大版本

```bash
# 找重复副本
find . -path '*/node_modules/some-pkg/package.json' -exec sh -c \
  'echo "$(dirname {}): $(node -p "require(\"./{}\").version")"' \;
```

版本漂移的表现是"有时好有时坏"、"换个工作目录就变"。

### 四、装完做一次健康检查

不只看"装成功了"，要看"关键能力都在"：

```
□ server 能启动（进程存活）
□ 至少一个工具能调用成功（不是只列出）
□ 配置文件里原有字段一个没少
□ 版本号符合预期
```

## 边界

- 有的配置系统确实是深度合并。**别凭文档猜，用 `--dump-config` 实测一次** —— 造一个"加一个键"的最小改动，看原有键是否还在。这五分钟能省掉一次线上事故。
- 备份策略按代价定：改单个文件用 `.bak` 就够，改整个插件目录就整目录快照。
- 预检不能替代测试。它只能保证"没把已知的东西改坏"，不能证明"新功能能用"。

## 一句话记法

> **改配置之前先 dump，改完之后再 dump，然后 diff。你改的是文件，生效的是合成结果 —— 只有 diff 能告诉你真实差异。**

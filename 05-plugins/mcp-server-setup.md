# MCP Server 接不上的三个真实原因

> MCP（Model Context Protocol）server 启动失败时，客户端通常只告诉你一句话：**"Connection closed"**。
> 三个最坑的原因，都不会在日志里留下任何痕迹。

## 现象

在客户端配置里加了一个 MCP server，重启后：

```
MCP server "my-tool" failed: Connection closed
```

或者更糟：**没有任何报错，工具就是没出现。**

手动在终端里跑同样的命令 —— 一切正常，能起服务、能响应。

## 根因

"终端能跑、客户端不能跑"这个组合几乎总是来自三个地方之一：

| 原因 | 特征 | 排查成本 |
|---|---|---|
| 入口路径是符号链接，自启动守卫静默退出 | 进程退出码 0，stdout/stderr **全空** | 高（没日志） |
| 用 `npx` 启动，形成多层进程链 | 偶发 EPIPE、随机失联 | 高（重连时而成功） |
| 子进程环境变量不在白名单 | 配置里的变量"没生效" | 中（以为写错了） |

## 做法

### 一、入口必须写 realpath

很多 server 有一段标准的自启动守卫：

```javascript
// server.js 常见的开头
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) { main(); }
```

问题在于：

- `process.argv[1]` 是**命令行里原样给出的路径**（可能是软链接）
- `import.meta.url` 是 Node **解析成 realpath 之后**的路径

两者不一致 → `isMain` 为 `false` → server 认为"我是被别人 import 的，不该自己启动" → **静默 `exit 0`**。

客户端看到的就是 `Connection closed`，没有任何 stderr。

**检查方法**：

```bash
# Linux/macOS
realpath /path/to/server.js
# 如果与下面输出不同，就是这个坑
echo /path/to/server.js

# Windows (PowerShell)
(Get-Item 'C:\path\to\server.js').Target
```

**解决**：配置里写 realpath 的绝对路径，不要写软链接路径、不要写相对路径。

```json
{
  "command": "/usr/local/bin/node",
  "args": ["/real/path/to/node_modules/pkg/dist/server.js"]
}
```

### 二、别用 `npx` 启动

`npx` 启动会形成这样的进程链：

```
客户端
  └─ cmd.exe / sh
       └─ npx
            └─ cmd.exe / sh
                 └─ node (真正的 server)
```

MCP 客户端在关闭时通常只对**直接子进程**发信号。上层退出后，下层 `node` 变成孤儿进程，**继续攥着 stdin/stdout 的 fd**。

后果：

- 客户端以为服务已停，实际进程还在
- 下次启动新实例 → 两个实例抢同一个管道 → `EPIPE`
- 表现为**随机**的"有时能连、有时不能"

**解决**：`command` 直接写 `node` 的绝对路径，`args` 写 server.js 的绝对路径。

```json
{
  "command": "/usr/local/bin/node",
  "args": ["/abs/path/to/server.js"]
}
```

Windows 上尤其要注意：别写 `npx`、`npm exec`、`.cmd`/`.ps1` 包装脚本。

### 三、环境变量不是从父进程继承的

出于安全考虑，很多 MCP 客户端对子进程只传一个**固定白名单**的环境变量（常见是 PATH、HOME、TMPDIR 这类十来个）。

所以你在 shell 里 `export MY_API_KEY=xxx`，MCP server 里 `process.env.MY_API_KEY` 是 `undefined`。

**解决**：把需要的变量**显式写进该条 server 配置的 `env` 字段**。

```json
{
  "command": "/usr/local/bin/node",
  "args": ["/abs/path/to/server.js"],
  "env": {
    "MY_API_KEY": "${MY_API_KEY}",
    "LOG_LEVEL": "info"
  }
}
```

（`${VAR}` 展开语法是否支持取决于客户端，写成字面值最保险 —— 但要注意**别把密钥提交进版本库**。）

### 四、排查顺序（省时间的那个）

1. **手动跑一遍**：`node /abs/path/server.js`，看是否有输出。有输出 → 问题在配置；无输出且立即退出 → 入口/守卫问题
2. **查退出码**：`echo $?`（Windows `$LASTEXITCODE`）。`0` + 无输出 = 极大概率是第一类
3. **看 realpath**：`realpath` 与配置里写的路径一致吗
4. **看进程树**：是不是有 `npx`/`cmd.exe` 层
5. **打印 env**：在 server 启动时 `console.error(process.env)` 到 stderr，确认变量到了没

## 边界

- 不同客户端白名单不同，有的支持 `.env` 文件加载、有的支持 `${VAR}` 展开。**具体行为以你的客户端文档为准。**
- realpath 问题只在**有自启动守卫**的 server 上出现。没有守卫的 server 对路径不敏感。
- `npx` 的问题在 Linux 上可能轻一些（`sh -c` 层更少），但 Windows 上几乎必然踩到。
- 有的客户端会**缓冲子进程 stderr 直到进程退出**。所以"server 卡住"时看不到日志是正常的 —— 用文件日志（`fs.appendFileSync`）绕开。

## 一句话记法

> **三个排查点：入口是不是 realpath、进程树里有没有 npx、环境变量写进 env 字段了没有。**

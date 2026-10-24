# 改了文件 ≠ 已在跑

> 你改的是磁盘上的那行字，而进程里跑的是它**启动那一刻读进内存的副本**。

## 现象

最折磨人的一类 bug：

- 代码明明改了，行为还是旧的
- 重启一下就好了，但你不确定是"重启起效了"还是"刚才没重启"
- 单元测试全绿，线上照样错
- 配置文件里那个值确实是新的，日志里打出来还是旧的

## 根因

Node.js、Python（模块级常量）、PowerShell、任何把配置读进内存的语言/框架，都有同一个特性：

**启动时读一次，之后只看内存。**

所以"文件已更新"和"新逻辑在跑"是**两件独立的事**，而它们的证据长得很像 —— 都在同一个路径上，都写着新内容。

## 做法

### 一、比时间戳（第一证据）

```powershell
# 补丁/配置的最后写入时间
$patched = (Get-Item 'C:\path\to\patched-file.js').LastWriteTime

# 进程的启动时间
$proc = Get-Process -Id $pid
$started = $proc.StartTime

"补丁时间: $patched"
"进程启动: $started"
if ($started -lt $patched) { "⚠ 进程启动早于补丁 → 跑的是旧代码" }
else { "时间顺序正常（仍需行为验证）" }
```

注意：**这个检查只能证伪，不能证实。** 时间顺序对，不代表逻辑真的生效了（可能加载的是另一份副本）。

### 二、打线上探针（第二证据）

直接测**行为**，不测文件：

```javascript
// 别这样做：读文件确认改了
// const src = fs.readFileSync('./handler.js', 'utf8');
// assert(src.includes('newBranch'));

// 要这样做：触发那条分支，看输出
const res = await callHandler({ kind: 'edge-case' });
assert.strictEqual(res.status, 'handled-by-new-branch');
```

对配置类改动，探针就是"读回运行时的值"，不是"读文件的值"：

```bash
# 很多工具支持 dump 生效配置（示例，具体参数看你的工具）
mytool --dump-config | grep target_key
```

**离线验证全绿 + 时间顺序正确，仍然不等于已生效。** 两个证据缺一不可。

### 三、认准"哪一份副本"在跑

同一份代码在机器上经常有 3 份以上：

| 位置 | 典型来源 |
|---|---|
| 源码目录 | 你编辑的那个 |
| `node_modules` / `site-packages` | 包管理器装的 |
| 全局缓存 / 打包产物 | 构建、asar、zip 解包出来的 |
| 运行中进程的临时目录 | 某些框架启动时复制 |

**改第 1 份、跑第 4 份**是最常见的组合。查进程实际打开的路径：

```powershell
# Windows：看进程加载了哪些模块
(Get-Process -Id $pid).Modules | Select-Object -ExpandProperty FileName | Select-String 'myapp'

# 更直接：看命令行
Get-CimInstance Win32_Process -Filter "ProcessId=$pid" | Select-Object CommandLine
```

### 四、版本号/构建标记要能被看见

给可执行产物加一个**自证身份**的字段（构建哈希、版本串、启动时间），并在健康检查里暴露：

```json
{ "version": "1.4.2+build.20261024T1032", "startedAt": "2026-10-24T10:33:11Z", "pid": 12345 }
```

以后排查"到底新不新"，一次 GET 就够。

## 边界

- 对**纯数据文件**（被每次请求重新读取的 JSON、模板），这个检查不适用 —— 它们本来就是热读的。
- 热重载（HMR/watch）环境里，时间戳检查会给出误导性的"正常"。**只信行为探针。**
- 如果是**容器/虚拟机**，宿主机改文件不等于容器内文件变了（volume 挂载没配的话）。

## 一句话记法

> **文件是给磁盘看的，探针是给进程看的。要证明新逻辑在跑，只有探针算数。**

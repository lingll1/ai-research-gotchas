# PowerShell 编码与转义：BOM、反引号、双引号

> 两个看起来无关的问题，根因都是同一件事：**你以为在操作字符串，其实在操作"解码后的字符串"。**

## 现象

### 现象一：脚本"语法错误"，但明明写的没问题

一个 `.ps1` 文件，内容完全正确：

```powershell
Write-Host "处理完成"
```

运行报：

```
标记"处理完成"后面缺少右引号。
```

打开文件看，引号明明成对。把中文改成英文 `Write-Host "done"` —— **就好了**。

### 现象二：用脚本做替换，目标明明存在，`match = 0`

```powershell
$content = $content -replace "见 ``~/.dsh/AGENTS.md`` 这一节", "见第五节"
# 结果：什么都没替换，而且不报错
```

那段文字在文件里确实存在（用 `Select-String` 能搜到），但 `-replace` 匹配 0 处。

### 现象三：带 BOM 的脚本报"赋值表达式无效"

用 Python 生成 `.ps1` 时手动加了 BOM 前缀：

```python
script = "\ufeff" + "\n".join(lines)
open("run.ps1", "w", encoding="utf-8").write(script)
```

生成的脚本一运行：

```
在此对象上找不到属性或方法。
赋值表达式无效。param(...)
```

## 根因

### 现象一：没有 BOM，PowerShell 5.1 按 GBK 解码

Windows PowerShell 5.1（`powershell.exe`）读取**没有 BOM** 的脚本文件时，会用**系统 ANSI 代码页**（简体中文环境是 **GBK / CP936**）去解码。

UTF-8 编码的中文字节被当 GBK 解读，产生的字符可能包含引号、反斜杠等**元字符** —— 于是引号配对被打乱，语法直接崩。

**关键：这不是"中文乱码"问题，是"解码后语法结构变了"问题。** 所以报错信息指向引号，不指向中文。

PowerShell 7（`pwsh`）默认按 UTF-8 读取，没有这个问题 —— 但**文件仍可能被 5.1 执行**（比如计划任务、某些宿主进程、别人拿到你的脚本）。

### 现象二：双引号里的反引号是转义符

PowerShell 用**反引号 `` ` ``** 作为转义字符（不是反斜杠）。

所以：

```powershell
"见 ``~/.dsh/AGENTS.md`` 这一节"
# 实际字符串是：见 `~/.dsh/AGENTS.md` 这一节  ← 反引号只剩下一个
```

` `` ` （两个反引号）被解释为"一个字面反引号"。你本来想匹配"两个反引号"（Markdown 行内代码），结果匹配的是"一个"。

**在双引号字符串里，反引号永远先被当转义符处理，然后才谈匹配。**

### 现象三：双 BOM

`\ufeff` 是 BOM 的码点。手动拼一个 `\ufeff`，再用 `encoding="utf-8-sig"` 写出 —— `utf-8-sig` **自己会加一个 BOM** → 文件开头有两个 BOM。

第二个 BOM 成为 `param()` 块前的**非法字符**，PowerShell 报"赋值表达式无效"。

## 做法

### 一、含中文的 `.ps1` 一律存成 UTF-8 **with BOM**

```python
# 正确：让 utf-8-sig 自己加 BOM
from pathlib import Path
Path("run.ps1").write_text(script, encoding="utf-8-sig")

# 错误：手动拼 BOM + utf-8-sig = 双 BOM
Path("run.ps1").write_text("\ufeff" + script, encoding="utf-8-sig")
```

检查现有文件有没有 BOM：

```powershell
$bytes = [System.IO.File]::ReadAllBytes('run.ps1')[0..2]
if ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    "有 UTF-8 BOM"
} else {
    "无 BOM —— 若文件含中文且会被 5.1 执行，需要加"
}
```

**顺手检查是不是双 BOM**：前 6 个字节如果是 `EF BB BF EF BB BF`，就是双 BOM。

### 二、`.cmd` / `.bat` 必须 CRLF

cmd.exe 对 LF-only 文件处理不可靠（尤其带 `goto`、`if` 块时）。用二进制模式写：

```python
Path("run.cmd").write_bytes(script.replace("\n", "\r\n").encode("gbk", errors="replace"))
# 或至少：.encode("utf-8").replace(b"\n", b"\r\n")
```

### 三、要匹配或替换含反引号的文本，用单引号或 here-string

```powershell
# 单引号字符串：反引号不转义，按字面处理
$content = $content -replace '见 `~/.dsh/AGENTS.md` 这一节', '见第五节'

# here-string（单引号版）：整块按字面
$old = @'
见 `~/.dsh/AGENTS.md` 这一节
'@
$content = $content.Replace($old, '见第五节')
```

**经验法则**：

| 场景 | 用什么 |
|---|---|
| 字面文本、正则、Markdown、代码片段 | **单引号** `'...'` |
| 需要变量插值 `$var` | 双引号 `"..."`，但反引号要想清楚 |
| 多行文本 | 单引号 here-string `@'...'@` |

**更稳的办法：改用 Python 做文本替换。** 复杂字符串处理在 Python 里没有这层转义叠加，出错面小得多。

### 四、控制台输出编码

在 GBK 控制台里跑 Python 打印中文会中断：

```powershell
$env:PYTHONIOENCODING = 'utf-8'
# 或
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

脚本内部也强制一次：

```python
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
```

## 边界

- **PowerShell 7 默认 UTF-8，不需要 BOM**。加 BOM 主要是为了兼容 5.1 与"别人可能在 5.1 下执行"的场景。
- 纯 ASCII 的脚本加不加 BOM 都行。**只有含非 ASCII 字符时才是必须的。**
- 单引号字符串里不能插值变量。要插值又不想转义反引号 → 改用 `-f` 格式化或字符串拼接。
- `-replace` 的替换串里 `$1` 等是反向引用，`$` 也要转义。这是另一个独立的坑。

## 一句话记法

> **含中文的 .ps1 存 UTF-8 带 BOM（用 `utf-8-sig`，别手拼）；要处理含反引号的文本就走单引号或换 Python。**

---
name: reference-check
description: 当需要核对参考文献是否真实存在、检查 DOI 能否解析、或排查"列必引/引必核"问题时使用。含 Crossref 查询、双向差集、预印本状态判定。
---

# 文献核验 skill（示例骨架）

> 这是一个**可复制改写的示例**，不是完整产品。把它拷走，改成你自己领域的版本。

## 什么时候用

- 投稿前检查参考文献表
- 怀疑某条引文是编造的
- 需要确认预印本是否已正式发表

**什么时候别用**：只想快速找几篇文献读 → 用搜索引擎/数据库直查，不必走这套流程。

## 步骤

### 1. 抽出所有 DOI，逐条解析

```python
import urllib.request, json, time, random

MAILTO = "you@example.com"
UA = f"ref-check/1.0 (mailto:{MAILTO})"

def crossref(doi: str) -> dict:
    """返回 {'status': 'ok'|'not_found'|'unknown', 'title':..., 'year':...}"""
    url = f"https://api.crossref.org/works/{doi}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            m = json.load(r)["message"]
            return {
                "status": "ok",
                "title": (m.get("title") or [""])[0],
                "year": (m.get("issued", {}).get("date-parts") or [[None]])[0][0],
                "journal": (m.get("container-title") or [""])[0],
            }
    except urllib.error.HTTPError as e:
        return {"status": "not_found" if e.code == 404 else "unknown", "code": e.code}
    except Exception as e:
        return {"status": "unknown", "error": f"{type(e).__name__}: {e}"}

def check_all(dois):
    out = {}
    for i, d in enumerate(dois, 1):
        res = crossref(d)
        out[d] = res
        print(f"[{i}/{len(dois)}] {res['status']:9s} {d}")
        time.sleep(0.3 + random.uniform(0, 0.7))     # 串行 + 抖动，别并发
    return out
```

**关键**：`not_found`（404，真的不存在）和 `unknown`（限流/超时，没结论）必须分开。把后者当前者会造成事故。

### 2. 核对返回的元数据与你写的是否一致

DOI 存在只证明"这个 DOI 有记录"，**不证明它就是你引的那篇**。

逐条比对：标题（忽略大小写与标点）、第一作者姓、年份。

```python
def normalize(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())

def mismatch(claimed: dict, actual: dict) -> list[str]:
    problems = []
    if normalize(claimed["title"]) != normalize(actual.get("title", "")):
        problems.append("标题不一致")
    if claimed.get("year") and actual.get("year") != claimed["year"]:
        problems.append(f"年份不一致: 写 {claimed['year']}, 实际 {actual['year']}")
    return problems
```

### 3. 预印本状态

看到 DOI 前缀属于常见预印本平台时，**标记出来并单独查一次是否已正式发表**：

```python
PREPRINT_HINTS = ("10.1101/",   # bioRxiv / medRxiv
                  "10.21203/",  # Research Square
                  "10.2139/")   # SSRN

def is_preprint_hint(doi: str) -> bool:
    return doi.lower().startswith(PREPRINT_HINTS)
```

命中就输出警告：**引文状态需人工确认**。

### 4. 正文与文献表的双向核对

见 [reference-rules.md](../../02-search-literature/reference-rules.md) 第一节的 `comm` 命令。
把两个方向的差集都打印出来。

## 输出格式建议

```json
{
  "summary": { "total": 42, "ok": 38, "not_found": 2, "unknown": 2 },
  "action_required": [
    {"doi": "10.xxxx/yyyy", "reason": "not_found", "note": "疑似编造，需人工确认"},
    {"doi": "10.xxxx/zzzz", "reason": "unknown", "note": "限流，需重跑"}
  ]
}
```

**`unknown` 必须留在 `action_required` 里**，不能被统计逻辑归并掉。

## 常见错误

| 症状 | 原因 | 处置 |
|---|---|---|
| 全部 `unknown` | 没带 User-Agent / 网络受限 | 加 `mailto`，串行重试 |
| 偶尔 `SSL: UNEXPECTED_EOF_WHILE_READING` | 服务端主动断连（限流/中间设备） | 退避重试；不要当"文献不存在" |
| 429 连续 | 并发太高 | 改串行 + 0.3–1s 间隔 |
| 中文文献大量 404 | 老文献/中文期刊无 DOI | 走人工核对（刊名+年+卷期+页+第一作者） |

## 边界

- 这套流程只核"文献是否存在、元数据是否一致"，**不核内容**。引文说"该文发现 X"但原文其实说的是 Y，机器查不出来。
- 中文文献、标准、书籍大量无 DOI，必须有一个人工核对清单。
- 各接口配额会变，遇到持续失败先怀疑配额，再怀疑文献。

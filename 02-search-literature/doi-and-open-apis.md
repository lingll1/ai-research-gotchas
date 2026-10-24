# DOI 核验与开放学术接口的限流脾气

> 免费接口不等于随便调。它们大多有礼貌池、速率上限和 TLS 怪癖，而失败信息经常完全不指向真正原因。

## 现象

写了个循环，拿一堆 DOI 去 Crossref 核验，前几十条正常，然后开始出现这些：

```
SSL: UNEXPECTED_EOF_WHILE_READING
HTTP 429 Too Many Requests
```

还有更迷惑的：**同样的代码，昨天全通，今天全挂，明天又好了。**

## 根因

四件事被混在一起：

1. **礼貌池（polite pool）** —— Crossref 这类服务对"带联系方式"的请求给更高配额。不带就排队，高并发下表现为超时。
2. **速率限制** —— OpenAlex / Semantic Scholar 等有明确的 RPS 上限，超了直接 429。
3. **TLS 会话被中途掐断** —— `UNEXPECTED_EOF_WHILE_READING` 通常不是证书问题，而是**服务端或中间设备主动断开**（限流、地域策略、代理）。
4. **没退避重试** —— 一遇 429 就整体失败，而不是等一会儿再试。

## 做法

### 一、把联系方式放进 User-Agent

```python
import urllib.request, json, time, random

MAILTO = "you@example.com"          # 换成你的，Crossref 靠这个把你归入礼貌池
UA = f"ref-check/1.0 (mailto:{MAILTO})"

def get_json(url: str, retries: int = 4) -> dict | None:
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 503):
                # 指数退避 + 抖动，避免重试风暴
                wait = (2 ** attempt) + random.uniform(0, 1)
                print(f"[{e.code}] 限流，{wait:.1f}s 后重试 ({attempt+1}/{retries})")
                time.sleep(wait)
                continue
            print(f"[HTTP {e.code}] {url}")
            return None
        except Exception as e:
            wait = (2 ** attempt) + random.uniform(0, 1)
            print(f"[{type(e).__name__}] {wait:.1f}s 后重试: {e}")
            time.sleep(wait)
    return None
```

### 二、各接口的实测脾气（2026-10 某次核查）

| 接口 | 结果 | 备注 |
|---|---|---|
| Crossref `api.crossref.org/works/{doi}` | 可用，但偶发 `SSL: UNEXPECTED_EOF_WHILE_READING` | **必须带 User-Agent + mailto**；不带时更易被断 |
| OpenAlex `api.openalex.org` | **429** | 免费但限流严格，需退避 |
| Semantic Scholar `api.semanticscholar.org` | **429** | 同上，无 key 时配额很低 |
| DOAJ `doaj.org/api` | **200** | 开放获取期刊目录，响应稳定 |
| bioRxiv / medRxiv API | 通常可用 | 预印本元数据、版本信息 |

**这不是"哪个能用"的判决书，是"遇到什么要想到什么"。** 全部访问受限的能力会随时间变化。

### 三、串行 + 间隔，别并发轰

核验几十条 DOI，串行加 0.3–1 秒随机间隔，总耗时可控，成功率远高于并发。

```python
from pathlib import Path

def check_all(dois: list[str], log_path: Path) -> dict:
    results = {}
    with log_path.open("a", encoding="utf-8") as log:
        for i, doi in enumerate(dois, 1):
            msg = get_json(f"https://api.crossref.org/works/{doi}")
            ok = msg is not None
            results[doi] = ok
            log.write(f"{'OK  ' if ok else 'FAIL'} {doi}\n")
            log.flush()                       # ← 中断也能留下已完成的部分
            print(f"[{i}/{len(dois)}] {'✓' if ok else '✗'} {doi}")
            time.sleep(0.3 + random.uniform(0, 0.7))
    return results
```

`flush()` 那一行很关键：核验到第 80 条被打断，前 79 条的结论不会丢。

### 四、区分"这条文献不存在"和"这次没查到"

**这两件事必须分开记录**，否则你会把网络问题当成"文献是假的"，或者反过来。

```python
results[doi] = {"status": "ok"}         # 查到了
results[doi] = {"status": "not_found"}  # 404 —— 真的不存在
results[doi] = {"status": "unknown"}    # 限流/超时 —— 没结论，必须重查
```

**`unknown` 不能并入 `not_found`。** 这是整套核验里最容易造成学术事故的一步。

## 边界

- 免费接口的配额与策略会变。上面的状态码是快照，方法（带 UA、退避、串行、区分失败类型）是稳定的。
- 有 API key 的付费/注册接口通常配额高得多，长期批量作业值得申请。
- Crossref 记录的是**注册的元数据**，不是"这篇论文的结论对不对"。它能查"这条文献是否存在、标题作者是否一致"，不能查"这个数值是否真实"。
- 别用代理池绕限流。违反服务条款，而且会让你的核验结果不可信。

## 一句话记法

> **区分"查无此文"和"这次没查成"—— 这是核验脚本里最重要的一个 if。**

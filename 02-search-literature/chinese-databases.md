# 中文数据库为什么"连不上"，以及怎么绕

> 结论先说：**站点是通的，检索接口不是。** 这两件事被混在一起，会让你连唯一的绕行路也一起放弃。

## 现象

想检索中文文献，典型的三种失败：

1. 用脚本请求检索页，返回 **403 / 412**，或者跳到验证码页面
2. 请求成功了，返回几百 KB 的 HTML，但**结果区是空的**（"共找到 相关结果 条"，数字都是空的）
3. 首页能打开，一站内检索就崩

于是很容易下一个结论：**"中文库连不上，得挂代理/换网络。"**

这个结论通常是错的，而且代价很大 —— 因为它同时否掉了本来可行的路。

## 根因

三个完全不同的机制被混成了"连不上"：

| 你看到的 | 实际发生的 | 性质 |
|---|---|---|
| 403 / 412 | 反爬策略（校验 UA、Referer、cookie、`sec-ch-ua`） | 被拒 |
| 跳验证码页 | 滑块/行为验证 | 被拒 |
| 200 但结果区空白 | **前端 JS 异步拉数据**，HTML 里本来就没有结果 | 成功了，但没内容 |
| DNS 失败 / timeout | 真的不通 | 没连上 |

**第三类是最容易被误判的**：HTTP 200、内容长度正常、页面标题正确 —— 一切指标都显示成功，只有结果不存在。如果你只检查状态码，会以为"能检索但没匹配到"。

## 实测数据（2026-10 某次核查，中国大陆家用宽带）

**首页可达性 —— 四个站全部正常**

| 站点 | DNS | 首页状态 | 耗时 |
|---|---|---|---|
| `www.cnki.net` | 正常 | 200 | ~490 ms |
| `www.wanfangdata.com.cn` | 正常 | 200 | ~363 ms |
| `www.cqvip.com` | 正常 | 200 | ~330 ms |
| `xueshu.baidu.com` | 正常 | 200 | ~207 ms |

**站内检索 —— 全部被挡**

| 路径 | 结果 |
|---|---|
| `kns.cnki.net/kns8s/defaultresult/index?kw=...` | 302 → `verify/home?captchaType=blockPuzzle`（滑块验证） |
| `kns.cnki.net/kns8s/brief/grid` | **403** |
| `search.cnki.com.cn/Search/Result?content=...` | 200 / 约 40 KB，但结果区是 JS 空壳（"找到相关结果**条**"+`loading.gif`） |
| `xueshu.baidu.com/s?wd=...` | **403**（补齐 `sec-ch-ua`、`Referer` 后仍 403） |
| `qikan.cqvip.com/Qikan/Search/Index` | **412 Precondition Failed**（注意：`www.cqvip.com` 首页是 200） |
| `s.wanfangdata.com.cn/paper?q=...` | 200 / 171 KB，但 HTML 里只有一个 `"title"` 且是广告位，无题录 |

**规律**：检索入口的反爬强度远高于首页。这不奇怪 —— 首页是招牌，检索是资产。

## 做法：别正面检索，反过来走

### 路线 A（推荐）：通用搜索 → 直达文献页

用通用搜索引擎检索中文主题，拿到的结果里往往直接包含**文献页**（不是检索页）：

```
【搜】某个中文主题 + 关键词
    ↓
命中 www.cnki.com.cn/Article/CJFDTOTAL-xxxx.htm   （知网单篇页，反爬远弱于检索页）
    或 期刊官网 / 机构知识库 / 预印本平台
    ↓
【抓】直接请求那个单篇 URL，取标题、作者、摘要
```

单篇页比检索页开放得多，这是整件事的关键。实测这两类页面都能正常取到完整题录：

- **知网旧版单篇页**（`www.cnki.com.cn/Article/...`）：标题、作者、单位、《期刊名》年份期号、摘要
- **期刊官网（勤云等投稿系统）**：中英文双摘要、基金信息、标准引用格式、**甚至能直接下 PDF 全文**

**期刊官网往往比聚合平台更开放。** 如果你知道期刊名，直接去期刊官网的检索框试，成功率经常高于走聚合站。

### 路线 B：机构知识库与开放平台

很多研究机构和高校有公开的机构知识库（如农业、地学类院所），检索接口是直连的、无验证码。它们覆盖面窄，但**一篇命中就是完整摘要 + 免费 PDF**。

### 路线 C：把检索交给搜索引擎，而不是自己爬

如果你的目标是"找到相关文献"而不是"批量抓取元数据"，那用**搜索引擎的检索能力**就够：

```
query = "主题词1 主题词2 中文 期刊"
```

一次查询返回的源列表里，前几条常常就是文献页。**这比自己去破反爬便宜两个数量级。**

## 一段可用的检查脚本

判断"是没连上、被拒、还是成功了没内容"：

```python
import urllib.request, urllib.error, gzip, io

def probe(url: str, ua: str | None = None) -> dict:
    headers = {
        "User-Agent": ua or ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                             "AppleWebKit/537.36 (KHTML, like Gecko) "
                             "Chrome/124.0 Safari/537.36"),
        "Accept-Encoding": "gzip",
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            html = raw.decode("utf-8", errors="replace")
            return {
                "kind": "ok",
                "status": r.status,
                "final_url": r.geturl(),          # ← 被重定向到验证码页时这里会变
                "bytes": len(raw),
                "looks_like_captcha": ("captcha" in r.geturl().lower()
                                       or "verify" in r.geturl().lower()),
            }
    except urllib.error.HTTPError as e:
        return {"kind": "rejected", "status": e.code, "reason": e.reason}
    except Exception as e:
        return {"kind": "unreachable", "error": f"{type(e).__name__}: {e}"}
```

**重点看 `final_url`**：302 到 `verify/...` 或 `captcha` 是"被拒"，不是"通了"。

## 边界

- 具体站点的反爬策略**会变**，上面的状态码只是某一天的快照。方法稳定，数值不稳定。
- 走"通用搜索 → 单篇页"的路线，**拿不到批量元数据**（不能做文献计量）。要批量，只能走官方 API 或购买的数据服务。
- 这条路只用于**自己阅读和核对**。批量抓取请遵守各站服务条款与 `robots.txt`。
- 中文文献是必做项，不是可选补充 —— 但"必做"靠的是换路线，不是硬闯检索页。

## 一句话记法

> **首页通 ≠ 检索通。分清"没连上 / 被拒 / 通了但没内容"，才不会一次否掉两条路。**

# 本地批量图文识别：RapidOCR + 一个"这张图该不该 OCR"的判据

> 场景：把一堆 PPT / PDF / 截图批量转成 Markdown，全程离线、只有 CPU、没有 CUDA。
> 结论先行：真正难的不是**识别**，是**决定哪些图不用识别**。判据写错，10 分钟的活变成 17 分钟的活。

## 现象

- 99 页的一份课件，每页都跑一遍 OCR，`smart` 模式还没加时，一轮 60 秒级以上，且输出里塞满了对照片的"识别结果"——那些结果不是文字，是噪声。
- 同一批文件里，51 页纯文字层的 PPT 解析却只要 **0.6 秒**。差距不在引擎，在"要不要把图送进引擎"。
- 有些 `.ppt` 老格式直接报错：`python-pptx` 只能读 `.pptx`。

## 根因

1. **PPT 里的"文字"有两种来源**：文本框（有文本层，`shape.has_text_frame` 直接取，零成本）和图片（截屏、示意图、表格贴图，唯一办法是 OCR）。把两者一视同仁，就等于对每一张装饰照片都做一次前向推理。
2. **照片里的"文字"是伪文字**。OCR 引擎不会报错，它会把纹理识别成一串垃圾字符，而且**耗时和真文字图一样**。所以错误判据不是"漏识别"，是"多识别"，而且更贵。
3. `.ppt`（97-2003 二进制格式）与 `.pptx`（OOXML）是两种完全不同的容器。

## 做法

### 1. 引擎与单例

```python
from rapidocr_onnxruntime import RapidOCR
_engine = None

def engine():
    global _engine
    if _engine is None:          # 模型加载 1–2 秒，进程内必须复用
        _engine = RapidOCR()
    return _engine
```

- 引擎：`rapidocr-onnxruntime`（PaddleOCR 模型的 ONNX 移植，pip 装完即用，不联网、不要 Paddle 那套重依赖）。
- **模型加载 1–2 秒，必须做单例**。多进程并行时每个进程各加载一份，内存 ×N — 这是并行的隐性代价，`--jobs` 别开太大。

### 2. "该不该 OCR"的判据：白底占比 ≥ 0.22

```python
def _looks_like_screenshot(path, white_min=0.22):
    from PIL import Image
    im = Image.open(path).convert("L")
    hist = im.histogram()
    total = sum(hist)
    white = float(sum(hist[235:]))      # 235–255 视为"白"
    return (white / total) >= white_min
```

- 截图、示意图、表格、文档拍照 → 大面积浅色背景 → `white` 占比高。
- 实景照片、人像、风景 → 直方图摊开 → 占比低。
- **0.22 是实测调出来的**，不是拍脑袋：在这批课件上，`smart` 把 99 页从"全部 OCR"的 60 秒级降到 **20.4 秒**，识别出 10,799 字，而人眼抽查没发现漏掉任何一张该识别的图。

> 这个判据的边界很清楚：它区分的是**明暗分布**，不是**有没有字**。深色主题的代码截图会掉到阈值以下被跳过 —— 遇到这类素材要把 `--img-ocr all` 打开。

### 3. 三种输入各走各的路

| 输入 | 取文本的方式 |
|---|---|
| `.pptx` | `python-pptx` 遍历 shape（含 group 递归），文本框直取，图片按 smart 判据决定 |
| `.pdf` | `PyMuPDF` 先取文本层；取不到才 `render → 200 dpi → OCR` |
| 图片 | 直接 OCR |

`.ppt` 不硬啃，先用 LibreOffice 转 `.pptx`：

```python
def find_soffice():  # 找 soffice.exe，找不到就报清楚的错，不要静默失败
    ...
def convert_with_soffice(path, target="pptx"):
    import subprocess
    ...
```

### 4. 批量入口：进程池 + 单文件失败隔离

```
python ocrkit.py auto|ppt|pdf|img <路径...> [--img-ocr smart|all|none] [--jobs N]
```

- `auto` 按扩展名分派；`--jobs` 走 `ProcessPoolExecutor`。
- **单个文件失败不能中断整批**：用 `as_completed` + 逐条 `try/except` 记账，最后打一份"成功 N / 失败 M + 失败清单"。
- 输出：每份源文件一个 `.md`，多文件时额外 `merge_md()` 合成一份。

## 实测数据（8 核 CPU，无独显）

| 场景 | 耗时 |
|---|---|
| 51 页纯文字层 PPT | 0.6 秒 |
| 99 页 PPT，`smart` 默认档 | 20.4 秒（10,799 字） |
| 19 份课件批量、全量图 OCR（`--img-ocr all`） | 1019 秒，成功 19 / 失败 0 |
| 3 张扫描图（含模型加载） | 8.1 秒 |
| 单张扫描图稳态 | 0.3–1 秒 |

## 边界

- **没有 CUDA 就只能这样**：以上全部是 CPU 数字。有 GPU 时引擎要换成 `rapidocr_paddle` 或 `paddle-gpu`，但 `smart` 判据依然适用，且收益一样。
- **`white_min` 不是通用常数**：0.22 是在"课件截图 + 实景照片"混合素材上调出来的。素材换成深色主题截图或票据扫描件，必须重调。
- **OCR 出的是文本，不是结构**：表格会变成一行行字，列对齐丢失。要结构就得配合版面分析（或改用带 layout 的模型），别指望 OCR 顺便给你 Markdown 表格。
- **扫描版 PDF 必须显式开 OCR**：文本层为空时 `PyMuPDF` 返回空串而不报错，容易被当成"空白页"草草放过。`dpi=200` 是清晰度与速度的折中，低于 150 中文小字会掉识别率。

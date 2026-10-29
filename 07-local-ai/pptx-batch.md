# 本地批量操作 PPT：读结构、写页面、以及为什么"就地改"是陷阱

> 场景：不打开 PowerPoint，用代码批量读一叠 PPT 的全部文字/备注/图，或者把一批图片批量拼成一份竖版 PPT。
> 结论先行：`.pptx` 是 **zip + XML**，不是文档对象。所有"改一个地方"的念头，最后都会变成"整份重写"。

## 现象

- `prs = Presentation(path)` 打开后改某个 shape 的文字，保存，PowerPoint 提示"发现无法读取的内容"。
- 新建的 PPT 全是 4:3，塞 3:4 的竖版照片两边大片留白。
- 批量处理后页数 / 尺寸对不对，肉眼看不出，只能一页页翻。

## 根因

1. `.pptx` 本质是一个 zip 包，内部是 `ppt/slides/slideN.xml` + 关系表 `_rels/.rels` + 主题 + 媒体。`python-pptx` 在内存里维护一棵对象树，`save()` 时**整包重写**。任何用 zip 工具直接改内部 XML 的做法，都会破坏 `[Content_Types].xml` 或关系表的自洽性。
2. 页面尺寸来自 `prs.slide_width / slide_height`（EMU，1 英寸 = 914400 EMU）。默认模板是 10in × 7.5in（4:3）。**不显式设就是 4:3**。
3. 图片放进占位符时若给 `width=Inches(x)` 又不给 `height`，`python-pptx` 按图片原始比例算高度 —— 于是高度溢出页面，但**不会报错**，只是被裁掉。

## 做法

### 1. 批量读：递归遍历，别只看顶层

```python
def _walk_shapes(shapes):
    for sh in shapes:
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from _walk_shapes(sh.shapes)   # 组合形状必须递归，否则整块文字凭空消失
        else:
            yield sh
```

- 文字：`sh.has_text_frame` → 逐 `paragraph` 逐 `run`（`run` 级别才拿得到字号/加粗）。
- 备注：`slide.notes_slide.notes_text_frame.text`（**注意**：访问 `notes_slide` 会顺手创建一个空备注页，纯读取场景要接受这点副作用，或者先用 XML 判断存在性）。
- 图片：`sh.shape_type == PICTURE` → `sh.image.blob / ext / size`。
- 表格：`sh.has_table` → 逐 `cell.text`。

### 2. 批量写：先定画布，再排内容

```python
from pptx import Presentation
from pptx.util import Inches

prs = Presentation()
prs.slide_width  = Inches(10)      # 3:4 竖版
prs.slide_height = Inches(13.33)
blank = prs.slide_layouts[6]       # 布局 6 = 全空白，避开占位符的默认边距

for img in sorted(images, key=lambda p: p.stem):
    s = prs.slides.add_slide(blank)
    s.shapes.add_picture(str(img), 0, 0, width=prs.slide_width, height=prs.slide_height)
```

- **显式设 `slide_width/slide_height`**，一页定全局，之后所有 `add_picture` 都跟这个比例走。
- 满版铺图：`left=0, top=0, width=slide_width, height=slide_height` 三个都给，避免默认比例撑破页面。
- 排序键用**文件名**（时间戳命名时天然有序），不要用 `os.listdir` 的返回顺序。

### 3. 核验：写完必须读回来

```python
chk = Presentation(out)
assert len(chk.slides) == expected_pages
assert (chk.slide_width, chk.slide_height) == (Inches(10), Inches(13.33))
```

- 页数、画布尺寸、每页 shape 数、内嵌图片字节数 —— 这四项读回来对得上，才算写完。
- 更狠一点：把 pptx 渲染成 PNG（`soffice --convert-to pdf` 再 `pdftoppm`），肉眼看第一页和最后一页。

### 4. 改用"结构化生成"而不是"模板套改"

- 需要"每页标题 + 正文 + 图"的固定版式时，写一个函数 `add_slide(title, paragraphs, bullets, image)` 比去改模板的占位符稳得多。
- 占位符（placeholder）的继承边距、字体、项目符号层级，在不同模板里差异极大；一旦要"批量"，这些继承关系就是 bug 温床。

## 边界

- **`python-pptx` 不能做的事**：动画、切换效果、SmartArt 内容、图表的数据源重绑、VBA。要这些只能走 COM（Windows + 装了 Office）或 `python-pptx` 之外的库。
- **中文与特殊字形**：`.pptx` 里字体是按 `run.font.name` 记的，且中外文可分别设（`ea` 字体）。换了机器没装同名字体，PowerPoint 会静默替换，排版跑位但**文件本身没坏** —— 这类"看起来坏了"的报障，九成是字体缺失。
- **图片嵌入 vs 链接**：`add_picture` 是**嵌入**（进 zip 的 `ppt/media/`）。原图删了也不影响，代价是文件变大。不做"链接图片"。
- **批量并发写不安全**：多个进程写同一个 `.pptx` 必然互相覆盖。要并行就一进程一文件，最后合并由单进程做。
- **`.ppt` / `.pptm` 不支持**：前者要 LibreOffice 转换，后者是带宏的容器，`python-pptx` 会丢宏 —— 带宏的文件不要用它处理。

# Markdown → docx → PDF 流水线

> 最容易被忽略的一步不是生成，是**验证生成的产物**：字体有没有嵌进去、页数对不对、表格有没有错格。

## 现象

用脚本把 `.md` 转成 `.docx`，再转 PDF 交付。看起来成功了：

- 文件生成了，能打开
- 页数"大概对"
- 在**你的**电脑上看着挺好

但对方打开时：

- 中文变成方块 / 变成宋体（字体没嵌入或对方没装）
- 表格某一列挤成一条竖线
- 标题跑到第二页
- 公式变成一串乱码字符

而你的脚本从头到尾**一个报错都没有**。

## 根因

三个环节都在"乐观成功"：

1. **字体**：docx 只存字体名，渲染时靠本机字体。**名字对了不等于字形对了**，名字错了会静默回退。
2. **版面**：行高、列宽是"建议值"，渲染器可以自行调整；跨页断行更是渲染器决定。
3. **转换**：md → docx 时，复杂结构（合并单元格、嵌套列表、公式、脚注）常常被降级或丢弃，但转换器不报错。

## 做法

### 一、分三步，每步都验

```
.md（唯一源）
  ↓ 生成
.docx（可编辑交付物）
  ↓ 转换
.pdf（定稿交付物）
```

**不要跳过 docx 直接从 md 生成 PDF** —— 很多期刊/单位要求可编辑的 docx，而且 docx 是人工最后校对的地方。

### 二、docx 的逐格 diff

docx 是 zip，正文在 `word/document.xml`。要做**段落级**和**表格逐格**比对，而不是 diff 整个 zip（二进制不可读）。

```python
from docx import Document

def iter_cells(doc):
    """遍历所有段落与表格单元格，产出 (位置, 文本)"""
    for i, p in enumerate(doc.paragraphs):
        t = p.text.strip()
        if t:
            yield f"P{i}", t
    for ti, table in enumerate(doc.tables):
        for ri, row in enumerate(table.rows):
            for ci, cell in enumerate(row.cells):
                t = cell.text.strip()
                if t:
                    yield f"T{ti}R{ri}C{ci}", t

def diff_docx(a_path, b_path):
    a = dict(iter_cells(Document(a_path)))
    b = dict(iter_cells(Document(b_path)))
    only_a = {k: v for k, v in a.items() if b.get(k) != v}
    only_b = {k: v for k, v in b.items() if a.get(k) != v}
    return only_a, only_b
```

**为什么要逐格**：整段 diff 看不出"表格里第 3 行第 2 列的值从 12.4 变成了 12.9"，而这正是最危险的改动。

### 三、字体签名检查

确认**你要求的字体真的被用上了**，而不是被回退：

```python
from docx import Document
from docx.oxml.ns import qn

def fonts_used(path):
    doc = Document(path)
    names = set()
    for p in doc.paragraphs:
        for run in p.runs:
            if run.font.name:
                names.add(run.font.name)
            # 中文字体在 rPr/rFonts 的 eastAsia 属性里，run.font.name 拿不到
            rpr = run._element.find(qn('w:rPr'))
            if rpr is not None:
                rfonts = rpr.find(qn('w:rFonts'))
                if rfonts is not None:
                    for attr in ('w:eastAsia', 'w:ascii', 'w:hAnsi'):
                        v = rfonts.get(qn(attr))
                        if v:
                            names.add(v)
    return names
```

**关键坑**：中文字体名存在 `w:rFonts` 的 `w:eastAsia` 属性里。只读 `run.font.name` 会漏掉全部中文字体设置，让你误以为"没设字体"。

### 四、PDF 的页数与内嵌字体清单

```bash
# pdffonts 打印每个字体的类型与是否嵌入（Em 列 = embedded）
pdffonts output.pdf

# pdfinfo 看页数与尺寸
pdfinfo output.pdf | grep -E 'Pages|Page size'
```

判读要点：

| 输出 | 含义 |
|---|---|
| `Em = yes` | 已嵌入，安全 |
| `Em = no` | **未嵌入**，对方机器没有这个字体就会替换 |
| 字体名带 `_GB2312` 之类后缀 | 你或模板指定了非系统字体，检查是否真的存在 |
| 页数与你预期的差 1–2 页 | 行距/边距不符，回头查 22 行是否排满 |

### 五、跨页与断行的实测

版面问题**只能看，不能算**。最快的验证是：把 PDF 渲染成图片，看关键页面。

```bash
# pdftoppm 渲染指定页为 PNG，一眼看断行与表格
pdftoppm -f 1 -l 1 -r 110 -png output.pdf page
```

对长文档，至少检查：首页、每个一级标题所在页、每个大表格所在页、末页。

## 边界

- 逐格 diff 只对**结构稳定**的版本对比有意义。如果同时改了版式（列宽、合并单元格），位置索引会错位，diff 结果会全是噪声 —— 这种情况先比内容、再比版式，分开做。
- 字体嵌入能让 PDF 在任何机器上显示一致，但**不能让 docx 一致**。docx 的字体永远依赖打开它的机器。
- 一些转换器（尤其在线服务）会把字体转成轮廓或子集化，`pdffonts` 的输出会跟桌面版不同，属正常。
- 版式修正是允许改变渲染结果的。**不要为了"逐字节一致"而拒绝改进排版** —— 但每次改动都要能举证（改了什么、为什么、影响哪些页）。

## 一句话记法

> **生成成功 ≠ 交付合格。docx 要逐格 diff，中文字体要读 `w:eastAsia`，PDF 要查 `Em = yes` 和页数。**

"""Build bilingual DOCX exports from the checked-in Markdown sources.

Run with Python 3.12 and python-docx==1.2.0, then render and inspect every
page before replacing the PDF exports. No network or external API is used.
"""
from pathlib import Path
import re

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from docx.opc.constants import RELATIONSHIP_TYPE as RT

ROOT = Path(__file__).resolve().parents[1]
TOKENS = re.compile(r"(\*\*|\[([^\]]+)\]\(([^)]+)\))")


def inline(paragraph, text):
    position, bold = 0, False
    for token in TOKENS.finditer(text):
        if token.start() > position:
            paragraph.add_run(text[position:token.start()]).bold = True if bold else None
        if token.group(1) == "**":
            bold = not bold
        else:
            link = OxmlElement("w:hyperlink")
            link.set(qn("r:id"), paragraph.part.relate_to(token.group(3), RT.HYPERLINK, is_external=True))
            run, props, value = OxmlElement("w:r"), OxmlElement("w:rPr"), OxmlElement("w:t")
            color = OxmlElement("w:color")
            color.set(qn("w:val"), "20466C")
            props.append(color)
            if bold:
                props.append(OxmlElement("w:b"))
            run.append(props)
            value.text = token.group(2)
            run.append(value)
            link.append(run)
            paragraph._p.append(link)
        position = token.end()
    if position < len(text):
        paragraph.add_run(text[position:]).bold = True if bold else None


def build(language):
    doc = Document()
    for border in doc.styles.element.xpath('.//w:pBdr'):
        border.getparent().remove(border)
    section = doc.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.top_margin, section.bottom_margin = Inches(.5), Inches(.5)
    section.left_margin = section.right_margin = Inches(.65)
    for name in ["Normal", "Title", "Subtitle", "Heading 1"]:
        style = doc.styles[name]
        style.font.name = "Calibri"
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.font.italic = False
        style.font.underline = False
        style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "Noto Sans CJK SC")
    normal = doc.styles["Normal"]
    normal.font.size = Pt(10.5)
    normal.paragraph_format.space_after = Pt(4)
    normal.paragraph_format.line_spacing = Pt(14)
    for name, size, before, after in [("Title", 24, 0, 4), ("Subtitle", 12, 0, 5), ("Heading 1", 12, 8, 4)]:
        style = doc.styles[name]
        style.font.size = Pt(size)
        style.font.bold = True
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True
    lines = (ROOT / "resume" / f"Resume_{language}.md").read_text(encoding="utf-8").splitlines()
    subtitle = False
    for line in lines:
        if not line.strip():
            continue
        if line.startswith("# "):
            inline(doc.add_paragraph(style="Title"), line[2:])
            subtitle = True
        elif line.startswith("## "):
            inline(doc.add_paragraph(style="Heading 1"), line[3:])
        elif subtitle:
            inline(doc.add_paragraph(style="Subtitle"), line)
            subtitle = False
        elif line.startswith("- "):
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Inches(.12)
            paragraph.paragraph_format.first_line_indent = Inches(-.12)
            inline(paragraph, "• " + line[2:])
        else:
            inline(doc.add_paragraph(), line)
    doc.core_properties.author = "Yiyu Zhu"
    doc.core_properties.title = "Yiyu Zhu Resume" if language == "EN" else "朱奕宇简历"
    doc.save(ROOT / "resume" / f"Resume_{language}.docx")


if __name__ == "__main__":
    for language in ["EN", "ZH"]:
        build(language)

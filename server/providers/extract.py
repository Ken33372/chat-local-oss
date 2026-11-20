"""本地文本抽取：数字版 PDF 用 pypdf，docx/pptx 用标准库解 zip+XML。

抽不出文字（扫描件、纯图 PDF）时抛 EmptyDocument，由上层决定回退 OCR 还是报错。
"""
from __future__ import annotations

import io
import re
import zipfile
from xml.etree import ElementTree

MAX_CHARS = 200_000
MAX_PAGES = 400
_SLIDE_RE = re.compile(r"^ppt/slides/slide\d+\.xml$")


class EmptyDocument(ValueError):
    pass


def available() -> bool:
    try:
        import pypdf  # noqa: F401
    except ImportError:
        return False
    return True


def _pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception as error:
            raise ValueError(f"PDF 已加密，无法读取：{error}")
    parts: list[str] = []
    size = 0
    for page in reader.pages[:MAX_PAGES]:
        text = page.extract_text() or ""
        parts.append(text)
        size += len(text)
        if size >= MAX_CHARS:
            break
    return "\n\n".join(parts)


def _xml_text(blob: bytes) -> str:
    root = ElementTree.fromstring(blob)
    parts: list[str] = []
    for node in root.iter():
        if not node.tag.endswith("}p"):
            continue
        text = "".join(
            child.text or "" for child in node.iter() if child.tag.endswith("}t")
        )
        if text.strip():
            parts.append(text)
    return "\n".join(parts)


def _docx(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        try:
            blob = archive.read("word/document.xml")
        except KeyError:
            raise ValueError("docx 里没有 word/document.xml，文件可能损坏")
    return _xml_text(blob)


def _pptx(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = sorted(name for name in archive.namelist() if _SLIDE_RE.match(name))
        if not names:
            raise ValueError("pptx 里没有幻灯片内容")
        return "\n\n".join(_xml_text(archive.read(name)) for name in names)


def extract(name: str, data: bytes) -> str:
    ext = (name or "").rsplit(".", 1)[-1].lower() if "." in (name or "") else ""
    if ext == "pdf":
        text = _pdf(data)
    elif ext == "docx":
        text = _docx(data)
    elif ext == "pptx":
        text = _pptx(data)
    elif ext == "doc":
        raise ValueError("老 .doc 是二进制格式，本地解析不支持；请另存为 .docx，或改用 DeepSeek OCR")
    else:
        raise ValueError(f"本地解析不支持 .{ext or '未知'} 格式")
    if not text.strip():
        raise EmptyDocument("没有可抽取的文字（可能是扫描件），需要 OCR")
    return text[:MAX_CHARS]

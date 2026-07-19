from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader


RUN_ROOT = Path(__file__).resolve().parents[1]
PDF_ROOT = RUN_ROOT / "attachments" / "01"
TEXT_ROOT = RUN_ROOT / "tmp" / "pdfs"
TEXT_ROOT.mkdir(parents=True, exist_ok=True)

for pdf_path in sorted(PDF_ROOT.glob("*.pdf")):
    reader = PdfReader(str(pdf_path))
    output_path = TEXT_ROOT / f"{pdf_path.stem}.txt"
    chunks: list[str] = []
    for page_number, page in enumerate(reader.pages, start=1):
        chunks.append(f"\n===== PAGE {page_number} =====\n")
        chunks.append(page.extract_text() or "")
    output_path.write_text("".join(chunks), encoding="utf-8")
    print(f"EXTRACTED {pdf_path.name}: {len(reader.pages)} pages -> {output_path}")

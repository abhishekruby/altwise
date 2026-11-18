"""Generates the demo PDFs and the extension icons. Run: python3 dev/make_assets.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def text_pdf(path: Path, lines: list[str]) -> None:
    """A real-text PDF with the usual mistakes: no tags, no title, no language."""
    content = "BT /F1 12 Tf 72 740 Td 16 TL " + " ".join(
        f"({l.replace('(', '[').replace(')', ']')}) '" for l in lines) + " ET"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = "%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out.encode("latin-1")))
        out += f"{i} 0 obj\n{o}\nendobj\n"
    xref = len(out.encode("latin-1"))
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    path.write_bytes(out.encode("latin-1"))


def scanned_pdf(path: Path) -> None:
    """An image-only PDF, like a form that was printed and scanned. Screen readers get nothing."""
    img = Image.new("RGB", (1275, 1650), "#f4f2ec")
    d = ImageDraw.Draw(img)
    h, b = ImageFont.truetype(BOLD, 44), ImageFont.truetype(REG, 30)
    d.text((100, 110), "Willowmere Elementary", font=h, fill="#222")
    d.text((100, 180), "Free and Reduced-Price Meal Application 2026-27", font=b, fill="#222")
    y = 300
    for label in ["Student name", "Grade", "Parent or guardian", "Phone", "Household size", "Monthly income"]:
        d.text((100, y), label, font=b, fill="#333")
        d.line((480, y + 34, 1150, y + 34), fill="#555", width=2)
        y += 110
    d.text((100, y + 40), "Return to the school office by January 15.", font=b, fill="#333")
    img.rotate(0.6, fillcolor="#f4f2ec").save(path, "PDF", resolution=150)


def icons() -> None:
    for size in (16, 32, 48, 128):
        s = size * 4  # draw large, downscale for clean edges
        img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s // 5, fill="#1c1f23")
        font = ImageFont.truetype(BOLD, int(s * 0.62))
        d.text((s * 0.47, s * 0.53), "A", font=font, fill="#ffffff", anchor="mm")
        r = s * 0.13
        d.ellipse((s * 0.72 - r, s * 0.24 - r, s * 0.72 + r, s * 0.24 + r), fill="#2fbf8f")
        img.resize((size, size), Image.LANCZOS).save(ROOT / "public" / f"icon-{size}.png")


if __name__ == "__main__":
    docs = ROOT / "demo" / "docs"
    docs.mkdir(exist_ok=True)
    text_pdf(docs / "winter-newsletter.pdf", [
        "Willowmere Elementary Winter Newsletter, December 2026",
        "",
        "Reading scores are up in every grade. Grade 2 improved the most,",
        "from 55 percent to 68 percent of students reading at grade level.",
        "",
        "Story time with Ms. Okafor is every Tuesday at 10 AM in the library.",
        "Free flu shots: December 3, 3 to 6 PM, in the school gym.",
        "Winter break runs December 21 to January 4.",
    ])
    scanned_pdf(docs / "lunch-form.pdf")
    icons()
    print("ok")

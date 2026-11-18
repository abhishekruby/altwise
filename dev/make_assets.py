"""Generates the demo PDFs, the privacy-test flyers and the extension icons. Run: python3 dev/make_assets.py"""
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


def flyers() -> None:
    """Images for demo/flyers.html, which tests the privacy gate. Three hide a small real photo of
    people inside a text-heavy flyer, the case most likely to slip past a first look. Three have no
    real people: a table, a chart and a cartoon. Photos are cropped from the Unsplash demo photos."""
    img_dir = ROOT / "demo" / "img"
    photo = lambda name, box, size: Image.open(img_dir / name).convert("RGB").crop(box).resize(size, Image.LANCZOS)
    font = lambda size, bold=False: ImageFont.truetype(BOLD if bold else REG, size)

    def flyer(name, size, bg, lines, inset=None):
        img = Image.new("RGB", size, bg)
        d = ImageDraw.Draw(img)
        for xy, text, f, color in lines:
            d.text(xy, text, font=f, fill=color)
        if inset:
            pic, xy = inset
            d.rectangle((xy[0] - 4, xy[1] - 4, xy[0] + pic.width + 3, xy[1] + pic.height + 3), fill="#ffffff")
            img.paste(pic, xy)
        img.save(img_dir / name)

    flyer("flyer-bake-sale.png", (800, 1000), "#fdf3e1", [
        ((60, 70), "Spring Bake Sale", font(64, True), "#7a3b12"),
        ((60, 180), "Friday, April 10", font(36), "#333"),
        ((60, 230), "3 to 5 PM in the gym", font(36), "#333"),
        ((60, 330), "Cookies, muffins and lemonade.", font(28), "#333"),
        ((60, 375), "Every dollar goes to the library fund.", font(28), "#333"),
        ((60, 470), "Volunteers sign up at the front office.", font(28), "#333"),
    ], (photo("photo-classroom.jpg", (250, 100, 1050, 660), (200, 140)), (560, 820)))
    flyer("flyer-concert.png", (900, 420), "#1f3a5f", [
        ((50, 60), "Winter Concert", font(60, True), "#ffffff"),
        ((50, 160), "Thursday, December 17, 6 PM", font(30), "#dbe6f5"),
        ((50, 210), "Grades 3 to 5 choir and band", font(30), "#dbe6f5"),
        ((50, 300), "Doors open at 5:30. Free entry.", font(26), "#dbe6f5"),
    ], (photo("photo-library.jpg", (0, 0, 900, 600), (150, 100)), (700, 280)))
    flyer("banner-field-day.png", (1200, 260), "#2f6b3a", [
        ((40, 50), "Willowmere Wildcats Field Day", font(56, True), "#ffffff"),
        ((40, 150), "May 22 on the back field. Wear green!", font(32), "#e3f2e5"),
    ], (photo("photo-fieldday.jpg", (0, 0, 1200, 675), (150, 84)), (1010, 150)))

    # A bus timetable: text and numbers only.
    img = Image.new("RGB", (700, 520), "#ffffff")
    d = ImageDraw.Draw(img)
    d.text((40, 30), "Bus 12 morning route", font=font(36, True), fill="#222")
    for i, (stop, time) in enumerate([("Oak St & 4th", "7:05"), ("Mill Rd library", "7:12"), ("Pine Ave", "7:20"), ("Willowmere Elementary", "7:31")]):
        y = 120 + i * 90
        d.rectangle((40, y, 660, y + 70), outline="#999", width=2)
        d.text((60, y + 18), stop, font=font(28), fill="#222")
        d.text((540, y + 18), time, font=font(28, True), fill="#222")
    img.save(img_dir / "bus-times.png")

    # A line chart with readable values.
    img = Image.new("RGB", (760, 480), "#ffffff")
    d = ImageDraw.Draw(img)
    d.text((40, 20), "Enrollment, 2021 to 2026", font=font(30, True), fill="#222")
    values = [412, 430, 455, 448, 471, 496]
    x0, y0, w, h = 90, 420, 620, 300
    d.line((x0, y0, x0 + w, y0), fill="#444", width=2)
    d.line((x0, y0, x0, y0 - h), fill="#444", width=2)
    pts = [(x0 + 20 + i * 115, y0 - (v - 380) * 2.4) for i, v in enumerate(values)]
    d.line(pts, fill="#2f5bd3", width=4)
    for i, ((x, y), v) in enumerate(zip(pts, values)):
        d.ellipse((x - 7, y - 7, x + 7, y + 7), fill="#2f5bd3")
        d.text((x - 22, y - 42), str(v), font=font(22, True), fill="#222")
        d.text((x - 26, y0 + 12), str(2021 + i), font=font(20), fill="#444")
    img.save(img_dir / "enrollment-chart.png")

    # A safety poster with cartoon stick figures, which are drawings, not people.
    img = Image.new("RGB", (700, 700), "#fff8c9")
    d = ImageDraw.Draw(img)
    d.text((60, 50), "Walk, don't run", font=font(56, True), fill="#8a1c1c")
    d.text((60, 140), "in the hallways", font=font(40), fill="#333")
    for cx in (200, 470):
        d.ellipse((cx - 40, 280, cx + 40, 360), outline="#222", width=6)
        d.line((cx, 360, cx, 500), fill="#222", width=6)
        d.line((cx, 400, cx - 60, 450), fill="#222", width=6)
        d.line((cx, 400, cx + 60, 450), fill="#222", width=6)
        d.line((cx, 500, cx - 50, 600), fill="#222", width=6)
        d.line((cx, 500, cx + 50, 600), fill="#222", width=6)
    img.save(img_dir / "poster-walk.png")


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
    flyers()
    icons()
    print("ok")

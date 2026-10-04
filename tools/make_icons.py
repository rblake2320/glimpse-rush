"""Generates favicon/app icons and the social share image (og.png) into prototype/.  python tools/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "prototype"
NIGHT, PANEL, LINE, VOLT, VOLT_HI, INK, GOLD = (6, 13, 34), (17, 35, 79), (31, 58, 122), (47, 139, 255), (95, 176, 255), (232, 240, 255), (255, 207, 63)

def font(size, bold=True):
    for f in (["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]):
        try:
            return ImageFont.truetype("C:/Windows/Fonts/" + f, size)
        except OSError:
            pass
    return ImageFont.load_default()

def icon(size):
    """3x3 tile grid on night blue; the revealed tiles hint at a photo showing through."""
    im = Image.new("RGB", (size, size), NIGHT); d = ImageDraw.Draw(im)
    pad, gap = size * 0.14, size * 0.045
    cell = (size - 2 * pad - 2 * gap) / 3
    shown = {1: VOLT_HI, 3: GOLD, 4: VOLT, 8: VOLT_HI}
    for i in range(9):
        x, y = pad + (i % 3) * (cell + gap), pad + (i // 3) * (cell + gap)
        d.rounded_rectangle([x, y, x + cell, y + cell], radius=cell * 0.18, fill=shown.get(i, PANEL), outline=LINE, width=max(1, size // 128))
    return im

for s, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")]:
    icon(s).save(OUT / name)
icon(256).save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])

# share card 1200x630: a real pool photo half hidden under tiles + the title
W, H = 1200, 630
og = Image.new("RGB", (W, H), NIGHT); d = ImageDraw.Draw(og)
photo_path = next((p for p in [OUT / "photos" / "giraffe.jpg", OUT / "photos" / "colosseum.jpg"] if p.exists()), None)
side, x0, y0 = 470, 680, 80
if photo_path:
    ph = Image.open(photo_path).convert("RGB").resize((side, side))
    og.paste(ph, (x0, y0))
n, cell = 5, side / 5
covered = {0, 1, 2, 3, 4, 5, 9, 10, 14, 15, 19, 20, 21, 23, 24}
for i in range(n * n):
    cx, cy = x0 + (i % n) * cell, y0 + (i // n) * cell
    if i in covered:
        d.rectangle([cx, cy, cx + cell, cy + cell], fill=PANEL)
    d.rectangle([cx, cy, cx + cell, cy + cell], outline=LINE, width=3)
d.text((70, 170), "GLIMPSE", font=font(104), fill=INK)
d.text((70, 280), "RUSH", font=font(104), fill=VOLT_HI)
d.text((74, 410), "Same photo. Same clock. See it first.", font=font(34, False), fill=INK)
d.text((74, 470), "Play with friends and family on one link.", font=font(28, False), fill=(143, 166, 214))
og.save(OUT / "og.png", optimize=True)
print("icons + og.png written")

"""Human review gate for fetched photos. Automatic search returns wrong subjects and artwork, so nothing ships unseen.

  python tools/photo_review.py sheets <outdir>        contact sheets of photos not yet reviewed (30 per sheet)
  python tools/photo_review.py decide reject a b c   reject these slugs (removed, remembered so a refetch picks another)
  python tools/photo_review.py decide accept-rest     mark every remaining unreviewed photo as reviewed

Then  python tools/fetch_photos.py  rebuilds photos.js / CREDITS.md (and refetches rejected slugs if wanted).
"""
import json, os, sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PH = ROOT / "prototype" / "photos"
SRC = ROOT / "tools" / "photo_sources.json"
REJ = ROOT / "tools" / "photo_rejects.json"
REV = ROOT / "tools" / "photo_reviewed.json"
load = lambda p, d: json.loads(p.read_text(encoding="utf-8")) if p.exists() else d
save = lambda p, v: p.write_text(json.dumps(v, indent=1, ensure_ascii=False), encoding="utf-8")

src, rej, rev = load(SRC, {}), load(REJ, {}), load(REV, [])
pending = [s for s in src if s not in rev and (PH / f"{s}.jpg").exists()]

if sys.argv[1] == "sheets":
    out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
    cols, cell = 6, 200
    for k in range(0, len(pending), 30):
        chunk = pending[k:k + 30]; rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * cell, rows * (cell + 22)), (20, 20, 30)); d = ImageDraw.Draw(sheet)
        for i, s in enumerate(chunk):
            x, y = (i % cols) * cell, (i // cols) * (cell + 22)
            sheet.paste(Image.open(PH / f"{s}.jpg").resize((cell, cell)), (x, y)); d.text((x + 4, y + cell + 4), s[:30], fill=(255, 255, 255))
        sheet.save(out / f"review{k // 30}.png")
    print(f"{len(pending)} unreviewed photos -> {(len(pending) + 29) // 30} sheets in {out}")
elif sys.argv[1] == "decide" and sys.argv[2] == "reject":
    for s in sys.argv[3:]:
        if s in src:
            rej.setdefault(s, []).append(src.pop(s)["title"])
            (PH / f"{s}.jpg").unlink(missing_ok=True)
        else:
            print("not found:", s)
    save(SRC, src); save(REJ, rej); print("rejected", len(sys.argv) - 3)
elif sys.argv[1] == "decide" and sys.argv[2] == "accept":
    ok = [s for s in sys.argv[3:] if s in pending]
    rev += ok; save(REV, sorted(set(rev))); print("accepted", len(ok), "| not pending:", [s for s in sys.argv[3:] if s not in pending])
elif sys.argv[1] == "decide" and sys.argv[2] == "accept-rest":
    rev += pending; save(REV, sorted(set(rev))); print("accepted", len(pending))

"""Fetch licence-clean photos for the built-in pool from Wikimedia Commons.

Only public domain, CC0 and CC BY (any version) are accepted: no share-alike, non-commercial or no-derivatives,
because tiling/cropping is an adaptation and the game may be commercial. Every photo keeps its author, licence
and source page for the in-game credit line and photos/CREDITS.md.

Usage:  python tools/fetch_photos.py            (fetch everything missing)
        python tools/fetch_photos.py --redo slug (refetch one, skipping files listed in tools/photo_rejects.json)
Output: prototype/photos/<slug>.jpg (900x900, EXIF stripped), prototype/photos/photos.js, prototype/photos/CREDITS.md
"""
import hashlib, io, json, re, sys, time, urllib.error, urllib.parse, urllib.request
from html import unescape
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "prototype" / "photos"
CATALOG = json.loads((ROOT / "tools" / "photo_catalog.json").read_text(encoding="utf-8"))
REJECTS_FILE = ROOT / "tools" / "photo_rejects.json"
REJECTS = json.loads(REJECTS_FILE.read_text(encoding="utf-8")) if REJECTS_FILE.exists() else {}
CHOSEN_FILE = ROOT / "tools" / "photo_sources.json"
CHOSEN = json.loads(CHOSEN_FILE.read_text(encoding="utf-8")) if CHOSEN_FILE.exists() else {}
UA = "GlimpseRushPhotoFetcher/0.1 (personal game project; contact via github.com/rblake2320)"
API = "https://commons.wikimedia.org/w/api.php"
SIZE = 900
ART = re.compile(r"paint|drawing|illustrat|engrav|lithograph|poster|map\b|mosaic|fresco|cartoon|postcard|stamp|print|sketch|diagram|logo|coat of arms|museum|figurine|toy", re.I)

def ok_license(short):
    s = (short or "").lower().strip()
    if re.search(r"by-sa|by sa|\bsa\b|-nc|\bnc\b|-nd|\bnd\b|gfdl|fair use|copyright", s):
        return False
    return bool(re.match(r"^(public domain|pd\b|pd-|cc0|cc by \d|cc-by-\d)", s))

def get(url, tries=6):
    """GET with backoff: Wikimedia answers 429 when asked too fast; honour Retry-After."""
    for n in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503) or n == tries - 1:
                raise
            wait = int(e.headers.get("Retry-After") or 0) or 5 * 2 ** n
            print(f"     (rate limited, waiting {wait}s)", flush=True)
            time.sleep(min(wait, 120))

def strip_html(s):
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", "", s or ""))).strip()

def search(q, extra):
    params = {
        "action": "query", "format": "json", "generator": "search", "gsrnamespace": "6", "gsrlimit": "40",
        "gsrsearch": f"{q} filetype:bitmap {extra}".strip(), "prop": "imageinfo",
        "iiprop": "url|size|mime|extmetadata", "iiurlwidth": "1400",
    }
    data = json.loads(get(API + "?" + urllib.parse.urlencode(params)))
    pages = sorted(data.get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 999))
    return pages

STOP = {"the", "of", "and", "a", "an", "de", "la", "le", "st", "mount", "tree", "building"}

def title_ok(entry, title):
    """The file title must name the subject (any accepted answer, word stems), so a search hit on a
    look-alike or an unrelated photographer's caption ("Dragon" capsule for dragonfly) is skipped."""
    t = re.sub(r"[^a-z0-9]+", " ", title.lower())
    for ans in entry["accepted"]:
        words = [w for w in re.sub(r"[^a-z0-9]+", " ", ans.lower()).split() if w not in STOP and len(w) >= 3]
        if words and all(re.search(r"\b" + re.escape(w.rstrip("s")[:max(4, len(w) - 2)]), t) for w in words):
            return True
    return False

def pick(entry):
    rejected = set(REJECTS.get(entry["slug"], []))
    # curated photographs first: Quality images are vetted photos; Featured pictures include paintings and maps
    for extra in ('incategory:"Quality images"', 'incategory:"Featured pictures on Wikimedia Commons"', ""):
        for p in search(entry["q"], extra):
            ii = (p.get("imageinfo") or [{}])[0]
            md = ii.get("extmetadata", {})
            lic = md.get("LicenseShortName", {}).get("value", "")
            w, h = ii.get("width", 0), ii.get("height", 0)
            if p["title"] in rejected or ii.get("mime") != "image/jpeg" or not ok_license(lic):
                continue
            # the pool is real photographs: skip artwork, prints, maps and ephemera by file title
            if ART.search(p["title"]) or not title_ok(entry, p["title"]):
                continue
            if min(w, h) < 900 or not (0.66 <= w / max(h, 1) <= 1.8):
                continue
            return {
                "title": p["title"], "page": ii.get("descriptionurl"), "thumb": ii.get("thumburl") or ii.get("url"),
                "author": strip_html(md.get("Artist", {}).get("value", "")) or "Unknown author",
                "license": lic, "license_url": md.get("LicenseUrl", {}).get("value", ""),
            }
        time.sleep(1.5)
    return None

def save(entry, src):
    img = Image.open(io.BytesIO(get(src["thumb"])))
    img = ImageOps.exif_transpose(img).convert("RGB")
    img = ImageOps.fit(img, (SIZE, SIZE), Image.LANCZOS, centering=(0.5, 0.5))
    img.save(OUT / f"{entry['slug']}.jpg", "JPEG", quality=80, optimize=True, progressive=True)  # no EXIF written

def build_outputs():
    items, credits = [], ["# Photo credits\n", "Built-in photos from Wikimedia Commons. Cropped square and resized for the game.\n",
                          "| Photo | Author | Licence | Source |", "|---|---|---|---|"]
    for e in CATALOG:
        src = CHOSEN.get(e["slug"])
        if not src or not (OUT / f"{e['slug']}.jpg").exists():
            continue
        items.append({"slug": e["slug"], "category": e["cat"], "accepted": e["accepted"], "partial": e["partial"],
                      "src": f"photos/{e['slug']}.jpg?v={hashlib.sha256((OUT / (e['slug'] + '.jpg')).read_bytes()).hexdigest()[:10]}",  # cache-busting: photos are cached for a year
                      "credit": {"author": src["author"][:120], "license": src["license"], "page": src["page"]}})
        credits.append(f"| {e['accepted'][0]} | {src['author'][:80]} | {src['license']} | {src['page']} |")
    (OUT / "photos.js").write_text(
        "/* Generated by tools/fetch_photos.py. Do not edit by hand. */\nwindow.GR_PHOTOS=" +
        json.dumps(items, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    (OUT / "CREDITS.md").write_text("\n".join(credits) + "\n", encoding="utf-8")
    return len(items)

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    redo = sys.argv[sys.argv.index("--redo") + 1:] if "--redo" in sys.argv else []
    missing = []
    for e in CATALOG:
        if e["slug"] in CHOSEN and (OUT / f"{e['slug']}.jpg").exists() and e["slug"] not in redo:
            continue
        try:
            src = pick(e)
            if not src:
                missing.append(e["slug"]); print("NONE ", e["slug"]); continue
            save(e, src)
            CHOSEN[e["slug"]] = src
            CHOSEN_FILE.write_text(json.dumps(CHOSEN, indent=1, ensure_ascii=False), encoding="utf-8")
            print("OK   ", flush=True) if False else print("OK   ", e["slug"], "|", src["license"], "|", src["title"][:70])
        except Exception as ex:  # keep going; report at the end
            missing.append(e["slug"]); print("ERR  ", e["slug"], ex)
        time.sleep(2.0)
    n = build_outputs()
    print(f"\n{n}/{len(CATALOG)} photos in pool. Missing: {missing}")

if __name__ == "__main__":
    main()

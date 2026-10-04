// Fails if any source file contains a control character (e.g. a backspace that a bad escape turned "\b" into).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const EXT = new Set([".js", ".mjs", ".html", ".sql", ".py", ".json", ".md", ".toml", ".yml"]);
const SKIP = new Set(["node_modules", ".git", "photos", ".wrangler", "__pycache__"]);
const bad = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    if (SKIP.has(f)) continue;
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (EXT.has(extname(f))) {
      const s = readFileSync(p, "utf8");
      s.split("\n").forEach((line, i) => { if (/[\x00-\x08\x0b\x0c\x0e-\x1f]|\r(?!$)/.test(line)) bad.push(`${p}:${i + 1}`); });
    }
  }
})(ROOT);
if (bad.length) { console.error("control characters found:\n" + bad.join("\n")); process.exit(1); }
console.log("no control characters in source");

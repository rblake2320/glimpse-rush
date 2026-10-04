// npm run deploy: stamp the build, then publish a copy of prototype/ that contains only photos a person has reviewed
// (tools/photo_reviewed.json). Fetched-but-unreviewed photos can be wrong or unsuitable and must never be reachable.
import { execSync } from "node:child_process";
import { cpSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
execSync("node scripts/stamp.mjs", { cwd: ROOT, stdio: "inherit" });
const reviewed = new Set(JSON.parse(readFileSync(join(ROOT, "tools/photo_reviewed.json"), "utf8")));
const out = mkdtempSync(join(tmpdir(), "gr-deploy-"));
let skipped = 0;
cpSync(join(ROOT, "prototype"), out, { recursive: true, filter: (src) => {
  if (basename(dirname(src)) === "photos" && src.endsWith(".jpg") && !reviewed.has(basename(src, ".jpg"))) { skipped++; return false; }
  return true;
} });
console.log(`deploying ${out} (${skipped} unreviewed photos left out)`);
execSync(`npx wrangler pages deploy "${out}" --project-name glimpse-rush --branch main --commit-dirty=true`, { cwd: ROOT, stdio: "inherit" });

// Writes prototype/version.json before a deploy, so open pages can notice a new version and reload themselves.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
let commit = "dev";
try { commit = execSync("git rev-parse --short HEAD").toString().trim(); } catch {}
const build = `${commit}-${Date.now().toString(36)}`;
writeFileSync(new URL("../prototype/version.json", import.meta.url), JSON.stringify({ build }) + "\n");
console.log("build", build);

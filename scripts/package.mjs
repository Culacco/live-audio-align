import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid release version");
// Explicit allowlist: no tests, profiles, .git history, credentials or unrelated files.
const files = ["manifest.json", "service-worker.js", "content-script.js", "offscreen.html",
  "offscreen.js", "matcher.js", "pcm-tap.worklet.js", "bilibili-delay.worklet.js",
  "sidepanel.html", "sidepanel.css", "sidepanel.js", "LICENSE", "README.md", "PRIVACY.md"];
for (const name of files) await access(resolve(root, name));
const staging = await mkdtemp(resolve(tmpdir(), "live-audio-align-package-"));
const folder = resolve(staging, "live-audio-align");
const dist = resolve(root, "dist");
const name = `live-audio-align-v${manifest.version}.zip`;
try {
  await mkdir(folder);
  await mkdir(dist, { recursive: true });
  for (const file of files) await copyFile(resolve(root, file), resolve(folder, file));
  execFileSync("zip", ["-q", "-X", resolve(staging, name),
    ...files.map((file) => `live-audio-align/${file}`)], { cwd: staging, stdio: "pipe" });
  const archive = await readFile(resolve(staging, name));
  await rename(resolve(staging, name), resolve(dist, name));
  const hash = createHash("sha256").update(archive).digest("hex");
  await writeFile(resolve(dist, `${name}.sha256`), `${hash}  ${name}\n`);
  console.log(`Built dist/${name} (${archive.length} bytes, ${files.length} allowlisted files)`);
  console.log(`SHA-256: ${hash}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}

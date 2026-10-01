import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version);
assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "offscreen", "scripting", "tabCapture"]);
assert.deepEqual([...manifest.host_permissions].sort(), [
  "https://live.bilibili.com/*", "https://webplayer.tv.in/*", "https://www.yangshipin.cn/*"
]);
assert.equal(manifest.background.service_worker, "service-worker.js");
assert.equal(manifest.action.default_popup, "sidepanel.html");
for (const field of ["content_scripts", "externally_connectable", "web_accessible_resources", "side_panel"]) {
  assert.equal(manifest[field], undefined, `Unexpected ${field}`);
}
assert.equal(manifest.content_security_policy.extension_pages,
  "script-src 'self'; object-src 'none'; connect-src 'none'");
assert.equal(Object.keys(pkg.dependencies || {}).length, 0);

let checked = 0;
for (const folder of [root, resolve(root, "scripts"), resolve(root, "tests")]) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      execFileSync(process.execPath, ["--check", resolve(folder, entry.name)], { stdio: "pipe" });
      checked += 1;
    }
  }
}
for (const name of ["offscreen.html", "sidepanel.html"]) {
  const html = await readFile(resolve(root, name), "utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(!/^\w+:|^\/\//.test(match[1]), `Remote HTML resource in ${name}`);
    await access(resolve(root, match[1]));
  }
}
const runtimeFiles = ["service-worker.js", "content-script.js", "offscreen.js", "matcher.js",
  "sidepanel.js", "pcm-tap.worklet.js", "bilibili-delay.worklet.js"];
for (const name of runtimeFiles) {
  const source = await readFile(resolve(root, name), "utf8");
  assert.doesNotMatch(source,
    /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b|chrome\.storage\b|document\.cookie\b|\beval\s*\(|\bnew\s+Function\b/,
    `Unexpected network/storage/dynamic-code API in ${name}`);
  assert.doesNotMatch(source, /\.pause\s*\(|\.currentTime\s*=|\.playbackRate\s*=/,
    `Unexpected player timeline mutation in ${name}`);
  assert.doesNotMatch(source, /\/Users\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/i,
    `Possible personal path/email/token in ${name}`);
  for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.\/[^"']+)["']/g)) {
    await access(resolve(root, match[1]));
  }
}
console.log(`Checks passed: ${checked} JavaScript files; manifest, versions, local resources and runtime policy.`);
console.log("These static checks supplement review; they are not a complete security audit.");

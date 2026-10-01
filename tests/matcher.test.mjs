import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { estimateDelay, updateDelayConsensus } from "../matcher.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function seededNoise(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff - 0.5;
  };
}

test("silence and unrelated noise do not meet the automatic-lock threshold", () => {
  const length = 24 * 8000;
  const zero = new Float32Array(length);
  for (const noisy of [false, true]) {
    const result = estimateDelay({
      tvMono: noisy ? Float32Array.from({ length }, seededNoise(31)) : zero,
      tvSide: zero, tvStartTime: 0,
      bilibiliMono: noisy ? Float32Array.from({ length }, seededNoise(97)) : zero,
      bilibiliSide: zero, bilibiliStartTime: 0,
      sampleRate: 8000, searchRadiusSec: 66, maximumDelaySec: 66
    });
    assert.ok(!result.ok || result.confidence < 0.55, JSON.stringify(result));
  }
});

function commonWorldFeed(time) {
  const engine =
    0.18 * Math.sin(2 * Math.PI * (145 + 18 * Math.sin(time * 0.31)) * time) +
    0.09 * Math.sin(2 * Math.PI * 312 * time);
  const events = [2.4, 5.7, 9.2, 13.9, 18.4, 22.8];
  let transients = 0;
  for (const eventTime of events) {
    const distance = time - eventTime;
    if (distance >= 0 && distance < 0.8) {
      transients +=
        Math.exp(-distance * 5.5) *
        (0.8 * Math.sin(2 * Math.PI * 820 * distance) +
          0.45 * Math.sin(2 * Math.PI * 1640 * distance));
    }
  }
  const crowdEnvelope = 0.08 + 0.07 * Math.max(0, Math.sin(time * 0.73));
  return engine + transients + crowdEnvelope * Math.sin(2 * Math.PI * 490 * time);
}

function commentary(time, languageOffset) {
  const syllables = Math.max(0, Math.sin(time * (4.3 + languageOffset) + languageOffset));
  return (
    syllables *
    (0.22 * Math.sin(2 * Math.PI * (118 + languageOffset * 17) * time) +
      0.15 * Math.sin(2 * Math.PI * (236 + languageOffset * 29) * time))
  );
}

function makeStreams({
  delaySec,
  durationSec = 28,
  sampleRate = 8000,
  tvStartTime = 0,
  bilibiliStartTime = 0,
  commonScale = 1,
  commentaryScale = 1,
  sideScale = 1
}) {
  const length = Math.floor(durationSec * sampleRate);
  const tvMono = new Float32Array(length);
  const tvSide = new Float32Array(length);
  const bilibiliMono = new Float32Array(length);
  const bilibiliSide = new Float32Array(length);
  const tvNoise = seededNoise(42);
  const bilibiliNoise = seededNoise(99);

  for (let index = 0; index < length; index += 1) {
    const localTime = index / sampleRate;
    const tvTime = tvStartTime + localTime;
    const bilibiliTime = bilibiliStartTime + localTime;
    const tvContentTime = tvTime - delaySec;
    const tvCommon = tvContentTime >= 0 ? commonWorldFeed(tvContentTime) : 0;
    const bilibiliCommon = commonWorldFeed(bilibiliTime);
    tvMono[index] =
      tvCommon * 0.58 * commonScale +
      commentary(tvTime, 0.3) * 1.2 * commentaryScale +
      tvNoise() * 0.025;
    bilibiliMono[index] =
      bilibiliCommon * 0.52 * commonScale +
      commentary(bilibiliTime, 1.7) * 1.25 * commentaryScale +
      bilibiliNoise() * 0.025;
    tvSide[index] = (tvCommon * 0.48 + tvNoise() * 0.02) * sideScale;
    bilibiliSide[index] =
      (bilibiliCommon * 0.44 + bilibiliNoise() * 0.02) * sideScale;
  }

  return {
    tvMono,
    tvSide,
    tvStartTime,
    bilibiliMono,
    bilibiliSide,
    bilibiliStartTime,
    sampleRate
  };
}

test("finds commentary delay from a shared world-feed background", () => {
  const expectedDelay = 4.2;
  const streams = makeStreams({ delaySec: expectedDelay });
  const result = estimateDelay({
    ...streams,
    tvStartTime: 0,
    bilibiliStartTime: 0,
    initialDelaySec: 3.8,
    searchRadiusSec: 2,
    minimumOverlapSec: 8
  });
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.delaySec - expectedDelay) <= 0.06, JSON.stringify(result));
  assert.ok(result.confidence >= 0.45, JSON.stringify(result));
  assert.equal(result.resolutionMs, 10);
  assert.ok(result.stableWindowCount >= 2, JSON.stringify(result));
});

test("handles a sports-stream-sized delay without touching either player clock", () => {
  const expectedDelay = 38.2;
  const streams = makeStreams({ delaySec: expectedDelay, durationSec: 66 });
  const result = estimateDelay({
    ...streams,
    tvStartTime: 0,
    bilibiliStartTime: 0,
    initialDelaySec: 40,
    searchRadiusSec: 8,
    minimumOverlapSec: 8
  });
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.delaySec - expectedDelay) <= 0.06, JSON.stringify(result));
  assert.ok(result.confidence >= 0.45, JSON.stringify(result));
  assert.equal(result.resolutionMs, 10);
});

test("stays accurate when the two captures begin at different times", () => {
  const expectedDelay = 38.23;
  const streams = makeStreams({
    delaySec: expectedDelay,
    durationSec: 70,
    tvStartTime: 0,
    bilibiliStartTime: 6.4
  });
  const result = estimateDelay({
    ...streams,
    initialDelaySec: 39,
    searchRadiusSec: 6,
    minimumOverlapSec: 8
  });

  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.delaySec - expectedDelay) <= 0.06, JSON.stringify(result));
  assert.ok(result.stableWindowCount >= 2, JSON.stringify(result));
});

test("does not depend on stereo cancellation when commentary is dominant", () => {
  const expectedDelay = 12.37;
  const streams = makeStreams({
    delaySec: expectedDelay,
    durationSec: 48,
    commonScale: 0.72,
    commentaryScale: 1.8,
    sideScale: 0
  });
  const result = estimateDelay({
    ...streams,
    initialDelaySec: 13,
    searchRadiusSec: 4,
    minimumOverlapSec: 8
  });

  assert.equal(result.ok, true);
  assert.equal(result.useSide, false);
  assert.ok(Math.abs(result.delaySec - expectedDelay) <= 0.12, JSON.stringify(result));
  assert.ok(result.confidence >= 0.55, JSON.stringify(result));
});

test("can search the full delay range when a player exposes no live-edge clock", () => {
  const expectedDelay = 28.41;
  const streams = makeStreams({
    delaySec: expectedDelay,
    durationSec: 52,
    tvStartTime: 0,
    bilibiliStartTime: 3.2
  });
  const result = estimateDelay({
    ...streams,
    initialDelaySec: 0,
    searchRadiusSec: 74.5,
    minimumOverlapSec: 8,
    maximumDelaySec: 74.5
  });

  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.delaySec - expectedDelay) <= 0.08, JSON.stringify(result));
  assert.equal(result.resolutionMs, 10);
});

test("requires two consistent windows before accepting an automatic delay", () => {
  const first = updateDelayConsensus([], {
    delaySec: 38.21,
    confidence: 0.78
  });
  assert.equal(first.confirmed, false);
  assert.equal(first.reason, "needs-second-window");

  const conflict = updateDelayConsensus(first.history, {
    delaySec: 36.9,
    confidence: 0.83
  });
  assert.equal(conflict.confirmed, false);
  assert.equal(conflict.reason, "candidates-disagree");

  const confirmed = updateDelayConsensus(conflict.history, {
    delaySec: 36.96,
    confidence: 0.8
  });
  assert.equal(confirmed.confirmed, true);
  assert.ok(Math.abs(confirmed.delaySec - 36.93) <= 0.04);
  assert.ok(confirmed.spreadSec <= 0.14);
});

test("manifest references every extension entry point", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  assert.ok(
    manifest.host_permissions.includes("https://www.yangshipin.cn/*"),
    "Yangshipin host permission is missing"
  );
  const required = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    "content-script.js",
    "offscreen.html",
    "offscreen.js",
    "pcm-tap.worklet.js",
    "bilibili-delay.worklet.js",
    "matcher.js"
  ];

  await Promise.all(
    required.map(async (filename) => {
      const content = await readFile(resolve(root, filename));
      assert.ok(content.length > 0, `${filename} is empty`);
    })
  );
});

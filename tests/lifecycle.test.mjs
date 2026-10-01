import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const sourceOf = (name) => readFile(new URL(name, root), "utf8");
const extensionId = "test-extension";
const getURL = (path) => `chrome-extension://${extensionId}/${path}`;
const worker = { id: extensionId, url: getURL("service-worker.js") };
const popup = { id: extensionId, url: getURL("sidepanel.html") };
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function audioHarness({ pendingMedia = false, pendingModules = false, failSource = false } = {}) {
  let listener;
  let resolveMedia;
  let resolveModules;
  const messages = [];
  const contexts = [];
  const nodes = [];
  const streams = [];
  const timers = new Set();
  const makeStream = () => {
    const track = { stopped: false, stop() { this.stopped = true; },
      addEventListener(_event, callback) { this.ended = callback; } };
    const stream = { track, getTracks: () => [track] };
    streams.push(stream);
    return stream;
  };
  class Node {
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  class Context {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
      this.audioWorklet = { addModule: () => pendingModules
        ? (this.modules ??= new Promise((resolve) => { resolveModules = resolve; }))
        : Promise.resolve() };
      contexts.push(this);
    }
    createMediaStreamSource() {
      if (failSource) throw new Error("source creation failed");
      return new Node();
    }
    createGain() { return Object.assign(new Node(), { gain: { value: 1 } }); }
    async close() { this.state = "closed"; }
    async resume() { this.state = "running"; }
  }
  const context = vm.createContext({
    Float32Array, structuredClone, performance,
    setInterval(callback) { const timer = { callback }; timers.add(timer); return timer; },
    clearInterval(timer) { timers.delete(timer); },
    AudioContext: Context,
    AudioWorkletNode: class extends Node {
      constructor() {
        super();
        this.port = { onmessage: null, messages: [], closed: false,
          postMessage(message) { this.messages.push(message); },
          close() { this.closed = true; } };
        nodes.push(this);
      }
    },
    navigator: { mediaDevices: { getUserMedia: () => pendingMedia
      ? new Promise((resolve) => { resolveMedia = () => resolve(makeStream()); })
      : Promise.resolve(makeStream()) } },
    chrome: { runtime: { id: extensionId, getURL,
      sendMessage: async (message) => { messages.push(message); },
      onMessage: { addListener(callback) { listener = callback; } } } },
    estimateDelay: () => ({ ok: false, confidence: 0 }),
    updateDelayConsensus: () => ({ confirmed: false, history: [] })
  });
  vm.runInContext((await sourceOf("offscreen.js")).replace(/^import[^\n]+\n/, ""), context);
  const evaluate = (code) => vm.runInContext(code, context);
  return { evaluate, contexts, nodes, streams, timers, messages,
    releaseMedia: () => resolveMedia(), releaseModules: () => resolveModules(),
    listener: (...args) => listener(...args),
    capture: (role, id = role === "tv" ? 1 : 2) => evaluate(
      `captureStream({role: ${JSON.stringify(role)}, streamId: "test-stream", tab: {id: ${id}, title: "demo", url: "https://example.invalid/?private=value"}})`)
  };
}

test("stop during pending media capture stops the late stream and closes audio", async () => {
  const harness = await audioHarness({ pendingMedia: true });
  const pending = harness.capture("bilibili");
  const rejection = assert.rejects(pending, /连接已取消/);
  await tick();
  await harness.evaluate("stopAll()");
  harness.releaseMedia();
  await rejection;
  assert.ok(harness.streams.every((stream) => stream.track.stopped));
  assert.ok(harness.contexts.every((context) => context.state === "closed"));
  assert.equal(harness.evaluate("graphs.bilibili"), null);
  assert.equal(harness.timers.size, 0);
});

test("stop during worklet loading cannot resurrect a context or start capture", async () => {
  const harness = await audioHarness({ pendingModules: true });
  const pending = harness.capture("tv");
  const rejection = assert.rejects(pending, /连接已取消/);
  await tick();
  await harness.evaluate("stopAll()");
  harness.releaseModules();
  await rejection;
  assert.equal(harness.streams.length, 0);
  assert.equal(harness.contexts[0].state, "closed");
});

test("audio-node construction failure stops the acquired media track", async () => {
  const harness = await audioHarness({ failSource: true });
  await assert.rejects(harness.capture("tv"), /source creation failed/);
  assert.equal(harness.streams[0].track.stopped, true);
  await harness.evaluate("stopAll()");
  assert.equal(harness.contexts[0].state, "closed");
});

test("stop closes every track, worklet port, timer and context", async () => {
  const harness = await audioHarness();
  await harness.capture("tv");
  await harness.capture("bilibili");
  harness.evaluate("startAlignment({initialDelaySec: 0, broadSearch: true})");
  assert.equal(harness.timers.size, 1);
  await harness.evaluate("stopAll()");
  assert.equal(harness.timers.size, 0);
  assert.ok(harness.streams.every((stream) => stream.track.stopped));
  assert.ok(harness.nodes.every((node) => node.port.closed && node.disconnected));
  assert.ok(harness.contexts.every((context) => context.state === "closed"));
});

test("replacement and re-alignment invalidate old PCM and matching candidates", async () => {
  const harness = await audioHarness();
  await harness.capture("tv");
  await harness.capture("bilibili");
  harness.evaluate("startAlignment({initialDelaySec: 0, broadSearch: true})");
  const pcm = { type: "PCM", mono: new Float32Array(1024).buffer,
    side: new Float32Array(1024).buffer, startTime: 0 };
  const oldCallback = harness.nodes[0].port.onmessage;
  oldCallback({ data: pcm });
  assert.ok(harness.evaluate("rings.tv.duration") > 0);
  harness.evaluate("audioContext.currentTime = 10; startAlignment({initialDelaySec: 0, broadSearch: true})");
  oldCallback({ data: pcm });
  assert.equal(harness.evaluate("rings.tv.duration"), 0);
  await harness.capture("tv", 3);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.evaluate("state.alignment.phase"), "idle");
  oldCallback({ data: { ...pcm, startTime: 20 } });
  assert.equal(harness.evaluate("rings.tv.duration"), 0);
  await harness.evaluate("stopAll()");
});

test("manual direction is correct, clamped and rejects invalid values", async () => {
  const harness = await audioHarness();
  assert.equal(harness.evaluate("adjustDelay(100).ok"), false);
  await harness.capture("bilibili");
  assert.equal(harness.evaluate("adjustDelay(-500).delayMs"), 500);
  assert.equal(harness.evaluate("adjustDelay(100).delayMs"), 400);
  assert.equal(harness.evaluate("adjustDelay(1000).delayMs"), 0);
  assert.equal(harness.evaluate("adjustDelay(-999999).delayMs"), 74500);
  assert.equal(harness.evaluate("adjustDelay(Infinity).ok"), false);
  await harness.evaluate("stopAll()");
});

test("capture state does not retain full browsing URLs", async () => {
  const harness = await audioHarness();
  await harness.capture("tv");
  const state = harness.evaluate("publicState()");
  assert.equal(state.captures.tv.url, undefined);
  assert.doesNotMatch(JSON.stringify(state), /private=value/);
  await harness.evaluate("stopAll()");
});

test("track interruption shuts down both sources and notifies the service worker", async () => {
  const harness = await audioHarness();
  await harness.capture("tv");
  await harness.capture("bilibili");
  await harness.streams[0].track.ended();
  assert.ok(harness.streams.every((stream) => stream.track.stopped));
  assert.ok(harness.messages.some((message) => message.type === "SESSION_ENDED"));
  assert.equal(harness.contexts[0].state, "closed");
});

test("offscreen rejects page-sender and popup capture commands", async () => {
  const harness = await audioHarness();
  const message = { target: "offscreen", type: "CAPTURE_STREAM" };
  assert.equal(harness.listener(message, { ...worker, tab: { id: 1 } }, () => {}), false);
  assert.equal(harness.listener(message, popup, () => {}), false);
  assert.equal(harness.listener(message, { id: "other-extension" }, () => {}), false);
  assert.equal(harness.streams.length, 0);
  let state;
  assert.equal(harness.listener({ target: "offscreen", type: "GET_STATE" }, popup,
    (response) => { state = response; }), true);
  assert.equal(state.captures.tv.connected, false);
});

test("invalid source role never opens an AudioContext", async () => {
  const harness = await audioHarness();
  await assert.rejects(harness.capture("__proto__"), /无效/);
  assert.equal(harness.contexts.length, 0);
});

test("service worker closes an unresponsive existing offscreen document on stop", async () => {
  let exists = true;
  let closed = 0;
  let listener;
  const context = vm.createContext({ URL, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: extensionId, getURL,
        getContexts: async () => exists ? [{}] : [],
        sendMessage: async () => { throw new Error("engine unavailable"); },
        onMessage: { addListener(callback) { listener = callback; } } },
      offscreen: { async closeDocument() { closed += 1; exists = false; } },
      tabs: { sendMessage: async () => ({ ok: true }), onRemoved: { addListener() {} } },
      action: { setBadgeText: async () => {} }
    }
  });
  vm.runInContext(await sourceOf("service-worker.js"), context);
  const result = await vm.runInContext("stopSession()", context);
  assert.equal(result.ok, true);
  assert.equal(closed, 1);
  assert.equal(listener({ target: "service-worker", type: "STOP_SESSION" },
    { ...popup, tab: { id: 1 } }, () => {}), false);
  assert.equal(vm.runInContext('roleForUrl("http://live.bilibili.com/")', context), null);
  assert.equal(vm.runInContext('roleForUrl("https://live.bilibili.com.evil.invalid/")', context), null);
});

test("service worker serializes mutations without poisoning later operations", async () => {
  const context = vm.createContext({ URL, chrome: { runtime: {
    onMessage: { addListener() {} } }, tabs: { onRemoved: { addListener() {} } } } });
  vm.runInContext(await sourceOf("service-worker.js"), context);
  const result = await vm.runInContext(`(async () => {
    const order = [];
    const first = serialize(async () => { order.push(1); await Promise.resolve(); order.push(2); throw new Error("expected"); });
    const second = serialize(() => order.push(3));
    await first.catch(() => {}); await second;
    return order;
  })()`, context);
  assert.deepEqual([...result], [1, 2, 3]);
});

test("page hook restores native volume and coalesces DOM activity", async () => {
  let listener;
  let observer;
  let frames = 0;
  let frameCallback;
  const video = { muted: true, volume: 0 };
  const context = vm.createContext({ queueMicrotask,
    chrome: { runtime: { id: extensionId, getURL, onMessage: {
      addListener(callback) { listener = callback; }, removeListener() {} } } },
    document: { documentElement: {}, querySelectorAll: () => [video] },
    requestAnimationFrame(callback) { frames += 1; frameCallback = callback; return frames; },
    cancelAnimationFrame() {},
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {}
      disconnect() {}
    }
  });
  vm.runInContext(await sourceOf("content-script.js"), context);
  listener({ target: "content", type: "SET_CAPTURE_AUDIBLE", role: "bilibili" }, worker, () => {});
  assert.equal(video.muted, false);
  assert.equal(video.volume, 1);
  for (let index = 0; index < 100; index++) observer();
  assert.equal(frames, 1);
  frameCallback();
  listener({ target: "content", type: "RESTORE_NATIVE_AUDIO" }, worker, () => {});
  await tick();
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0);
});

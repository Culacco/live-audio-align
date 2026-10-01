import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const sampleRate = 48000;

async function createProcessor() {
  const source = await readFile(resolve(root, "bilibili-delay.worklet.js"), "utf8");
  let Processor = null;
  const messages = [];
  const context = vm.createContext({
    Float32Array,
    Math,
    Number,
    currentTime: 0,
    sampleRate,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          onmessage: null,
          postMessage: (message) => messages.push(message)
        };
      }
    },
    registerProcessor: (_name, implementation) => {
      Processor = implementation;
    }
  });
  vm.runInContext(source, context, { filename: "bilibili-delay.worklet.js" });
  return {
    context,
    messages,
    processor: new Processor({
      processorOptions: { targetRate: 8000, maxDelaySec: 74.5 }
    })
  };
}

function processSignal(harness, leftSignal, rightSignal = leftSignal) {
  const quantum = 128;
  const leftOutput = new Float32Array(leftSignal.length);
  const rightOutput = new Float32Array(leftSignal.length);

  for (let offset = 0; offset < leftSignal.length; offset += quantum) {
    const inputLeft = new Float32Array(quantum);
    const inputRight = new Float32Array(quantum);
    inputLeft.set(leftSignal.subarray(offset, offset + quantum));
    inputRight.set(rightSignal.subarray(offset, offset + quantum));
    const outputLeft = new Float32Array(quantum);
    const outputRight = new Float32Array(quantum);
    harness.context.currentTime = offset / sampleRate;
    harness.processor.process(
      [[inputLeft, inputRight]],
      [[outputLeft, outputRight]]
    );
    leftOutput.set(outputLeft.subarray(0, Math.min(quantum, leftSignal.length - offset)), offset);
    rightOutput.set(
      outputRight.subarray(0, Math.min(quantum, leftSignal.length - offset)),
      offset
    );
  }

  return { left: leftOutput, right: rightOutput };
}

test("zero-delay mode passes live Bilibili audio without channel leakage", async () => {
  const harness = await createProcessor();
  const left = Float32Array.from({ length: 512 }, (_, index) => Math.sin(index * 0.07));
  const right = new Float32Array(512);
  const output = processSignal(harness, left, right);

  for (let index = 0; index < left.length; index += 1) {
    assert.ok(Math.abs(output.left[index] - left[index]) < 1e-6);
    assert.equal(output.right[index], 0);
  }
});

test("fixed audio delay remains sample-accurate after its crossfade", async () => {
  const harness = await createProcessor();
  harness.processor.port.onmessage({ data: { type: "SET_DELAY", seconds: 0.01 } });

  processSignal(harness, new Float32Array(12000));
  const impulse = new Float32Array(1600);
  const silentRight = new Float32Array(1600);
  impulse[0] = 1;
  const output = processSignal(harness, impulse, silentRight);
  const peakIndex = output.left.reduce(
    (best, value, index) => (Math.abs(value) > Math.abs(output.left[best]) ? index : best),
    0
  );

  assert.equal(peakIndex, 480);
  assert.ok(Math.abs(output.left[peakIndex] - 1) < 1e-6);
  assert.equal(output.right[peakIndex], 0);
});

test("optimized buffers stay below a 40 MiB audio-memory budget", async () => {
  const harness = await createProcessor();
  const delayBytes =
    harness.processor.leftBuffer.byteLength + harness.processor.rightBuffer.byteLength;
  const analysisBytes = 2 * 2 * 75 * 8000 * Float32Array.BYTES_PER_ELEMENT;
  const totalMiB = (delayBytes + analysisBytes) / 1024 / 1024;

  assert.ok(totalMiB < 40, `estimated audio buffers use ${totalMiB.toFixed(1)} MiB`);
});

test("extension code never pauses or seeks either live player", async () => {
  const files = [
    "service-worker.js",
    "content-script.js",
    "offscreen.js",
    "sidepanel.js",
    "pcm-tap.worklet.js",
    "bilibili-delay.worklet.js"
  ];
  const source = (
    await Promise.all(files.map((filename) => readFile(resolve(root, filename), "utf8")))
  ).join("\n");

  assert.doesNotMatch(source, /\.pause\s*\(/);
  assert.doesNotMatch(source, /currentTime\s*=/);
  assert.doesNotMatch(source, /playbackRate\s*=/);
});

test("stopping a session fully tears down every persistent audio resource", async () => {
  const [manifestText, serviceWorker, offscreen] = await Promise.all([
    readFile(resolve(root, "manifest.json"), "utf8"),
    readFile(resolve(root, "service-worker.js"), "utf8"),
    readFile(resolve(root, "offscreen.js"), "utf8")
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.persistent, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.side_panel, undefined);
  assert.equal(manifest.action.default_popup, "sidepanel.html");
  assert.doesNotMatch(serviceWorker, /chrome\.sidePanel/);
  assert.match(serviceWorker, /message\.type === "CAPTURE_ACTIVE_TAB"/);
  assert.match(serviceWorker, /"www\.yangshipin\.cn": "tv"/);
  assert.match(serviceWorker, /broadSearch: true/);
  assert.match(serviceWorker, /chrome\.scripting\.executeScript\(/);
  assert.match(serviceWorker, /chrome\.offscreen\.closeDocument\(\)/);
  assert.match(serviceWorker, /sendToExistingOffscreen\(\{ type: "STOP_ALL" \}\)/);
  assert.match(offscreen, /await context\.close\(\)/);
  assert.match(offscreen, /clearInterval\(matchTimer\)/);
  assert.match(offscreen, /for \(const track of graph\.stream\.getTracks\(\)\) track\.stop\(\)/);

  const captureFlow = serviceWorker.slice(
    serviceWorker.indexOf("async function captureCurrentTab"),
    serviceWorker.indexOf("async function getActiveTab")
  );
  assert.ok(
    captureFlow.indexOf("getMediaStreamId") < captureFlow.indexOf("ensureOffscreenDocument"),
    "tab capture permission must be claimed before async audio-engine setup"
  );

  const closedTabHandler = serviceWorker.slice(
    serviceWorker.indexOf("chrome.tabs.onRemoved.addListener")
  );
  assert.doesNotMatch(closedTabHandler, /sendToOffscreen\(/);
});

test("the on-demand page hook is idempotent and detaches after cleanup", async () => {
  const source = await readFile(resolve(root, "content-script.js"), "utf8");
  const listeners = new Set();
  const observers = [];
  const context = vm.createContext({
    chrome: {
      runtime: {
        id: "test-extension",
        getURL: (path) => `chrome-extension://test-extension/${path}`,
        onMessage: {
          addListener: (listener) => listeners.add(listener),
          removeListener: (listener) => listeners.delete(listener)
        }
      }
    },
    document: {
      documentElement: {},
      querySelectorAll: () => []
    },
    MutationObserver: class {
      constructor() {
        this.disconnected = false;
        observers.push(this);
      }

      observe() {}

      disconnect() {
        this.disconnected = true;
      }
    },
    queueMicrotask
  });

  vm.runInContext(source, context, { filename: "content-script.js" });
  vm.runInContext(source, context, { filename: "content-script.js" });
  assert.equal(listeners.size, 1);

  const listener = [...listeners][0];
  listener(
    { target: "content", type: "SET_CAPTURE_AUDIBLE", role: "tv" },
    { id: "test-extension" },
    () => {}
  );
  assert.equal(observers.length, 1);

  listener({ target: "content", type: "DEACTIVATE" }, { id: "test-extension" }, () => {});
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(listeners.size, 0);
  assert.equal(observers[0].disconnected, true);

  vm.runInContext(source, context, { filename: "content-script.js" });
  assert.equal(listeners.size, 1);
});

test("manual plus moves Chinese audio earlier and minus moves it later", async () => {
  const offscreen = await readFile(resolve(root, "offscreen.js"), "utf8");
  const adjustFlow = offscreen.slice(
    offscreen.indexOf("function adjustDelay"),
    offscreen.indexOf("async function stopAll")
  );

  assert.match(adjustFlow, /previousDelayMs - delta/);
  assert.match(adjustFlow, /state\.alignment\.manualOffsetMs \+= appliedDelayDeltaMs/);
  assert.match(adjustFlow, /appliedTimelineMovementMs > 0/);
});

test("missing live input keeps the delay timeline moving and drains buffered audio", async () => {
  const harness = await createProcessor();
  harness.processor.port.onmessage({ data: { type: "SET_DELAY", seconds: 128 / sampleRate, crossfade: false } });
  const impulse = new Float32Array(128);
  impulse[0] = 1;
  processSignal(harness, impulse);
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  harness.processor.process([[]], [[left, right]]);
  assert.equal(left[0], 1);
  assert.equal(harness.processor.totalWritten, 256);
});

test("analysis is opt-in and stops emitting PCM after disabling", async () => {
  const harness = await createProcessor();
  processSignal(harness, new Float32Array(8192));
  assert.equal(harness.messages.length, 0);
  harness.processor.port.onmessage({ data: { type: "SET_ENABLED", enabled: true } });
  processSignal(harness, new Float32Array(8192));
  assert.ok(harness.messages.length > 0);
  harness.processor.port.onmessage({ data: { type: "SET_ENABLED", enabled: false } });
  const count = harness.messages.length;
  processSignal(harness, new Float32Array(8192));
  assert.equal(harness.messages.length, count);
});

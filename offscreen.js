import { estimateDelay, updateDelayConsensus } from "./matcher.js";

const SAMPLE_RATE = 8000;
const BUFFER_SECONDS = 75;
const MAX_DELAY_SECONDS = 74.5;
const MAX_AUTO_DELAY_SECONDS = 66;

class AudioRingBuffer {
  constructor(seconds = BUFFER_SECONDS, sampleRate = SAMPLE_RATE) {
    this.sampleRate = sampleRate;
    this.capacity = Math.floor(seconds * sampleRate);
    this.mono = new Float32Array(this.capacity);
    this.side = new Float32Array(this.capacity);
    this.writeIndex = 0;
    this.size = 0;
    this.latestTime = 0;
  }

  clear() {
    this.writeIndex = 0;
    this.size = 0;
    this.latestTime = 0;
  }

  append(mono, side, startTime) {
    if (!mono.length) return;
    const expectedStart = this.latestTime;
    if (this.size && Math.abs(startTime - expectedStart) > 0.35) this.clear();

    const length = Math.min(mono.length, this.capacity);
    const sourceOffset = mono.length - length;
    const firstLength = Math.min(length, this.capacity - this.writeIndex);
    const secondLength = length - firstLength;
    this.mono.set(mono.subarray(sourceOffset, sourceOffset + firstLength), this.writeIndex);
    this.side.set(side.subarray(sourceOffset, sourceOffset + firstLength), this.writeIndex);
    if (secondLength) {
      this.mono.set(mono.subarray(sourceOffset + firstLength), 0);
      this.side.set(side.subarray(sourceOffset + firstLength), 0);
    }
    this.writeIndex = (this.writeIndex + length) % this.capacity;
    this.size = Math.min(this.capacity, this.size + length);
    this.latestTime = startTime + mono.length / this.sampleRate;
  }

  get duration() {
    return this.size / this.sampleRate;
  }

  snapshot(seconds = BUFFER_SECONDS) {
    const length = Math.min(this.size, Math.floor(seconds * this.sampleRate));
    const mono = new Float32Array(length);
    const side = new Float32Array(length);
    const start = (this.writeIndex - length + this.capacity) % this.capacity;

    const firstLength = Math.min(length, this.capacity - start);
    const secondLength = length - firstLength;
    mono.set(this.mono.subarray(start, start + firstLength), 0);
    side.set(this.side.subarray(start, start + firstLength), 0);
    if (secondLength) {
      mono.set(this.mono.subarray(0, secondLength), firstLength);
      side.set(this.side.subarray(0, secondLength), firstLength);
    }

    return {
      mono,
      side,
      startTime: this.latestTime - length / this.sampleRate,
      duration: length / this.sampleRate
    };
  }
}

let audioContext = null;
let workletReady = false;
let matchTimer = null;
let matchInFlight = false;
let shuttingDown = false;
let shutdownPromise = null;
let captureGeneration = 0;

const graphs = { tv: null, bilibili: null };
const rings = {
  tv: new AudioRingBuffer(),
  bilibili: new AudioRingBuffer()
};

const state = {
  captures: {
    tv: { connected: false },
    bilibili: { connected: false }
  },
  alignment: {
    phase: "idle",
    delayMs: 0,
    initialDelayMs: 0,
    confidence: 0,
    progress: 0,
    message: "先连接两个直播标签页",
    manualOffsetMs: 0
  },
  audio: {
    contextState: "closed",
    bufferAvailableSec: 0
  }
};

function publicState() {
  if (graphs.bilibili && audioContext) {
    state.audio.bufferAvailableSec = Math.min(MAX_DELAY_SECONDS,
      Math.max(0, audioContext.currentTime - graphs.bilibili.captureStartedAt));
  }
  return structuredClone(state);
}

function broadcastState() {
  chrome.runtime.sendMessage({
    target: "sidepanel",
    type: "STATE_UPDATE",
    state: publicState()
  }).catch(() => {});
}

async function ensureAudioContext(generation) {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext({ latencyHint: "interactive" });
    workletReady = false;
  }
  const context = audioContext;
  if (!workletReady) {
    await Promise.all([
      context.audioWorklet.addModule(chrome.runtime.getURL("pcm-tap.worklet.js")),
      context.audioWorklet.addModule(
        chrome.runtime.getURL("bilibili-delay.worklet.js")
      )
    ]);
    if (generation !== captureGeneration || context !== audioContext) throw new Error("连接已取消");
    workletReady = true;
  }
  if (context.state === "suspended") await context.resume();
  if (generation !== captureGeneration || context !== audioContext) throw new Error("连接已取消");
  state.audio.contextState = context.state;
}

function cancelAlignment() {
  if (matchTimer) clearInterval(matchTimer);
  matchTimer = null;
  setAnalysisEnabled(false);
  rings.tv.clear();
  rings.bilibili.clear();
  state.alignment.phase = "idle";
  state.alignment.confidence = 0;
  state.alignment.progress = 0;
  state.alignment.candidates = [];
}

function disconnectNode(node) {
  try {
    node?.disconnect();
  } catch {
    // Node may already be disconnected.
  }
}

function stopGraph(role) {
  const graph = graphs[role];
  if (!graph) return;
  graphs[role] = null;
  graph.analysisNode.port.onmessage = null;
  graph.analysisNode.port.close();
  for (const track of graph.stream.getTracks()) track.stop();
  disconnectNode(graph.source);
  disconnectNode(graph.analysisNode);
  disconnectNode(graph.silentGain);
  rings[role].clear();
  state.captures[role] = { connected: false };
}

function connectPcmPort(role, node) {
  node.port.onmessage = (event) => {
    const data = event.data;
    if (data?.type !== "PCM" || graphs[role]?.analysisNode !== node || !matchTimer ||
        data.startTime < state.alignment.analysisStartTime) return;
    rings[role].append(
      new Float32Array(data.mono),
      new Float32Array(data.side),
      data.startTime
    );
    updateBufferState();
  };
}

function setupTvTap(source) {
  const tap = new AudioWorkletNode(audioContext, "pcm-tap", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { role: "tv", targetRate: SAMPLE_RATE }
  });
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  source.connect(tap);
  tap.connect(silentGain);
  silentGain.connect(audioContext.destination);

  connectPcmPort("tv", tap);
  return { analysisNode: tap, silentGain };
}

function setupBilibiliDelay(source) {
  const processor = new AudioWorkletNode(audioContext, "bilibili-delay", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      targetRate: SAMPLE_RATE,
      maxDelaySec: MAX_DELAY_SECONDS
    }
  });
  source.connect(processor);
  processor.connect(audioContext.destination);
  connectPcmPort("bilibili", processor);
  return {
    analysisNode: processor,
    delayProcessor: processor,
    captureStartedAt: audioContext.currentTime
  };
}

async function captureStream({ role, streamId, tab }) {
  if (!["tv", "bilibili"].includes(role) || typeof streamId !== "string" ||
      !Number.isInteger(tab?.id)) throw new Error("无效的音频连接参数");
  if (shuttingDown) throw new Error("音频引擎正在停止");
  const generation = ++captureGeneration;
  await ensureAudioContext(generation);
  cancelAlignment();
  stopGraph(role);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
  if (generation !== captureGeneration || !audioContext || shuttingDown) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("连接已取消");
  }
  let source;
  let nodes;
  try {
    source = audioContext.createMediaStreamSource(stream);
    nodes = role === "bilibili" ? setupBilibiliDelay(source) : setupTvTap(source);
  } catch (error) {
    disconnectNode(source);
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
  const graph = {
    role,
    tab: { id: tab.id, title: tab.title },
    stream,
    source
  };

  Object.assign(graph, nodes);
  graph.analysisNode.port.postMessage({ type: "SET_ENABLED", enabled: false });
  graphs[role] = graph;
  state.captures[role] = {
    connected: true,
    tabId: tab.id,
    title: tab.title
  };
  if (role === "bilibili") {
    state.alignment.delayMs = 0;
    state.alignment.manualOffsetMs = 0;
  }
  state.alignment.message =
    state.captures.tv.connected && state.captures.bilibili.connected
      ? "两个直播已连接，可以开始对齐"
      : "再连接另一个直播标签页";
  broadcastState();

  for (const track of stream.getTracks()) {
    track.addEventListener("ended", async () => {
      if (shuttingDown || graphs[role]?.stream !== stream) return;
      const tabs = await stopAll(
        `${role === "tv" ? "TV" : "Bilibili"} 音频连接已断开，会话已停止`
      );
      await chrome.runtime.sendMessage({
        target: "service-worker",
        type: "SESSION_ENDED",
        tabs
      }).catch(() => {});
    });
  }
}

function setAnalysisEnabled(enabled) {
  for (const role of ["tv", "bilibili"]) {
    graphs[role]?.analysisNode?.port.postMessage({ type: "SET_ENABLED", enabled });
  }
}

function setBilibiliDelay(seconds, { crossfade = true } = {}) {
  const graph = graphs.bilibili;
  if (!graph) return false;
  const target = Math.max(0, Math.min(MAX_DELAY_SECONDS, seconds));
  graph.delayProcessor.port.postMessage({
    type: "SET_DELAY",
    seconds: target,
    crossfade
  });
  state.alignment.delayMs = Math.round(target * 1000);
  state.audio.bufferAvailableSec = Math.max(
    0,
    audioContext.currentTime - graph.captureStartedAt
  );
  broadcastState();
  return true;
}

function updateBufferState() {
  const graph = graphs.bilibili;
  if (graph) {
    state.audio.bufferAvailableSec = Math.max(
      0,
      audioContext.currentTime - graph.captureStartedAt
    );
  }

  if (!matchTimer || state.alignment.phase === "locked") return;
  const elapsed = (performance.now() - state.alignment.startedAtMs) / 1000;
  const expected = state.alignment.broadSearch
    ? 60
    : Math.max(18, state.alignment.initialDelayMs / 1000 + 12);
  state.alignment.progress = Math.min(0.96, elapsed / expected);
  state.alignment.phase = elapsed < expected * 0.72 ? "buffering" : "matching";
  state.alignment.message =
    state.alignment.phase === "buffering"
      ? "正在积累共同背景声；B站仍保持最新直播"
      : "正在寻找共同的现场声音";

  if (Math.floor(elapsed) !== state.alignment.lastBroadcastSecond) {
    state.alignment.lastBroadcastSecond = Math.floor(elapsed);
    broadcastState();
  }
}

async function attemptMatch() {
  if (matchInFlight || !matchTimer) return;
  matchInFlight = true;

  try {
    const elapsed = (performance.now() - state.alignment.startedAtMs) / 1000;
    if (elapsed >= state.alignment.timeoutSec) {
      clearInterval(matchTimer);
      matchTimer = null;
      state.alignment.phase = "manual";
      state.alignment.progress = 1;
      state.alignment.message = "未找到可靠的共同背景声，已保留当前延迟，请手动微调";
      state.alignment.confidence = 0;
      setAnalysisEnabled(false);
      broadcastState();
      return;
    }

    const minimumReady = state.alignment.broadSearch
      ? 18
      : Math.min(BUFFER_SECONDS, Math.max(10, state.alignment.initialDelayMs / 1000 + 8));
    if (Math.min(rings.tv.duration, rings.bilibili.duration) < minimumReady) return;

    const tv = rings.tv.snapshot();
    const bilibili = rings.bilibili.snapshot();
    const result = estimateDelay({
      tvMono: tv.mono,
      tvSide: tv.side,
      tvStartTime: tv.startTime,
      bilibiliMono: bilibili.mono,
      bilibiliSide: bilibili.side,
      bilibiliStartTime: bilibili.startTime,
      sampleRate: SAMPLE_RATE,
      initialDelaySec: state.alignment.broadSearch ? 0 : state.alignment.initialDelayMs / 1000,
      searchRadiusSec: state.alignment.searchRadiusSec,
      minimumOverlapSec: 8,
      maximumDelaySec: MAX_AUTO_DELAY_SECONDS
    });

    if (
      !result.ok ||
      result.confidence < 0.55 ||
      (result.windowCount || 0) < 2 ||
      (result.stableWindowCount || 0) < 2
    ) {
      state.alignment.candidates = [];
      state.alignment.phase = "matching";
      state.alignment.confidence = result.confidence || 0;
      state.alignment.message = "共同背景声还不够明确，正在等待更有辨识度的现场声";
      broadcastState();
      return;
    }

    const consensus = updateDelayConsensus(
      state.alignment.candidates,
      {
        delaySec: result.delaySec,
        confidence: result.confidence
      },
      { toleranceSec: 0.14, maxHistory: 4 }
    );
    state.alignment.candidates = consensus.history;
    state.alignment.confidence = result.confidence;
    state.alignment.candidateDelayMs = Math.round(result.delaySec * 1000);

    if (!consensus.confirmed) {
      state.alignment.phase = "matching";
      state.alignment.message =
        consensus.reason === "candidates-disagree"
          ? "两段背景声给出的结果不一致，继续采样，暂不锁定"
          : `已找到 ${(result.delaySec).toFixed(2)} 秒候选，正在用下一段背景声复核`;
      broadcastState();
      return;
    }

    clearInterval(matchTimer);
    matchTimer = null;
    const lockedDelay =
      consensus.delaySec + state.alignment.manualOffsetMs / 1000;
    setBilibiliDelay(lockedDelay);
    state.alignment.phase = "locked";
    state.alignment.progress = 1;
    state.alignment.confidence = result.confidence;
    state.alignment.matchedDelayMs = Math.round(consensus.delaySec * 1000);
    state.alignment.confirmationSpreadMs = Math.round(
      consensus.spreadSec * 1000
    );
    state.alignment.message = "连续两次分析结果一致；延迟已锁定，不再后台校准";
    setAnalysisEnabled(false);
    broadcastState();
  } catch (error) {
    state.alignment.phase = "matching";
    state.alignment.message = `匹配暂未完成：${error?.message || "分析失败"}`;
    broadcastState();
  } finally {
    matchInFlight = false;
  }
}

function startAlignment({
  initialDelaySec,
  searchRadiusSec,
  timeoutSec,
  broadSearch = false
}) {
  if (!graphs.tv || !graphs.bilibili) {
    return { ok: false, error: "请先连接两个直播标签页" };
  }

  cancelAlignment();
  setAnalysisEnabled(true);
  const initial = Math.max(0, Math.min(MAX_DELAY_SECONDS, initialDelaySec || 0));
  state.alignment = {
    phase: "buffering",
    delayMs: Math.round(initial * 1000),
    initialDelayMs: Math.round(initial * 1000),
    matchedDelayMs: null,
    confidence: 0,
    progress: 0,
    message: broadSearch
      ? "正在全范围搜索共同背景声；匹配成功前保留当前延迟"
      : "正在填充扩展自己的中文音频缓冲",
    manualOffsetMs: 0,
    startedAtMs: performance.now(),
    analysisStartTime: audioContext.currentTime,
    lastBroadcastSecond: -1,
    searchRadiusSec: searchRadiusSec || 15,
    timeoutSec: timeoutSec || 95,
    broadSearch,
    candidates: []
  };
  setBilibiliDelay(initial);
  matchTimer = setInterval(attemptMatch, 6000);
  attemptMatch();
  broadcastState();
  return { ok: true, initialDelaySec: initial };
}

function adjustDelay(deltaMs) {
  if (!graphs.bilibili || !Number.isFinite(Number(deltaMs))) {
    return { ok: false, error: "请先连接音频页，并使用有效的微调值" };
  }
  const delta = Number(deltaMs);
  const previousDelayMs = state.alignment.delayMs;
  const nextDelayMs = Math.max(
    0,
    Math.min(MAX_DELAY_SECONDS * 1000, previousDelayMs - delta)
  );
  const appliedDelayDeltaMs = nextDelayMs - previousDelayMs;
  const appliedTimelineMovementMs = -appliedDelayDeltaMs;
  state.alignment.manualOffsetMs += appliedDelayDeltaMs;
  setBilibiliDelay(nextDelayMs / 1000);
  const direction =
    appliedTimelineMovementMs > 0
      ? "提前"
      : appliedTimelineMovementMs < 0
        ? "延后"
        : "保持";
  state.alignment.message = `中文音频已${direction} ${Math.abs(appliedTimelineMovementMs)} ms`;
  broadcastState();
  return { ok: true, delayMs: nextDelayMs };
}

async function stopAll(message = "会话已停止") {
  if (shutdownPromise) return shutdownPromise;
  captureGeneration += 1;

  shutdownPromise = (async () => {
    shuttingDown = true;
    if (matchTimer) clearInterval(matchTimer);
    matchTimer = null;

    const tabs = {
      tv: graphs.tv?.tab?.id ?? null,
      bilibili: graphs.bilibili?.tab?.id ?? null
    };
    stopGraph("tv");
    stopGraph("bilibili");

    const context = audioContext;
    audioContext = null;
    workletReady = false;
    if (context && context.state !== "closed") {
      await context.close().catch(() => {});
    }

    matchInFlight = false;
    state.alignment = {
      phase: "idle",
      delayMs: 0,
      initialDelayMs: 0,
      confidence: 0,
      progress: 0,
      message,
      manualOffsetMs: 0
    };
    state.audio = {
      contextState: "closed",
      bufferAvailableSec: 0
    };
    broadcastState();
    return tabs;
  })();

  try {
    return await shutdownPromise;
  } finally {
    shuttingDown = false;
    shutdownPromise = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  if (sender?.id !== chrome.runtime.id || sender.tab) return false;
  const fromPopup = sender.url === chrome.runtime.getURL("sidepanel.html");
  // Service-worker messages have no sender URL; the popup may only read/trim.
  const fromWorker = !sender.url || sender.url === chrome.runtime.getURL("service-worker.js");
  if (!fromWorker && !(fromPopup && ["GET_STATE", "ADJUST_DELAY"].includes(message.type))) return false;

  if (message.type === "GET_STATE") {
    sendResponse(publicState());
    return true;
  }

  if (message.type === "CAPTURE_STREAM") {
    captureStream(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "音频捕获失败" }));
    return true;
  }

  if (message.type === "START_ALIGNMENT") {
    sendResponse(startAlignment(message));
    return true;
  }

  if (message.type === "ADJUST_DELAY") {
    sendResponse(adjustDelay(message.deltaMs));
    return true;
  }

  if (message.type === "STOP_ALL") {
    stopAll()
      .then((tabs) => sendResponse({ ok: true, tabs }))
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "停止音频引擎失败" });
      });
    return true;
  }

  if (message.type === "STOP_ROLE") {
    if (!["tv", "bilibili"].includes(message.role)) {
      sendResponse({ ok: false, error: "无效的来源" });
      return true;
    }
    captureGeneration += 1;
    cancelAlignment();
    const tabId = graphs[message.role]?.tab?.id ?? null;
    stopGraph(message.role);
    broadcastState();
    sendResponse({ ok: true, tabId });
    return true;
  }

  if (message.type === "TAB_CLOSED") {
    const closedRole = ["tv", "bilibili"].find(
      (role) => graphs[role]?.tab?.id === message.tabId
    );
    if (!closedRole) {
      sendResponse({ ok: true, stopped: false });
      return true;
    }

    stopAll("直播标签页已关闭，会话已停止")
      .then((tabs) => sendResponse({ ok: true, stopped: true, tabs }))
      .catch((error) => {
        sendResponse({ ok: false, stopped: false, error: error?.message || "清理失败" });
      });
    return true;
  }

  return false;
});

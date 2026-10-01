const elements = {
  tvCard: document.querySelector("#tv-card"),
  bilibiliCard: document.querySelector("#bilibili-card"),
  tvTitle: document.querySelector("#tv-title"),
  bilibiliTitle: document.querySelector("#bilibili-title"),
  tvStatus: document.querySelector("#tv-status"),
  bilibiliStatus: document.querySelector("#bilibili-status"),
  delayValue: document.querySelector("#delay-value"),
  phaseLabel: document.querySelector("#phase-label"),
  confidenceLabel: document.querySelector("#confidence-label"),
  progressBar: document.querySelector("#progress-bar"),
  stateMessage: document.querySelector("#state-message"),
  bufferNote: document.querySelector("#buffer-note"),
  pageContext: document.querySelector("#page-context"),
  currentPage: document.querySelector("#current-page"),
  connectButton: document.querySelector("#connect-button"),
  startButton: document.querySelector("#start-button"),
  stopButton: document.querySelector("#stop-button"),
  trimButtons: [...document.querySelectorAll("#trim-grid button")]
};

let currentState = null;
const hasExtensionRuntime = Boolean(globalThis.chrome?.runtime?.id);

const phaseNames = {
  idle: "IDLE",
  buffering: "BUFFERING",
  matching: "MATCHING",
  locked: "LOCKED",
  manual: "MANUAL"
};

function formatDelay(milliseconds = 0) {
  return (Math.max(0, milliseconds) / 1000).toFixed(3).padStart(6, "0");
}

function setSource(card, title, status, capture) {
  const connected = Boolean(capture?.connected);
  card.classList.toggle("connected", connected);
  title.textContent = connected ? capture.title || "已连接" : "未连接";
  status.textContent = connected ? "ON" : "OFF";
}

function render(state) {
  if (!state) return;
  currentState = state;
  const { captures, alignment, audio } = state;
  setSource(elements.tvCard, elements.tvTitle, elements.tvStatus, captures.tv);
  setSource(
    elements.bilibiliCard,
    elements.bilibiliTitle,
    elements.bilibiliStatus,
    captures.bilibili
  );

  elements.delayValue.textContent = formatDelay(alignment.delayMs);
  elements.phaseLabel.textContent = phaseNames[alignment.phase] || alignment.phase.toUpperCase();
  elements.confidenceLabel.textContent = alignment.confidence
    ? `匹配评分 ${Math.round(alignment.confidence * 100)}`
    : "匹配评分 —";
  elements.progressBar.style.width = `${Math.round((alignment.progress || 0) * 100)}%`;
  elements.stateMessage.textContent = alignment.message || "";

  const needed = alignment.delayMs / 1000 - (audio.bufferAvailableSec || 0);
  elements.bufferNote.textContent =
    needed > 0.4 ? `中文音频缓冲还需约 ${Math.ceil(needed)} 秒` : "";

  const bothConnected = captures.tv.connected && captures.bilibili.connected;
  const busy = alignment.phase === "buffering" || alignment.phase === "matching";
  elements.startButton.disabled = !bothConnected || busy;
  elements.startButton.querySelector("span").textContent =
    alignment.phase === "locked" || alignment.phase === "manual"
      ? "重新自动对齐"
      : "开始自动对齐";
  for (const button of elements.trimButtons) {
    button.disabled = !captures.bilibili.connected;
  }
}

async function messageOffscreen(message) {
  if (!hasExtensionRuntime) return null;
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function messageServiceWorker(message) {
  if (!hasExtensionRuntime) return null;
  return chrome.runtime.sendMessage({ ...message, target: "service-worker" });
}

async function refresh() {
  try {
    const state = await messageOffscreen({ type: "GET_STATE" });
    if (!state) throw new Error("音频引擎尚未启动");
    render(state);
  } catch {
    render({ captures: { tv: { connected: false }, bilibili: { connected: false } },
      alignment: { phase: "idle", delayMs: 0 }, audio: { bufferAvailableSec: 0 } });
    const serviceState = await messageServiceWorker({ type: "GET_SERVICE_STATE" }).catch(
      () => null
    );
    elements.stateMessage.textContent =
      serviceState?.lastUiError || "确认当前直播页，然后点击上方连接按钮";
  }
}

async function refreshActiveTab() {
  const info = await messageServiceWorker({ type: "GET_ACTIVE_TAB_INFO" }).catch(
    () => null
  );
  if (!info?.ok) {
    elements.currentPage.textContent = info?.error || "无法读取当前页面";
    elements.connectButton.disabled = true;
    return;
  }

  elements.currentPage.textContent = info.hostname || "当前页面";
  elements.pageContext.classList.toggle("supported", info.supported);
  elements.connectButton.disabled = !info.supported;
  elements.connectButton.querySelector("span").textContent =
    info.role === "tv"
      ? "连接当前页为画面源"
      : info.role === "bilibili"
        ? "连接当前页为中文音频"
        : "请切到支持的直播页";
}

elements.connectButton.addEventListener("click", async () => {
  elements.connectButton.disabled = true;
  elements.stateMessage.textContent = "正在连接当前标签页音频…";
  const result = await messageServiceWorker({ type: "CAPTURE_ACTIVE_TAB" }).catch(
    (error) => ({
      ok: false,
      error: error?.message || "连接请求失败"
    })
  );

  if (!result?.ok) {
    elements.stateMessage.textContent = result?.error || "连接失败，请重试";
    await refreshActiveTab();
    return;
  }

  elements.stateMessage.textContent =
    result.role === "tv" ? "画面信号已连接" : "Bilibili 中文音频已连接";
  await refresh();
  await refreshActiveTab();
});

elements.startButton.addEventListener("click", async () => {
  elements.startButton.disabled = true;
  elements.stateMessage.textContent = "正在启动共同背景声分析…";
  const result = await messageServiceWorker({ type: "START_ALIGNMENT" }).catch((error) => ({
    ok: false,
    error: error?.message || "启动失败"
  }));
  if (!result?.ok) {
    elements.stateMessage.textContent = result?.error || "启动失败，请重试";
    elements.startButton.disabled = false;
  }
});

for (const button of elements.trimButtons) {
  button.addEventListener("click", async () => {
    const deltaMs = Number(button.dataset.delta);
    button.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(0.94)" },
        { transform: "scale(1)" }
      ],
      { duration: 150, easing: "ease-out" }
    );
    const result = await messageOffscreen({ type: "ADJUST_DELAY", deltaMs }).catch(
      (error) => ({ ok: false, error: error.message }));
    if (!result?.ok) elements.stateMessage.textContent = result?.error || "音频引擎未连接";
  });
}

elements.stopButton.addEventListener("click", async () => {
  elements.stopButton.disabled = true;
  const result = await messageServiceWorker({ type: "STOP_SESSION" }).catch(
    (error) => ({ ok: false, error: error.message }));
  if (result?.ok) await refresh();
  else elements.stateMessage.textContent = result?.error || "停止失败，请在扩展管理页停用扩展";
  elements.stopButton.disabled = false;
});

if (hasExtensionRuntime) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id !== chrome.runtime.id || sender.tab) return false;
    if (message?.target === "sidepanel" && message.type === "STATE_UPDATE") {
      render(message.state);
    }
    if (message?.target === "sidepanel" && message.type === "SERVICE_ERROR") {
      elements.stateMessage.textContent = message.error || "连接失败";
    }
  });
  Promise.all([refresh(), refreshActiveTab()]);
} else {
  render({
    captures: {
      tv: { connected: true, title: "TV Team Player" },
      bilibili: { connected: true, title: "中文解说 · 音频页示例" }
    },
    alignment: {
      phase: "locked",
      delayMs: 38420,
      confidence: 0.86,
      progress: 1,
      message: "对齐完成；延迟已锁定，不再后台校准"
    },
    audio: { bufferAvailableSec: 62 }
  });
}

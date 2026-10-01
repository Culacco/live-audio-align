const OFFSCREEN_URL = "offscreen.html";
const MAX_AUTO_DELAY_SECONDS = 66;
const SUPPORTED = {
  "webplayer.tv.in": "tv",
  "www.yangshipin.cn": "tv",
  "live.bilibili.com": "bilibili"
};

let lastUiError = "";
let operationQueue = Promise.resolve();
const capturedTabs = { tv: null, bilibili: null };

function serialize(operation) {
  const result = operationQueue.then(operation);
  operationQueue = result.catch(() => {});
  return result;
}

async function engineMessage(message) {
  let timer;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage({ ...message, target: "offscreen" }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("音频引擎响应超时")), 12000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function roleForUrl(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" ? SUPPORTED[url.hostname] ?? null : null;
  } catch {
    return null;
  }
}

function friendlyCaptureError(error) {
  const raw = error?.message || String(error || "未知错误");
  if (/not.*invoked|activeTab|user gesture|permission/i.test(raw)) {
    return `浏览器没有授予当前标签页的音频捕获权限：${raw}`;
  }
  if (/offscreen|getContexts/i.test(raw)) {
    return `当前浏览器缺少所需的后台音频接口：${raw}`;
  }
  if (/cannot access|cannot be scripted|restricted/i.test(raw)) {
    return `当前页面不允许扩展连接：${raw}`;
  }
  return `连接失败：${raw}`;
}

function broadcastUiError(error) {
  chrome.runtime.sendMessage({
    target: "sidepanel",
    type: "SERVICE_ERROR",
    error
  }).catch(() => {});
}

async function offscreenExists() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await offscreenExists()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification:
      "Capture two user-selected live streams, compare their audio locally, and play delayed commentary."
  });
}

async function closeOffscreenDocument() {
  if (!(await offscreenExists())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    if (await offscreenExists()) throw error;
  }
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return engineMessage(message);
}

async function sendToExistingOffscreen(message) {
  if (!(await offscreenExists())) return null;
  return engineMessage(message);
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      ...message,
      target: "content"
    });
  } catch {
    return { ok: false, reason: "content-script-unavailable" };
  }
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-script.js"]
  });
}

async function restoreCapturedTabs(tabs = {}) {
  await Promise.all([
    Number.isInteger(tabs.tv)
      ? sendToContent(tabs.tv, { type: "SET_PICTURE_ONLY" }).catch(() => {})
      : null,
    Number.isInteger(tabs.bilibili)
      ? sendToContent(tabs.bilibili, { type: "RESTORE_NATIVE_AUDIO" }).catch(() => {})
      : null,
    Number.isInteger(tabs.tv)
      ? chrome.action.setBadgeText({ tabId: tabs.tv, text: "" }).catch(() => {})
      : null,
    Number.isInteger(tabs.bilibili)
      ? chrome.action.setBadgeText({ tabId: tabs.bilibili, text: "" }).catch(() => {})
      : null
  ]);
}

async function closeOffscreenIfIdle() {
  if (!(await offscreenExists())) return true;
  const state = await sendToExistingOffscreen({ type: "GET_STATE" }).catch(() => null);
  if (!state) {
    await restoreCapturedTabs(capturedTabs);
    await closeOffscreenDocument();
    capturedTabs.tv = capturedTabs.bilibili = null;
    return true;
  }
  if (state.captures?.tv?.connected || state.captures?.bilibili?.connected) return false;

  await sendToExistingOffscreen({ type: "STOP_ALL" }).catch(() => null);
  await closeOffscreenDocument();
  return true;
}

async function deactivateContentIfNotCaptured(tabId) {
  const state = await sendToExistingOffscreen({ type: "GET_STATE" }).catch(() => null);
  const captured = [state?.captures?.tv, state?.captures?.bilibili].some(
    (capture) => capture?.connected && capture.tabId === tabId
  );
  if (!captured) await sendToContent(tabId, { type: "DEACTIVATE" });
}

async function captureCurrentTab(tab) {
  const role = roleForUrl(tab.url);
  if (!role || !tab.id) {
    const hostname = (() => {
      try {
        return new URL(tab.url || "").hostname;
      } catch {
        return "当前页面";
      }
    })();
    throw new Error(
      `${hostname} 不是支持的直播页；请在 webplayer.tv.in、www.yangshipin.cn 或 live.bilibili.com 使用。`
    );
  }

  lastUiError = "";
  if (!chrome.tabCapture?.getMediaStreamId) {
    throw new Error("当前浏览器不支持 tabCapture.getMediaStreamId");
  }
  if (!chrome.offscreen?.createDocument || !chrome.runtime?.getContexts) {
    throw new Error("当前浏览器不支持 offscreen 音频处理");
  }

  const currentState = await sendToExistingOffscreen({ type: "GET_STATE" });
  const existing = currentState?.captures?.[role];
  if (existing?.connected && existing.tabId === tab.id) {
    await ensureContentScript(tab.id);
    await sendToContent(tab.id, { type: "SET_CAPTURE_AUDIBLE", role });
    return { ok: true, role, alreadyConnected: true };
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id
  });

  await ensureContentScript(tab.id);
  await ensureOffscreenDocument();

  if (existing?.connected) {
    await sendToOffscreen({ type: "STOP_ROLE", role });
    await sendToContent(existing.tabId, {
      type: role === "tv" ? "SET_PICTURE_ONLY" : "RESTORE_NATIVE_AUDIO"
    });
    await chrome.action.setBadgeText({ tabId: existing.tabId, text: "" }).catch(() => {});
    capturedTabs[role] = null;
  }

  const result = await sendToOffscreen({
    type: "CAPTURE_STREAM",
    role,
    streamId,
    tab: {
      id: tab.id,
      title: tab.title || (role === "tv" ? "TV Team" : "Bilibili 直播"),
      // Deliberately do not retain page URLs or their query parameters.
    }
  });

  if (!result?.ok) {
    throw new Error(result?.error || "标签页音频连接失败");
  }

  capturedTabs[role] = tab.id;

  await sendToContent(tab.id, { type: "SET_CAPTURE_AUDIBLE", role });
  await chrome.action.setBadgeText({
    tabId: tab.id,
    text: role === "tv" ? "TV" : "中"
  });
  await chrome.action.setBadgeBackgroundColor({
    tabId: tab.id,
    color: role === "tv" ? "#d7ff49" : "#ff9d45"
  });
  await chrome.action.setBadgeTextColor({ tabId: tab.id, color: "#10120f" });
  return { ok: true, role, alreadyConnected: false };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("找不到当前标签页");
  return tab;
}

async function getActiveTabInfo() {
  const tab = await getActiveTab();
  const role = roleForUrl(tab.url);
  let hostname = "";
  try {
    hostname = new URL(tab.url || "").hostname;
  } catch {
    hostname = tab.title || "当前页面";
  }
  return {
    ok: true,
    tabId: tab.id,
    hostname,
    role,
    supported: Boolean(role),
    label: role === "tv" ? "画面源" : role === "bilibili" ? "Bilibili 中文音频" : ""
  };
}

async function captureActiveTab() {
  const tab = await getActiveTab();
  try {
    const result = await captureCurrentTab(tab);
    lastUiError = "";
    return result;
  } catch (error) {
    lastUiError = friendlyCaptureError(error);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" }).catch(() => {});
    await chrome.action
      .setBadgeBackgroundColor({ tabId: tab.id, color: "#df5b3f" })
      .catch(() => {});
    broadcastUiError(lastUiError);
    await closeOffscreenIfIdle();
    await deactivateContentIfNotCaptured(tab.id);
    return { ok: false, error: lastUiError };
  }
}

async function startAlignment() {
  const state = await sendToExistingOffscreen({ type: "GET_STATE" });
  const tv = state?.captures?.tv;
  const bilibili = state?.captures?.bilibili;

  if (!tv?.connected || !bilibili?.connected) {
    return { ok: false, error: "请先分别连接 TV 和 Bilibili 标签页。" };
  }

  // Live-edge offsets are relative to each broadcaster, not a shared clock.
  // Preserve the user's current delay until acoustic matching succeeds.
  return sendToExistingOffscreen({
    type: "START_ALIGNMENT",
    initialDelaySec: state.alignment?.delayMs / 1000 || 0,
    searchRadiusSec: MAX_AUTO_DELAY_SECONDS,
    timeoutSec: 110,
    broadSearch: true
  });
}

async function stopSession() {
  const state = await sendToExistingOffscreen({ type: "GET_STATE" }).catch(() => null);
  const fallbackTabs = {
    tv: state?.captures?.tv?.tabId ?? capturedTabs.tv,
    bilibili: state?.captures?.bilibili?.tabId ?? capturedTabs.bilibili
  };
  let tabs = fallbackTabs;
  try {
    const result = state ? await sendToExistingOffscreen({ type: "STOP_ALL" }) : null;
    tabs = result?.tabs || fallbackTabs;
  } finally {
    try {
      await restoreCapturedTabs(tabs);
    } finally {
      await closeOffscreenDocument();
      capturedTabs.tv = capturedTabs.bilibili = null;
    }
  }
  return { ok: true };
}

async function finishEndedSession(tabs = {}) {
  const current = await sendToExistingOffscreen({ type: "GET_STATE" }).catch(() => null);
  const activeTabs = Object.values(current?.captures || {})
    .filter((capture) => capture.connected).map((capture) => capture.tabId);
  if (activeTabs.length) {
    // An ended-session notification may arrive after a new connection started.
    await restoreCapturedTabs(Object.fromEntries(Object.entries(tabs)
      .filter(([, tabId]) => !activeTabs.includes(tabId))));
    return;
  }
  await restoreCapturedTabs(tabs);
  await closeOffscreenDocument();
  capturedTabs.tv = capturedTabs.bilibili = null;
}

async function handleClosedTab(tabId) {
  const result = await sendToExistingOffscreen({ type: "TAB_CLOSED", tabId }).catch(
    () => null
  );
  if (!result?.stopped) return;
  await finishEndedSession(result.tabs);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "service-worker") return false;
  const expectedPage = message.type === "SESSION_ENDED" ? OFFSCREEN_URL : "sidepanel.html";
  if (sender?.id !== chrome.runtime.id || sender.tab ||
      sender.url !== chrome.runtime.getURL(expectedPage)) return false;

  if (message.type === "GET_SERVICE_STATE") {
    sendResponse({ ok: true, lastUiError });
    return true;
  }

  if (message.type === "GET_ACTIVE_TAB_INFO") {
    getActiveTabInfo().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || "无法读取当前标签页" });
    });
    return true;
  }

  if (message.type === "CAPTURE_ACTIVE_TAB") {
    serialize(captureActiveTab).then(sendResponse).catch((error) => {
      const captureError = friendlyCaptureError(error);
      lastUiError = captureError;
      broadcastUiError(captureError);
      sendResponse({ ok: false, error: captureError });
    });
    return true;
  }

  if (message.type === "START_ALIGNMENT") {
    serialize(startAlignment).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || "自动对齐启动失败" });
    });
    return true;
  }

  if (message.type === "STOP_SESSION") {
    serialize(stopSession).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error?.message || "停止失败" });
    });
    return true;
  }

  if (message.type === "SESSION_ENDED") {
    serialize(() => finishEndedSession(message.tabs))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "清理会话失败" });
      });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => handleClosedTab(tabId)).catch(() => {});
});

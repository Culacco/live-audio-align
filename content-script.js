(() => {
  const INSTALLATION_KEY = "__liveAudioAlignContentScript";
  if (globalThis[INSTALLATION_KEY]) return;
  globalThis[INSTALLATION_KEY] = true;

  let forceAudibleForCapture = false;
  let capturedRole = null;
  let observer = null;
  let pendingFrame = null;
  const originalAudio = new Map();

  function videos() {
    return [...document.querySelectorAll("video")];
  }

  function applyCaptureState() {
    if (!forceAudibleForCapture) return;
    for (const video of videos()) {
      if (!originalAudio.has(video)) originalAudio.set(video, { muted: video.muted, volume: video.volume });
      video.muted = false;
      if (video.volume === 0) video.volume = 1;
    }
  }

  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (pendingFrame !== null) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        applyCaptureState();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }

  function restoreAudio(pictureOnly = false) {
    for (const [video, original] of originalAudio) {
      video.volume = original.volume;
      video.muted = pictureOnly ? true : original.muted;
    }
    originalAudio.clear();
    if (pictureOnly) for (const video of videos()) video.muted = true;
  }

  function deactivate() {
    forceAudibleForCapture = false;
    capturedRole = null;
    stopObserver();
    restoreAudio();
    chrome.runtime.onMessage.removeListener(onMessage);
    delete globalThis[INSTALLATION_KEY];
  }

  function onMessage(message, sender, sendResponse) {
    if (message?.target !== "content") return false;
    if (sender?.id !== chrome.runtime.id || sender.tab ||
        (sender.url && sender.url !== chrome.runtime.getURL("service-worker.js"))) return false;

    if (message.type === "SET_CAPTURE_AUDIBLE") {
      capturedRole = message.role;
      forceAudibleForCapture = true;
      applyCaptureState();
      ensureObserver();
      sendResponse({ ok: true, videoCount: videos().length });
      return true;
    }

    if (message.type === "SET_PICTURE_ONLY") {
      forceAudibleForCapture = false;
      capturedRole = null;
      stopObserver();
      restoreAudio(true);
      sendResponse({ ok: true, videoCount: videos().length });
      queueMicrotask(deactivate);
      return true;
    }

    if (message.type === "RESTORE_NATIVE_AUDIO") {
      forceAudibleForCapture = false;
      capturedRole = null;
      stopObserver();
      restoreAudio();
      sendResponse({ ok: true, videoCount: videos().length });
      queueMicrotask(deactivate);
      return true;
    }

    if (message.type === "DEACTIVATE") {
      sendResponse({ ok: true });
      queueMicrotask(deactivate);
      return true;
    }

    if (message.type === "GET_PLAYER_CLOCK") {
      const video = videos()[0];
      if (!video) {
        sendResponse({ ok: false, reason: "video-not-found" });
        return true;
      }

      const seekableEnd = video.seekable.length
        ? video.seekable.end(video.seekable.length - 1)
        : null;

      sendResponse({
        ok: true,
        role: capturedRole,
        currentTime: video.currentTime,
        seekableEnd,
        behindLiveEdge:
          seekableEnd === null ? null : Math.max(0, seekableEnd - video.currentTime),
        paused: video.paused,
        playbackRate: video.playbackRate
      });
      return true;
    }

    return false;
  }

  chrome.runtime.onMessage.addListener(onMessage);
})();

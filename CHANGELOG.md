# Changelog

## 0.6.0

Initial public source release, with a pre-publication code/privacy review.

- Fix capture cancellation during pending media/worklet loading and stop acquired tracks on setup failure.
- Close worklet ports and unresponsive idle offscreen documents; surface stop/trim errors.
- Serialize service-worker mutations and avoid stale ended-session notifications closing newer sessions.
- Reset analysis buffers/candidates on re-alignment and source replacement; reject stale PCM.
- Replace cross-platform live-edge guesses with full-range acoustic search while preserving current delay until lock.
- Limit automatic search to 66 seconds to leave common-content overlap in the 75-second analysis buffer.
- Keep manual delay range at 0–74.5 seconds and existing minus-later/plus-earlier controls.
- Disable analysis by default and after lock/timeout; coalesce DOM updates.
- Drain delayed audio correctly during missing-input gaps.
- Restore original native mute/volume settings on audio-page cleanup.
- Restrict message senders, validate capture roles and omit full URLs from retained state.
- Add local-script/no-external-connection CSP, lifecycle tests, documentation, a CI template and explicit allowlist packaging. The template is not enabled because the initial publishing credentials lack workflow-write permission.

## Earlier local prototypes

- 0.5.0: Yangshipin picture-source adapter.
- 0.4.x: fine search and repeat-result agreement; manual control direction.
- 0.3.0: action popup instead of sidePanel for Chromium compatibility.
- 0.2.x: fixed-delay AudioWorklet buffer and idle resource cleanup.

Earlier versions were local prototypes and are not included in public Git history.

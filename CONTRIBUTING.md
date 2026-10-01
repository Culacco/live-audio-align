# Contributing

Bug reports, documentation improvements and narrowly scoped fixes are welcome.
Do not include personal accounts, tokens, private URLs or recordings in issues.

## Local development

Use Node.js 20+ and a compatible Chromium browser. There are no npm dependencies.

```bash
npm run check
npm test
npm run package
```

Load the directory containing `manifest.json` as an unpacked extension. Stop the
current session before reloading it, then refresh affected live pages.
The files named `sidepanel.*` implement a standard action popup, not the sidePanel API.

## Changes

- Keep the picture untouched: no player pause, seek or playback-rate writes.
- Preserve manual signs: minus means later audio, plus means earlier audio.
- No continuous calibration, network requests, analytics or saved recordings.
- Any new permission/site adapter needs an explanation in README and PRIVACY.
- Add behavior tests for capture races, cleanup and reconnect changes.
- Keep manifest/package versions synchronized; update CHANGELOG for releases.
- Do not claim synthetic tests demonstrate real-world accuracy or CPU usage.
- For playback changes, follow the live-browser checklist in PERFORMANCE.md.

Submit a pull request with the issue, scope, checks performed and any remaining
limitations. Do not commit `dist/`, browser profiles, audio samples or secrets.

Code contributions are licensed under the project's MIT license.

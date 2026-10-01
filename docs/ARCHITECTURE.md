# Architecture

The project is a dependency-free Manifest V3 extension with two fixed source roles.
`tv` is the picture/reference role; `bilibili` is the audible/delayed role.
The names are historical and do not imply general website support.

```text
Action popup ── user commands ──> service worker
                                  │
                                  ├── on-demand page hook (mute/volume only)
                                  └── offscreen audio engine
                                        ├── picture tab capture → PCM tap → zero gain
                                        └── audio tab capture → stereo delay → speakers
                                              │
                                analysis enabled only during calibration
                                              ↓
                                two 8 kHz mono/side rings → matcher
```

## Components

| File | Responsibility |
| --- | --- |
| `service-worker.js` | Host roles, user-triggered capture IDs, document lifecycle, serialized mutations and page cleanup |
| `content-script.js` | On-demand HTML5 video mute/volume adjustment and restoration; detachable listener/observer |
| `offscreen.js` | AudioContext/graphs, capture cancellation generation, analysis rings and one-shot matching |
| `bilibili-delay.worklet.js` | Stereo Float32 circular playback buffer and optional analysis downsampling |
| `pcm-tap.worklet.js` | Silent reference output and optional analysis downsampling |
| `matcher.js` | Spectral-flux lag search and repeat-candidate agreement |
| `sidepanel.*` | Standard action popup; the name does not indicate use of sidePanel API |

## Lifecycle

No startup/install listener creates an audio engine. Connecting obtains an audio-only
capture ID and injects the page hook before starting an offscreen AudioContext.
Both roles must be connected before one-shot calibration starts.

Calibration uses fresh analysis buffers and tries every six seconds. A candidate
must pass heuristic quality/window checks and agree with the preceding accepted
candidate within 140 ms. Analyses may overlap; agreement is not independent proof.
Lock or timeout disables analysis. Capture and fixed-delay playback continue until Stop.

Capture generation guards prevent pending async setup from resurrecting a stopped
context. Track end or either selected tab closing ends the whole session. Stop
closes tracks, worklet ports, nodes, context and offscreen document and removes page
listeners. Native audio settings are restored on Bilibili; the picture page remains muted.

Browser events may briefly wake the worker when idle. There is no native daemon,
server or continuous polling after lock. Popup closure deliberately does not stop playback.

## Accuracy and buffer limits

Both capture graphs use one AudioContext timeline, so different start times are
accounted for. Platform live-edge positions are not shared clocks and are not used
to infer alignment. Only nonnegative audio delay is searched; video is untouched.

Analysis rings hold 75 seconds at 8 kHz. Automatic search is limited to 66 seconds
to retain at least eight seconds of common signal with processing margins. Fixed
playback can delay up to 74.5 seconds at the actual AudioContext sample rate.

This implementation cannot synchronize unrelated mixes, recover unavailable future
audio, bypass DRM or guarantee a site's native sound-picture relationship.

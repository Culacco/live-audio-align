# Live Audio Align

一个本地运行的浏览器扩展：**保留一个直播页面的画面，把另一个直播页面的音频延迟到与画面对齐。**

适合希望观看某个平台的画面、同时听另一平台中文解说的场景。画面不暂停、不回退；音频页面也继续正常直播，延迟由扩展自己的环形缓冲实现，因此不依赖播放器的暂停功能。

> 当前版本支持 TV Team / 央视频作为画面源、Bilibili 直播作为音频源，不是任意网站通用的对时器。自动匹配是实验性功能，结果需要耳听确认。

## 功能

- 只延迟音频，不改变任一播放器的进度、速率或视频路径。
- 基于共同现场背景声进行一次自动对时，锁定后停止分析；不持续后台校准。
- 支持手动 `±50 / ±100 / ±500 ms` 微调。
- 固定音频延迟范围 `0–74.5 秒`；自动搜索范围 `0–66 秒`。
- 音频在浏览器本机处理，无服务器、遥测、云端识别或运行时第三方依赖。
- 点击停止后释放媒体捕获、音频节点、匹配定时器及隐藏音频页。

## 支持范围

| 来源 | 当前支持的网站 | 用途 |
| --- | --- | --- |
| A | `https://webplayer.tv.in/` | 画面 + 不可听的参考音频 |
| A | `https://www.yangshipin.cn/` | 画面 + 不可听的参考音频 |
| B | `https://live.bilibili.com/` | 需要延迟的音频 |

使用 Chrome 116+，或支持相同 `tabCapture` / `offscreen` API 的 Chromium 浏览器。控制台使用标准扩展弹窗；Arc 的具体兼容性取决于其内核和扩展 API 实现。Firefox / Safari 当前不支持。不需要安装 ChatGPT 或其他辅助插件。

## 安装

1. 从 [Releases](https://github.com/Culacco/live-audio-align/releases) 下载扩展 ZIP 并解压；也可在仓库页面选择 **Code → Download ZIP**，或 `git clone` 本仓库。
2. Chrome 打开 `chrome://extensions/`；Arc 使用扩展管理页（如 `arc://extensions/`）。
3. 打开“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择含有 `manifest.json` 的目录，将扩展固定到工具栏。

目前没有发布到 Chrome Web Store。更新本地文件后，请先停止会话，再在扩展管理页点击“重新加载”。遇到失效的旧连接可刷新两个直播页面后重新连接。

## 使用

1. 打开画面源直播，确认画面和原始音频都能正常播放。点击扩展图标，选择“连接当前页为画面源”。扩展会捕获参考音频，但不会把它输出到扬声器。
2. 打开 Bilibili 直播间，确认直播正常播放。点击扩展图标，选择“连接当前页为中文音频”。此时应只听到来自扩展的 Bilibili 音频。
3. 两路显示 `ON` 后，点击“开始自动对齐”。匹配成功前保留当前延迟；首次连接时当前延迟为零。
4. 等待积累背景声及匹配。通常需要几十秒，最长约 110 秒；延迟越大，所需共同片段越难积累。
5. 锁定后用哨声、击球、碰撞、现场音乐等确认，不要只以解说员开口时间判断。
6. 需要时手动微调；不再使用时点击“停止并释放全部资源”。

| 听到的情况 | 操作 | 实际变化 |
| --- | --- | --- |
| 声音比画面早 | 点 `−` | 增大延迟，让声音更晚 |
| 声音比画面晚 | 点 `+` | 减小延迟，让声音更早 |

显示的数字是**实际缓冲延迟**，所以点 `−` 时数字会增加。延迟不能小于零：如果音频源本身已经比画面晚，保持画面不延迟的前提下无法把尚未到达的声音提前。

刚连接时就设置较长延迟，可能出现等待缓冲的静音。两路节目内容或平台缓冲发生变化后，需要手动调整或重新自动对时；重启或刷新后不会保存之前的延迟。

## 自动对时的原理与限制

两路参考音频降采样至 8 kHz，比较多频段频谱变化。有可用立体声侧声道时，利用它减弱居中的解说人声。先以 100 ms 网格粗搜索，再在候选附近用 10 ms 网格细搜，同时检查多个时间窗口。连续两次结果相近才锁定；这些分析可能共享部分采样，不代表完全独立验证。

界面的“匹配评分”是启发式分数，**不是正确率百分比**；10 ms 也只是细搜索网格，不是实际直播精度保证。无法可靠匹配时保留当前延迟并提示手动调整。

- 共同背景声被解说盖住、不同混音、广告、静音或重复音乐都会影响匹配，仍可能出现误匹配。
- 两个平台的直播边缘不是同一个时钟，因此不通过其缓冲位置推断跨平台延迟。
- 75 秒分析缓冲必须留出至少 8 秒共同内容，自动搜索保守限定为 66 秒；更大的偏移可手动设置，最大 74.5 秒。
- 不消除解说员的反应时间，也不能保证音频源自身的声画同步。
- 捕获的是**整个标签页的音频**，不是仅某个播放器。请避免同一页有其他发声内容。
- 网页脚本只处理顶层文档的 HTML5 `video` 元素。跨域 iframe、Shadow DOM、受保护媒体或特殊播放器可能无法正确解除静音或捕获；没有绕过 DRM 的功能。
- 网站登录、会员、地区和版权限制仍由原平台决定。请只在有权访问内容时使用；本项目与支持的网站无关联。

## 隐私与空闲资源

扩展不上传、不落盘录音，不读取 Cookie / 密码 / 浏览历史，不保存设置。仅在会话内存中暂存选中标签的 ID、标题及音频；不保留页面完整 URL 或查询参数。详情见 [PRIVACY.md](PRIVACY.md)。

未连接时没有隐藏音频页或常驻音频处理。停止、关闭任一已连接标签页，或捕获中断，会触发会话清理，并移除页面观察器和监听。音频页失去响应时，停止操作仍尝试强制关闭它；如果浏览器报告停止失败，请在扩展管理页停用扩展。

**关闭弹窗不等于停止。** 已连接时音频会继续播放；即使锁定后不再分析，固定延迟仍需要音频处理。Chrome 可能因扩展事件短暂唤醒 Manifest V3 service worker，因此不承诺系统进程列表绝对没有浏览器进程。扩展不安装原生程序、不启动本地服务器。

停止时画面页保持静音，Bilibili 的 `muted` / `volume` 恢复到本次连接之前的状态。

## 常见问题

**只有红色感叹号 / 连接失败？** 打开弹窗读取错误，确认是在支持的 HTTPS 页面、直播正在播放、浏览器支持所需 API。更新扩展后刷新直播页再试。报告问题时请隐藏私人直播地址、账号和查询参数。

**自动对时不准？** 等待有辨识度的共同现场声后重新对时，或直接手动调节。两路没有相同音轨时无法从背景声可靠推算偏移。

**为什么停止后 Bilibili 仍静音？** 会恢复连接前的静音状态；如果连接前你已静音，停止后仍会静音，请在原播放器取消静音。

## 开发

Node.js 20+，无 npm 依赖；不需要 `npm install`。

```bash
npm run check       # 语法、Manifest、版本和运行时权限/资源检查
npm test            # 合成音频及模拟浏览器生命周期回归
npm run package     # 生成 dist/live-audio-align-v0.6.0.zip，需要系统 zip
```

附带 [GitHub Actions CI 模板](docs/ci-template.yml)，配置 Node.js 22 / 24 的检查、测试和打包。初次发布的 GitHub 凭据没有 `workflow` 写权限，因此模板未启用；使用具备工作流写权限的凭据将它复制到 `.github/workflows/ci.yml` 即可启用。参见 [架构](docs/ARCHITECTURE.md)、[性能与验证](PERFORMANCE.md)、[贡献指南](CONTRIBUTING.md)、[安全说明](SECURITY.md) 和 [更新记录](CHANGELOG.md)。自动化测试不替代实际直播的端到端验证。

## English summary

Live Audio Align is a local Manifest V3 extension that keeps one live page's picture unchanged while delaying another live page's audio. Current adapters support TV Team / Yangshipin as the picture/reference source and Bilibili Live as the audio source. Optional one-shot acoustic matching uses shared background sound; manual trimming remains available. No telemetry, audio upload, saved recordings, native daemon or continuous calibration. Closing the popup does not stop playback: use the Stop button to release capture resources. Automatic matching is experimental and cannot advance audio beyond its live edge.

## License

[MIT](LICENSE). No affiliation with TV Team, Yangshipin or Bilibili.

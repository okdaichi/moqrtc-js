# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] - 2026-10-17

Minor release of `@okdaichi/av-nodes` (`packages/av_nodes`). `AudioDecodeNode` gets an adaptive jitter buffer with fades instead of hard cuts and a `getStats()` snapshot; worklet modules and processors no longer leak; `decodeFrom()` survives a suspended audio context. `latency` / `maxLatency` are now validated, so `latency: 0` throws instead of meaning 100 ms.

### Added

- `AudioDecodeNode`: an adaptive jitter buffer. The playback worklet's delay used to be fixed at `latency` (100 ms), so on a link whose delivery jitter exceeded it (a phone on 2.4 GHz Wi-Fi delivering 20 ms Opus frames in bursts up to 200 ms apart) a steady share of blocks arrived after their playout time and were dropped, a crackle every fraction of a second. The delay now follows the observed arrival jitter, after WebRTC's NetEQ: each block's delay over the fastest recent arrival feeds a decaying histogram whose 97th percentile is the target, and a peak detector raises the target at once when a block comes later than any recent one. A late block raises the delay and plays instead of being dropped, unless a later block is already buffered (it then arrived out of order and is dropped). The delay falls back slowly (the peak and the histogram forget over 10 and 20 s) in 10 ms steps: one per second, cut from a silence gap or a quiet stretch, or one per two seconds through continuous sound. A block more than one cushion ahead of the cushion, or one that would land beyond the buffer, moves playback to the live edge. `latency` stays the starting and minimum delay, so a good link keeps it; the new `maxLatency` option (default 400 ms) caps it, and setting it to `latency` fixes the delay. A drift between the sender's and the receiver's audio clocks moves the delay floor and is absorbed the same way ([#84]).
- `AudioDecodeNode.getStats()`: an `AudioPlaybackStats` snapshot of the playout buffer (target and applied delay, buffer level, late, dropped, underrun, expand and accelerate counts), asked of the worklet over its port. It rejects with `AudioDecodeNodeDisposedError` once the node is disposed, with `AudioPlaybackStatsTimeoutError` when the worklet does not reply within `timeoutMs` (default 1000), and with `AudioPlaybackUnavailableError` when the worklet failed to load, its processor failed, it could not be posted to, or the audio context closed; the error's `reason` (an `AudioPlaybackUnavailableReason`) tells which. A `timeoutMs` that is not a positive finite number throws `AudioDecodeNodeOptionError` ([#84]).
- `AudioPlaybackStats.droppedWhileSuspended`: the encoded chunks `decodeFrom()` dropped because the audio context was not running ([#91]).

### Changed

- `AudioDecodeNode`: `latency` and `maxLatency` are validated: each must be a positive finite number and `maxLatency` not below `latency`, or the constructor throws `AudioDecodeNodeOptionError`. A `latency` of `0` used to fall back to 100 ms silently; it now throws ([#84]).
- `AudioDecodeNode`: the messages it posts to its playback worklet carry a `type` tag (`append` or `stats`), and both sides ignore malformed messages ([#84]).
- The worklet processors are registered under versioned names (`audio-offloader-v1`, `audio-hijacker-v1`), so copies of av-nodes of different versions in one audio context each use their own processors instead of the first one's ([#91]).
- `AudioDecodeNode`: playback no longer cuts hard between audio and silence. An underrun fades out over 3 ms ahead of the end of the buffered audio and fades back in; a gap in the stream, a raised delay, a lowered delay and a jump to the live edge are faded or crossfaded the same way ([#84]).

### Fixed

- `AudioDecodeNode` / `AudioEncodeNode`: each worklet module is added to an audio context once, however many nodes use it there. Every node used to add it again from a new Blob URL that was never revoked, so an app creating a node per subscription or per mic-on leaked a Blob per node, compiled the module again on the audio rendering thread, and logged a `NotSupportedError` from the repeated `registerProcessor`. The load is shared per context (a failed one is retried by the next node), each worklet has one Blob URL for the process, and both worklets ignore a repeated registration of their processor by a copy of the same version ([#91]).
- `AudioDecodeNode` / `AudioEncodeNode`: `dispose()` tells the worklet's processor to stop. Processors kept running after their node was disposed and piled up for the context's lifetime; a stop message (`{ type: "stop" }`) now makes the processor close its port and return `false` from `process()`, and the node closes its port and disconnects. `AudioEncodeNode` stops it before flushing its encoder. A decode node disposed while its worklet module loads creates no worklet ([#91]).
- `AudioDecodeNode.decodeFrom()`: reading no longer ends when the audio context is not running. It used to return at once when called before `resume()`, and to end for good on a suspension or an iOS interruption, leaving the stream uncancelled. Chunks read while the context is not running are now dropped, as they would play late, and decoding resumes once it runs. Reading ends on `dispose()`, at the end of the stream, when the context closes, or on an error, and ending any way but the end of the stream cancels the stream. A pending read is cancelled as soon as the context closes, rather than when the next chunk arrives, and a later `decodeFrom()` is still cancelled by `dispose()` after an earlier one ends ([#91]).
- `AudioDecodeNode`: a worklet module that fails to load no longer leaves an unhandled promise rejection; `getStats()` still rejects with `AudioPlaybackUnavailableError` carrying the load error as its `cause` ([#91]).
- `AudioDecodeNode`: starting over from a stream that fell behind fades out the audio that was playing and fades the new block in, as a jump to the live edge does, instead of cutting ([#91]).

## [0.11.2] - 2026-10-14

Patch release of `@okdaichi/av-nodes` (`packages/av_nodes`). `AudioDecodeNode` starts playback over from a stream that fell behind, instead of dropping it for good.

### Fixed

- `AudioDecodeNode`: playback starts over from a stream that fell behind for good. Its playback worklet places each block by its timestamp and drops a block whose time has already been played; it caught up with a stream running ahead (the resync to the live edge) but not with one running behind. A sender whose audio clock stopped for a while, such as a suspended `AudioContext` on a locked phone, resumes with timestamps from where it stopped, so every later block was dropped and the listener heard nothing more. After three blocks in a row arrive wholly in the playback past, however far, the worklet now takes the stream as it arrives as its new origin. One late block is still only dropped ([#58]).
- `audio_offload_worklet_test.ts` runs the worklet module itself instead of a hand-copied processor ([#58]).

## [0.11.1] - 2026-10-14

Patch release of `@okdaichi/av-nodes` (`packages/av_nodes`). `AudioEncodeNode` sends the audio it holds when the capture input stops, instead of late after the input returns.

### Fixed

- `AudioEncodeNode`: the audio the encoder holds when the capture input stops (up to one Opus frame, 20 ms) is sent at once, at its time. It used to stay in the encoder until the input came back, and then went out stamped at the time it was captured, so a player that places audio by its timestamp took it as late and dropped it: the last words before a mute were lost. The capture worklet now reports when its input stops, and the node flushes the encoder then ([#56]).
- `AudioEncodeNode`: the encode loop no longer waits for a flush; frames encoded after it are queued behind it in order. Frames captured during a slow flush no longer pile up unread ([#56]).
- `AudioEncodeNode.process()`: a gap in its input is kept in the encoded timestamps, as on the worklet path ([#56]).

## [0.11.0] - 2026-10-14

Minor release of `@okdaichi/av-nodes` (`packages/av_nodes`). `AudioEncodeNode` stamps audio by the audio context's clock, so a muted (disconnected) source shows as a gap in the encoded timestamps instead of collapsing it. A minor bump, not a patch: the timestamps no longer start at 0, and a consumer that offsets them for muted time must drop that workaround.

### Fixed

- `AudioEncodeNode`: a stretch with no captured audio shows as a gap in the encoded timestamps. The capture worklet stamped frames by counting the frames it captured, and it captures nothing while its source is disconnected (a muted microphone), so the frames after the gap carried the time the gap began; a player that places audio by its timestamp took them as late and dropped them. The worklet now stamps frames by the audio context's clock (`currentFrame`). WebCodecs stamps encoded chunks by counting samples from the first frame it was given, so the node also flushes the encoder before the first frame after a gap longer than 100 ms, and the encoder starts again from that frame's timestamp ([#54]).

### Changed

- `AudioEncodeNode`: encoded timestamps are on the audio context's clock, so they start at the context's time when capture begins, not at 0, and keep any time the node captured nothing. A consumer that adds the time its source spent disconnected to each timestamp, to work around the old counting, must stop, or that time is counted twice ([#54]).

## [0.10.6] - 2026-10-14

Patch release of `@okdaichi/av-nodes` (`packages/av_nodes`). `AudioEncodeNode` captures the channel count its encoder is configured for; before, a mono encoder on a stereo output device encoded nothing.

### Fixed

- `AudioEncodeNode`: capture the channel count given to `configure()`. The node captured as many channels as the output device has (`context.destination.channelCount`), whatever the encoder was configured for. With a mono config on a stereo device, WebCodecs refused the first frame (`EncodingError: Input audio buffer is incompatible with codec parameters`) and closed the encoder, so nothing was ever encoded. `configure()` now sets the channel count of the node and of its capture worklet (`channelCountMode: "explicit"`, so Web Audio mixes the input up or down) and tells the worklet's processor, which keeps its frame counter, so timestamps continue across a change. Until `configure()` is called the node still captures the output device's channel count ([#52]).
- `AudioEncodeNode`: a frame whose channel count is not the configured one is dropped before it reaches the encoder, on the worklet path and in `process()` ([#52]).
- `AudioEncodeNode`: frames that arrive before `configure()` are dropped and the encode loop keeps reading. It used to stop at the first one, so a node that was fed audio before it was configured never encoded anything afterwards ([#52]).
- `AudioEncodeNode`: a node disposed while its worklet module is still loading creates no capture worklet. It used to attach one after disposal, which kept posting frames ([#52]).
- `AudioEncodeNode`: a frame posted by the worklet after the node's stream closed is closed instead of being left open, and is no longer reported as a failure to create `AudioData` ([#52]).

## [0.10.5] - 2026-09-05

Patch release of `@okdaichi/av-nodes` (`packages/av_nodes`). Robustness fixes for early teardown/abort, hardware encoder startup backpressure, and hot-path throughput optimizations.

### Fixed

- `VideoDecodeNode` / `AudioDecodeNode` / `VideoEncodeNode` / `AudioEncodeNode`: guard `flush()` on `state !== "configured"` to prevent `InvalidStateError` when tearing down nodes prior to codec configuration ([#50]).
- `AudioDecodeNode` / `AudioEncodeNode`: silently swallow `AbortError` on `audioWorklet.addModule()` during early node disposal or `AudioContext` shutdown ([#50]).

### Changed

- `AudioEncodeNode`: replace recursive `queueMicrotask` in `#next` with a `while` loop, cutting pipeline latency in half and doubling throughput (~1.07M → 2.22M fps in benchmarks) ([#51]).
- `VideoEncodeNode` / `AudioEncodeNode`: iterate destinations directly in WebCodecs `output()` callback, eliminating per-chunk `Array.from()` and `Promise.allSettled()` allocations ([#51]).
- `AudioDecodeNode`: pre-allocate channel extraction arrays and eliminate per-frame `channels.map()` buffer transfers in `#process` ([#51]).
- `VideoEncodeNode`: support `maxQueueSize` option defaulting to 4 (was hardcoded 2) to accommodate hardware encoder startup buffering ([#50]).

## [0.10.4] - 2026-07-06

Patch release of `@okdaichi/av-nodes` (`packages/av_nodes`). Encode-loop robustness fix.

### Fixed

- `AudioEncodeNode`: treat a thrown `encode()` as terminal — close the frame, release the reader, and stop the loop — instead of catching it, logging, and rescheduling via `queueMicrotask`. On an unconfigured codec (caller never called `configure()`, or `configure()` failed while audio is still routed in) `encode()` throws `InvalidStateError` once per worklet frame, so the loop spun forever spamming `[AudioEncodeNode] encode error: ... Cannot call 'encode' on an unconfigured codec` (seen in the qumo playground when switching ingest scenarios). A later `configure()` must now re-`encodeTo()` to restart the loop ([#44]). Library-level defense so any caller is protected; the playground-side trigger is fixed separately in qumo-dev/qumo#245.

### Changed

- Bump `@okdaichi/golikejs` `0.9.0 → 0.10.0` (root + `packages/av_nodes`) and `@std/assert` `^1.0.16 → ^1.0.19` (`packages/av_nodes`) to latest. Lockfiles refreshed; all suites pass (root 24, av-nodes 59, media-log 23).

## [0.1.0] - 2026-07-06

First release of `@okdaichi/media-log` (`packages/media_log`) — a media-domain logging library for real-time media apps (Media over QUIC, audio/video streaming, WebCodecs). Stack-agnostic: no dependency on WebCodecs/WebTransport/MSE/WebRTC/`@qumo/moq`.

### Added

- **Generic engine:** tagged `createLogger`, levels `trace..error` with runtime `setLevel(level, tag?)` (global or per-tag), structured fields kept as-is so suppressed logs pay nothing to build, consecutive message-only dedup into a `×N` entry, `throttle()` rate-limiting (1s default window), `counter()` aggregation, a 1024-entry preallocated ring buffer + `exportLogs()` (text/ndjson, `Error` fields serialized), pluggable sinks (built-in console), and `onLogs()`/`onLevelChange()` hooks. Counter/meter handles are cached per name so repeated lookups don't allocate.
- **Media layer:** curated `MediaTags` (audio/video/encoder/decoder/renderer/capture/transport/network/moq/quic/webtransport/jitter/catalog); typed meters on a shared 1s pulse — `meter.fps()`/`bitrate()` (auto bps/kbps/Mbps/Gbps)/`rate()`/`gauge()` (avg/min/max) — where `mark()`/`sample()` are O(1) and zero-allocation (safe in per-frame loops); media-timestamp (PTS) stamping via `createMediaLogger(tag, { clock })` and `frame()`; `formatMediaTime`/`formatBitrate` helpers.
- **Hot-path contract:** every log method is a single numeric level compare before any argument's contents are touched; production quietness is `setLevel("warn")`. Zero runtime deps; no `import.meta.env` coupling; the single flush timer unrefs in Deno so it can't hang tests/SSR.

## [0.10.3] - 2026-07-06

Patch release of `@okdaichi/av-nodes` (`packages/av_nodes`). Audio robustness fix for live/bursty ingest.

### Fixed

- `AudioDecodeNode`: resync the `AudioOffloadProcessor` to the live edge on buffer overflow instead of dropping the overflowing block. Under a startup/transient backlog burst the ring pinned full and every later block was dropped (a per-frame click); the worklet now advances the read pointer so the block plays at the cushion, abandoning the stale backlog. Cost is a brief skip per resync — strictly better than dropping all new audio ([#42]).
- `VideoDecodeNode`: drop the per-chunk `Decoder overloaded` warning. The decode queue sitting at the cap (`MAX+1`) is normal backpressure steady-state (it oscillates there every cycle as long as the decoder keeps up), so the warning was pure noise; the 5 s drain-timeout warning for a genuine stall stays ([#42]).

## [0.10.2] - 2026-07-06

Patch release of `@okdaichi/av-nodes` (`packages/av_nodes`) with resource-lifecycle and correctness fixes accumulated since [0.10.1]. No API additions or breaking changes.

### Fixed

- `AudioDecodeNode`: schedule decoded blocks by presentation timestamp in `AudioOffloadProcessor` so bursty/jittery delivery no longer clicks/pops ([#19]).
- `AudioDecodeNode` / `VideoDecodeNode` / `AudioEncodeNode`: close decoded frames even when processing throws, and cancel in-flight stream reads on `dispose()` so tearing down a node mid-stream no longer leaks the reader lock, buffers upstream into a dead pipe, or hangs the internal encode loop ([#23]).
- `VideoOverlayNode` / `VideoDestinationNode` / `VideoSourceNode`: close `VideoFrame`s in `try/finally` so a throwing overlay/drawImage/constructor can't leak a GPU-backed frame; and fix the `MediaStreamVideoSourceNode` polyfill delivering ~half the configured frame rate (both the source loop and the stream `pull()` paced) ([#22]).
- `VideoAnalyserNode`: report `frameIndex` as the cumulative input frame count (it understated by the `analysisInterval` factor); validate `analysisSize` / `historySize` / `analysisInterval` (capping `analysisSize` at 4096/side to bound allocation) ([#21]).
- `videoEncoderConfig`: validate `width` / `height` / `frameRate` and treat an explicit `bitrate` of `0`/negative as "not set", falling back to the calculated bitrate ([#20]).
- `AudioEncodeNode` / `VideoDecodeNode`: break busy-spin backpressure loops and cache the resolved worklet for direct per-frame posting ([#12], [#14], [#15]).
- `@okdaichi/av-nodes` publish graph: keep benches/tests out of the published package ([#17]); force-install test doubles so the `VideoAnalyserNode` suite runs headlessly ([#16]).

## [Unreleased]

Merged work on `main` not yet cut as a tagged release. The Deno runtime migration and AV/media + Room/elements refactor landed in [#3]; the fixes and features from that work are recorded (with PR references) under the versioned `@okdaichi/av-nodes` and `@okdaichi/media-log` entries above. Full pre-release history is preserved in git.

### Changed

- CI now runs `deno lint` for the published packages (`@okdaichi/av-nodes`, `@okdaichi/media-log`) alongside `check`/`test`. The one blocker — `FakeAudioDataCtor` in `packages/av_nodes/audio/encode_bench.ts` calling `super()` in both branches of an if/else — was refactored to a single unconditional `super()` via an arg-resolving helper (no behavior change) ([#48]).
- The worklet processors are registered as `audio-offloader-v2` and `audio-hijacker-v2`: the capture worklet's messages changed (a `format` message replaces `{ targetChannels }`, and it posts `frame` and `inputEnded` messages), and the playback worklet starts differently ([#68]).
- `AudioEncodeNode`: the frames it hands its encoder last one codec frame, `opus.frameDuration` of the encoder config (20 ms if not given), rather than one 128-frame render quantum ([#68]).

### Fixed

- `AudioEncodeNode`: captured audio no longer clicks. The capture worklet posted one 128-frame `AudioData` per render quantum, 375 a second, and the node dropped a frame whenever more than two waited in the encoder queue, which the main thread's jitter caused about twice every ten seconds; the timestamps were then closed up over the 2.67 ms gap, so the receiver played the audio on either side of it back to back. The worklet now gathers a whole codec frame (960 frames at 48 kHz for 20 ms) in a buffer it hands over with the message, one allocation per frame instead of per quantum, and the node lets the encoder queue hold 200 ms of frames. A frame is only dropped when the encoder has stalled, whole, and the encoder is flushed before the next one, which keeps its own timestamp, so the receiver sees the gap and fades over it ([#68]).
- `AudioEncodeNode`: dropped frames are reported in one `console.warn` with their count at most every five seconds, instead of one warning per frame. A stalled encoder no longer stops capture for good after five seconds ([#71]).
- `AudioDecodeNode`: playback starts at the live edge. Blocks arriving at once on joining a stream, as a backlog spanning more than the playout delay, all used to be kept, so playback started that much late (about 250 ms instead of 100 ms) and the adaptive delay then cut 10 ms of audio every two seconds for half a minute to come down. Before anything plays, the playback worklet now moves its reader so the newest block plays one delay from now, skipping the older audio and fading in. A lowering step that cuts through sound crossfades over up to 10 ms instead of 3 ms ([#68]).

## [0.1.0] - TBD

### Added

- Initial release and project setup.

---

## Release Types

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** for vulnerability fixes

## Versioning Guide

- **Major version (X.0.0)**: Incompatible API changes
- **Minor version (0.X.0)**: Add functionality in a backward compatible manner
- **Patch version (0.0.X)**: Backward compatible bug fixes

[Unreleased]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.12.0...HEAD
[0.12.0]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.11.2...av-nodes/v0.12.0
[0.11.2]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.11.1...av-nodes/v0.11.2
[0.11.1]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.11.0...av-nodes/v0.11.1
[0.11.0]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.6...av-nodes/v0.11.0
[0.10.6]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.5...av-nodes/v0.10.6
["#3"]: https://github.com/okdaichi/moqrtc-js/pull/3
[#5]: https://github.com/okdaichi/moqrtc-js/pull/5
[#12]: https://github.com/okdaichi/moqrtc-js/pull/12
[#14]: https://github.com/okdaichi/moqrtc-js/pull/14
[#15]: https://github.com/okdaichi/moqrtc-js/pull/15
[#16]: https://github.com/okdaichi/moqrtc-js/pull/16
[#17]: https://github.com/okdaichi/moqrtc-js/pull/17
[#18]: https://github.com/okdaichi/moqrtc-js/issues/18
[#19]: https://github.com/okdaichi/moqrtc-js/pull/19
[#20]: https://github.com/okdaichi/moqrtc-js/pull/20
[#21]: https://github.com/okdaichi/moqrtc-js/pull/21
[#22]: https://github.com/okdaichi/moqrtc-js/pull/22
[#23]: https://github.com/okdaichi/moqrtc-js/pull/23
[#42]: https://github.com/okdaichi/moqrtc-js/pull/42
[#44]: https://github.com/okdaichi/moqrtc-js/pull/44
[#48]: https://github.com/okdaichi/moqrtc-js/pull/48
[#50]: https://github.com/okdaichi/moqrtc-js/pull/50
[#51]: https://github.com/okdaichi/moqrtc-js/pull/51
[#52]: https://github.com/okdaichi/moqrtc-js/pull/52
[#54]: https://github.com/okdaichi/moqrtc-js/pull/54
[#56]: https://github.com/okdaichi/moqrtc-js/pull/56
[#58]: https://github.com/okdaichi/moqrtc-js/pull/58
[#68]: https://github.com/okdaichi/moqrtc-js/issues/68
[#71]: https://github.com/okdaichi/moqrtc-js/issues/71
[#84]: https://github.com/okdaichi/moqrtc-js/pull/84
[#91]: https://github.com/okdaichi/moqrtc-js/pull/91
[0.1.0]: https://github.com/okdaichi/moqrtc-js/releases/tag/media-log/v0.1.0
[0.10.1]: https://github.com/okdaichi/moqrtc-js/releases/tag/av-nodes/v0.10.1
[0.10.2]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.1...av-nodes/v0.10.2
[0.10.3]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.2...av-nodes/v0.10.3
[0.10.4]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.3...av-nodes/v0.10.4
[0.10.5]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.4...av-nodes/v0.10.5

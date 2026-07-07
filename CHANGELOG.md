# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.4...HEAD
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
[0.1.0]: https://github.com/okdaichi/moqrtc-js/releases/tag/media-log/v0.1.0
[0.10.1]: https://github.com/okdaichi/moqrtc-js/releases/tag/av-nodes/v0.10.1
[0.10.2]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.1...av-nodes/v0.10.2
[0.10.3]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.2...av-nodes/v0.10.3
[0.10.4]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.3...av-nodes/v0.10.4

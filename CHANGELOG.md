# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

This branch contains a large migration to the Deno runtime and a refactor of the AV/media and Room/elements APIs. For the full diff see the [compare view][Unreleased]. Related pull request: [#3].

### Added

- Migrate the repository to the Deno runtime: add `deno.json` and `deno.lock`, convert tests to `Deno.test`, and update CI workflows and VSCode tasks.
- Add AV nodes package and media processing building blocks under `src/internal/av_nodes/` (audio/video encode & decode nodes, worklets, demo, build scripts and Deno tests).
- Add test helpers and headless fakes to support Deno testing (`test_globals.d.ts`, `stubGlobal`, `deleteGlobal`, fake encoders/frames/framesources).
- Add browser-detection utilities and tests for `isChrome` and `isFirefox`.
- Add `FakeAudioDecoder` and `FakeVideoDecoder` test doubles for decoder backpressure testing.
- Add `AudioDecodeNode` tests covering creation, configuration, stream decoding, and backpressure scenarios.
- Add backpressure recovery and stalled-decoder timeout tests for `VideoDecodeNode`.

### Fixed

- `VideoAnalyserNode`: report `frameIndex` as the cumulative *input* frame count (it previously counted only analyzed frames, so with `analysisInterval > 1` it understated the true frame number); validate `analysisSize` / `historySize` / `analysisInterval` (0 or non-integer values previously produced `NaN` metrics or silently disabled analysis; `analysisSize` is also capped at 4096 per side to prevent a multi-hundred-MB allocation from an oversized value).
- `videoEncoderConfig` now validates `width` / `height` / `frameRate` (negative or non-finite values previously produced a negative computed bitrate forwarded to the encoder) and treats an explicit `bitrate` of `0` or negative as "not set", falling back to the calculated bitrate instead of configuring the encoder with bitrate 0.
- Close `VideoFrame`s on throw across the video pipeline (`VideoOverlayNode`, `VideoDestinationNode`, `VideoSourceNode`) so a throwing overlay function, `drawImage`, or `VideoFrame` constructor can no longer leak a GPU-backed frame; and stop the `MediaStreamVideoSourceNode` polyfill from pacing frames twice (it delivered ~half the configured frame rate because both the source loop and the stream `pull()` awaited the next frame).
- Close decoded audio frames even when processing throws, and cancel in-flight decode/encode stream reads on `dispose()` in `AudioDecodeNode`/`VideoDecodeNode`/`AudioEncodeNode` so tearing down a node mid-stream no longer leaks the reader lock, buffers upstream into a dead pipe, or hangs the internal encode loop.
- Fix infinite loop in `VideoDecodeNode` and `AudioDecodeNode` backpressure handling — replace busy `queueMicrotask` spin with event-driven `dequeue` listener and a 5-second timeout fallback ([#5]).
- Fix infinite loop in `AudioEncodeNode` encoder backpressure — wait for the encoder `dequeue` event (with a 5-second timeout) instead of busy-spinning via `queueMicrotask`, and stop reading the stream when the drain times out ([#12]).
- Fix failing `VideoAnalyserNode` test block — force-install the `OffscreenCanvas`/`requestIdleCallback` test doubles regardless of native presence, since Deno's native `OffscreenCanvas.getContext("2d")` returns null headlessly ([#16]).
- Fix `@okdaichi/av-nodes` publish graph: benchmark harnesses (and, due to a root-only glob, ~20 test/fake files) were being published to jsr. Gate `encode_bench.ts`'s runner behind `import.meta.main` and exclude `**/*_bench.ts` / `**/*_test.ts` from `publish.exclude` ([#17]).
- Fix clicks/pops on bursty or jittery audio in `AudioDecodeNode` — `AudioOffloadProcessor` now schedules each decoded block at its presentation timestamp (derived playout frame) instead of writing contiguously at arrival. Gaps are silence-filled, late/overlapping blocks are dropped, and bursts are absorbed up to one buffer of look-ahead, so playback is no longer governed by arrival cadence. The lag cushion is anchored to the first block's arrival frame (so a late first decode still gets a full cushion instead of silencing the node forever), partially-late/pre-base timestamps are clamped to the read pointer (avoids a negative-offset crash that would kill the worklet's message handler), and the playback clock advances on every render quantum including edge-state guard paths ([#18]).

### Changed

- Migrate many tests from Node/Vitest to Deno and remove Node-specific mocking/patch infrastructure.
- Refactor `AudioEncodeNode` / `VideoEncodeNode` to support async output handling, Promise-returning destinations, Map-based destination management, and safer disposal semantics.
- Refactor media APIs (`Camera`, `Microphone`, `Device`) for clearer structure and improved type safety.
- Refactor Room / elements API and test utilities for clarity and maintainability; tests renamed/moved to follow Deno conventions.
- Update dependencies to `@qumo/moq@0.15.0` and `@okdaichi/golikejs@0.9.0`.
- `AudioDecodeNode`: cache the resolved worklet and post decoded frames directly instead of going through a per-frame `.then()` continuation (also guards the fast-path `postMessage` against throws so a failure can't escape into the decoder output callback) ([#14]).
- `AudioEncodeNode`: the worklet-driven encode path (`#next`) now encodes stream-sourced frames directly instead of cloning first (the node owns those frames), cutting per-frame allocation/GC pressure; added `#next`-path test coverage and made `FakeAudioEncoder` model the `dequeue` event ([#15]).
- Add formatting step for generated worklet files using `deno fmt`.

### Removed

- Removed Node.js-specific artifacts and example application files (e.g. `package-lock.json`, `pnpm-lock.yaml`, many files under `example/`).
- Removed legacy migration-only documentation, obsolete mocks, and patch files that are no longer required.

### BREAKING CHANGES

- Migration to Deno and the rewrite of test utilities are breaking changes for workflows that rely on Node/Vitest. Consumers using Node-based tooling must follow migration notes and update CI/dev environments accordingly.

### Notes

- Branch summary: `copilot/migrate-to-deno-runtime` — ~197 files changed, ~17k insertions, ~37k deletions.
- Major added paths: `src/internal/av_nodes/`, `src/internal/av_nodes/demo/`, `deno.json`, `deno.lock`.

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

[Unreleased]: https://github.com/okdaichi/moqrtc-js/compare/main...copilot/migrate-to-deno-runtime
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
[0.10.1]: https://github.com/okdaichi/moqrtc-js/releases/tag/av-nodes/v0.10.1
[0.10.2]: https://github.com/okdaichi/moqrtc-js/compare/av-nodes/v0.10.1...av-nodes/v0.10.2

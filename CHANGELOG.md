# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- Fix infinite loop in `VideoDecodeNode` and `AudioDecodeNode` backpressure handling — replace busy `queueMicrotask` spin with event-driven `dequeue` listener and a 5-second timeout fallback ([#5]).
- Fix infinite loop in `AudioEncodeNode` encoder backpressure — wait for the encoder `dequeue` event (with a 5-second timeout) instead of busy-spinning via `queueMicrotask`, and stop reading the stream when the drain times out ([#12]).
- Fix failing `VideoAnalyserNode` test block — force-install the `OffscreenCanvas`/`requestIdleCallback` test doubles regardless of native presence, since Deno's native `OffscreenCanvas.getContext("2d")` returns null headlessly ([#16]).
- Fix clicks/pops on bursty or jittery audio in `AudioDecodeNode` — `AudioOffloadProcessor` now schedules each decoded block at its presentation timestamp (derived playout frame) instead of writing contiguously at arrival. Gaps are silence-filled, late/overlapping blocks are dropped, and bursts are absorbed up to one buffer of look-ahead, so playback is no longer governed by arrival cadence ([#18]).

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
[#18]: https://github.com/okdaichi/moqrtc-js/pull/18

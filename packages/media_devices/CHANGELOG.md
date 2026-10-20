# Changelog

All notable changes are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Fixes in `@okdaichi/media-devices` (`packages/media_devices`): device lists hold each device once and know the system default, outputs can be listed, a stopped track is never handed out again, and a refresh after permission sees the granted devices.

### Added

- `MediaDeviceContext.getDefaultDevice(kind)`: the input device the system uses by default, resolved from the browser's `default` alias to the device it points at, or else the first device listed.
- `MediaDeviceContext.getOutputDevices()` and `getDefaultOutputDevice()`: the audio outputs a page can play through, kept like the inputs.

### Changed

- `MediaDeviceContext.getDevices(kind)` lists each device once: Chrome's `default` and `communications` alias entries, which repeat a listed device, and entries without an id (hidden until permission) are no longer included. `devices` still returns the browser's list as enumerated.
- `Microphone` defaults to the device `getDefaultDevice("audio")` resolves, instead of a label heuristic that could pick the communications alias.

### Fixed

- `Microphone.getAudioTrack()` and `Camera.getVideoTrack()` handed back their cached track after it had been stopped from outside — a stopped track fires no `ended` event — so a consumer that stopped the published track got the dead track again. An ended track is now never reused.
- `MediaDeviceContext.updateDevices()` called while an enumeration was running returned that enumeration, which could have started before the change being asked about. The device list read right after `requestPermission` could then still lack device ids. One more enumeration now runs after the running one.

## [0.1.0] - 2026-10-19

- Initial release of `@okdaichi/media-devices`. Device management for real-time media apps: device enumeration, permission caching, device selection, device-change tracking, per-track lifecycle management (`Microphone`, `Camera`, `Screen`), and `VolumeController`.

# Changelog

All notable changes are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-22

Minor release of `@okdaichi/media-devices` (`packages/media_devices`). A microphone can follow the system default again and hears when that default moves, the context tells whether a list is unknown, hidden or listed, a microphone that cannot open says why, an unanswered permission prompt no longer hangs, volume fades take their time in milliseconds and mute without a RangeError, and the browser's media devices can be supplied.

### Added

- `MediaDeviceContext` takes options: `mediaDevices` (a `MediaDeviceAccess`, the part of `navigator.mediaDevices` the package uses; defaults to the browser's) and `permissionTimeoutMs` (defaults to `MediaDeviceContext.GET_USER_MEDIA_TIMEOUT`). `context.mediaDevices` is what the context reads, and `Microphone` and `Camera` open their tracks through it.
- `MediaDeviceContext.listStatus(kind)`: a `DeviceListStatus` for `audioinput`, `videoinput` or `audiooutput` — `unknown` before the browser has listed devices, `hidden` while it lists that kind without ids (before permission), or `listed` with the devices and the system default.
- `switchDevice(undefined)` on `Microphone`, `Camera` and `Device` stops preferring a device: `preferred` is cleared, `activeDeviceId` becomes the resolved default, and the live track is stopped.
- `onDefaultChange(deviceId)` on `Microphone` (prop and property) and `Device`: called when the system default moves to another device while no device is preferred. A track already open keeps recording from its device; `switchDevice(undefined)` and `getAudioTrack()` open the new default.
- `MicrophoneError` with a `reason` (`MicrophoneFailure`: `blocked`, `missing`, `busy` or `failed`) and the browser's error as `cause`.
- `VolumeParam` and `VolumeGainNode`: the parts of an `AudioParam` and a `GainNode` a `VolumeController` drives.

### Changed

- `Microphone.getAudioTrack()` rejects with a `MicrophoneError` when the microphone cannot be opened. Its message is the browser's, but its `name` is `MicrophoneError`: code that read the browser's error name (`NotAllowedError`, …) reads `reason`, or the name of `cause`, instead.
- `VolumeController` takes `fadeTimeMs` in milliseconds, as named: any finite positive value is used, and anything else falls back to 80 ms. It accepted only 0.01–1 before and used the value as seconds, so the default fade lasted 80 seconds.
- `VolumeController.gainNode` is typed as a `VolumeGainNode` rather than a `GainNode`-like object with an `AudioContext` and an `AudioParam`.
- `MediaDeviceContext` listens for `devicechange` through `addEventListener` only; it no longer falls back to assigning `ondevicechange`.

### Fixed

- `MediaDeviceContext.requestPermission()` hung for as long as the permission prompt was left unanswered: its timeout never reached `getUserMedia`, which cannot be aborted. It now resolves `false` after the timeout, and a stream granted later is stopped as it arrives (and the devices are read again).
- `VolumeController.mute(true)` scheduled an exponential ramp to 0, which browsers reject with a RangeError, and a fade up from silence started its exponential ramp at 0, so it held silence and then jumped. Fades into silence now end at `minGain` and then drop to 0, and fades out of silence start at `minGain`.
- `Device.switchDevice()` documented that it restarts the stream; it records the device and stops the live track, and the next track asked for opens on it. The documentation now says so.

## [0.2.0] - 2026-10-20

Minor release of `@okdaichi/media-devices` (`packages/media_devices`). Device lists hold each device once and know the system default, outputs can be listed, a stopped track is never handed out again, and a refresh after permission sees the granted devices.

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

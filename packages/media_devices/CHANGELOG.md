# Changelog

All notable changes are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-22

Minor release of `@okdaichi/media-devices` (`packages/media_devices`).

- A microphone or camera can follow the system default again, opening whatever the default is now, and a microphone hears when that default moves.
- The context tells whether a list is unknown, unlisted, hidden or listed.
- A microphone that cannot open says why, and concurrent opens share one track.
- An unanswered permission prompt no longer hangs.
- Volume fades take their time in milliseconds, mute without a RangeError, never start from a stale gain, and restore the volume asked for.
- The browser's media devices and the clock can be supplied.

### Added

- `MediaDeviceContext` takes options:
  - `mediaDevices`: a `MediaDeviceAccess`, the part of `navigator.mediaDevices` the package uses. It defaults to the browser's; `null` means there are none.
  - `permissionTimeoutMs`: defaults to `MediaDeviceContext.GET_USER_MEDIA_TIMEOUT`.
  - `clock`: a `Clock` that starts `Timeout`s; defaults to the global timers.

  `context.mediaDevices` is the media devices the context reads.
- `MediaDeviceContext.requestStream(constraints)`: `getUserMedia` that, while permission for a kind asked for is not yet known to be granted, is bounded by the permission timeout. It then rejects with a `PermissionTimeoutError` (with `timeoutMs`) and stops a stream granted later. Once permission is granted it waits as long as a device takes to start. `requestPermission`, `Microphone` and `Camera` open through it.
- `MediaDeviceContext.listStatus(kind)`: a `DeviceListStatus` for `audioinput`, `videoinput` or `audiooutput`:
  - `unknown` before the browser has listed devices;
  - `unlisted` when it lists no entry of the kind. Either there is no such device, or the browser does not list the kind; not every browser lists audio outputs, and Safari, as far as is known, does not. Every kind is `unlisted` where there are no media devices at all.
  - `hidden` while it lists the kind without ids (before permission);
  - `listed` with the devices and the system default.
- `switchDevice(undefined)` on `Microphone`, `Camera` and `Device` stops preferring a device: `preferred` is cleared, `activeDeviceId` becomes the resolved default, and the live track is stopped.
- `onDefaultChange(deviceId)` on `Microphone` (prop and property) and `Device` is called when the system default moves to another device while no device is preferred. A track already open keeps recording from its device; `switchDevice(undefined)` and then `getAudioTrack()` open the new default.
- `Device.trackConstraints()`: the constraints a track opens with — the preferred device by its id, and the configured constraints.
- `MicrophoneError`, with the browser's error as `cause` and a `reason` (`MicrophoneFailure`):
  - `blocked`: NotAllowedError, SecurityError;
  - `missing`: NotFoundError, OverconstrainedError;
  - `busy`: NotReadableError, TrackStartError;
  - `timeout`: the permission prompt was not answered in time;
  - `aborted`: while it opened, `switchDevice` or `close` was called, or `enabled` or `preferred` was changed;
  - `failed`: anything else.
- `VolumeParam` and `VolumeGainNode`: the parts of an `AudioParam` and a `GainNode` a `VolumeController` drives.

### Changed

- `Microphone.getAudioTrack()` rejects with a `MicrophoneError` when the microphone cannot be opened. Its message is the browser's, but its `name` is `MicrophoneError`, so code that read the browser's error name (`NotAllowedError`, …) must read `reason`, or the name of `cause`, instead. A disabled or closed microphone rejects with a plain `Error`, because that is the caller's mistake and not a failure to open.
- `Microphone` and `Camera` name a device to `getUserMedia` only when one is preferred. While they follow the default they ask for no device, so the browser opens its default as it is now. Before, they pinned the default last listed, which a device just unplugged left stale (an OverconstrainedError). `Camera` no longer asks for permission before opening, so its label heuristic no longer picks the camera opened.
- `Microphone.getAudioTrack()` no longer asks for permission first and then opens a second time; it opens once. Calls made while it opens share that open. An open overtaken by `switchDevice`, `close`, `enabled = false` or a new `preferred` stops any track it got and rejects as `aborted`, however it ended. A closed microphone opens no more tracks.
- `activeDeviceId` names the device the live track records from while one is open, and is not overwritten by an enumeration. With no live track it is the preferred device or else the system default. When the browser reports the track's device as an alias (`default`), it keeps the device the default resolves to.
- `VolumeController` takes `fadeTimeMs` in milliseconds, as its name says: any finite positive value is used, and anything else falls back to 80 ms. It accepted only 0.01–1 before and used the value as seconds, so the default fade lasted 80 seconds. A value meant as seconds now gives a fade of that many milliseconds.
- `VolumeController.volume` is the gain asked for — where a fade is heading, and 0 while muted — rather than `gain.value`. `setVolume()` while muted only keeps the volume to restore on unmute.
- `VolumeController.gainNode` is typed as a `VolumeGainNode` rather than a `GainNode`-like object with an `AudioContext` and an `AudioParam`.
- `MediaDeviceContext` listens for `devicechange` through `addEventListener` only; it no longer falls back to assigning `ondevicechange`.

### Fixed

- `MediaDeviceContext.requestPermission()` hung for as long as the permission prompt was left unanswered: its timeout never reached `getUserMedia`, which cannot be aborted. It now resolves `false` after the timeout, and a stream granted later is stopped as it arrives (and the devices are read again).
- A device listener that throws no longer keeps the listeners after it from hearing an enumeration, and is no longer reported as a failed enumeration.
- Where there are no media devices, the context never told its listeners, and its lists stayed unknown.
- `VolumeController` started each fade from `gain.value`, which a browser updates only as it renders, so a fade right after construction, or during another fade, could start from the param's default of 1: a blip at full volume. Fades now start from the gain the controller's own schedule gives at that moment.
- `VolumeController.mute(true)` scheduled an exponential ramp to 0, which browsers reject with a RangeError. A fade up from silence started its exponential ramp at 0, so it held silence and then jumped. Fades into silence now end at `minGain` and then drop to 0, and fades out of silence start at `minGain`.
- `VolumeController` muted mid-fade restored the gain it had reached rather than the volume it was fading to. `setVolume()` while muted made the audio heard while `muted` stayed true.
- `Device.switchDevice()` was documented as restarting the stream, but it only records the device and stops the live track; the next track asked for opens on it. The documentation now says so.

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

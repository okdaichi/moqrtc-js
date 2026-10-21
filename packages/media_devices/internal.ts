/**
 * Helpers shared by the package's modules. `mod.ts` does not export this
 * module: nothing here is part of the package's API.
 */

/**
 * The deviceIds a browser gives entries that follow a system choice rather
 * than name a device: Chrome lists the system default as "default" and, on
 * Windows, the communications device as "communications", each beside the
 * device it currently points at.
 */
const ALIAS_DEVICE_IDS: ReadonlySet<string> = new Set(["default", "communications"]);

/** isAliasDeviceId reports whether deviceId follows a system choice rather than names a device. */
export function isAliasDeviceId(deviceId: string): boolean {
	return ALIAS_DEVICE_IDS.has(deviceId);
}

/** stopTracks releases every track of stream. MediaStreamTrack.stop() does not throw. */
export function stopTracks(stream: MediaStream): void {
	for (const track of stream.getTracks()) track.stop();
}

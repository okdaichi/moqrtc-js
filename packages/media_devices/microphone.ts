import { Device, MediaDeviceContext, PermissionTimeoutError } from "./device.ts";
import { isAliasDeviceId, stopTracks } from "./internal.ts";

export interface MicrophoneProps {
	enabled?: boolean;
	constraints?: MediaTrackConstraints;
	preferred?: string;
	onTrackEnded?: (reason: string) => void;
	/**
	 * Called with the new default's deviceId when the system default
	 * microphone moves to another device while the microphone follows the
	 * default (no preferred device). A track already open keeps recording from
	 * the device it was opened on: `switchDevice(undefined)` then
	 * `getAudioTrack()` opens the new default.
	 */
	onDefaultChange?: (deviceId: string) => void;
}

/**
 * Why the microphone could not be opened:
 * - `blocked`: the browser or the user refused it;
 * - `missing`: there is no such microphone;
 * - `busy`: another application holds it, or the system could not start it;
 * - `timeout`: the permission prompt was not answered within the context's
 *   permission timeout (a microphone granted later is stopped at once);
 * - `aborted`: while it was opening, switchDevice or close was called, or
 *   `enabled` or `preferred` was changed; a track it opened was stopped;
 * - `failed`: anything else.
 */
export type MicrophoneFailure = "blocked" | "missing" | "busy" | "timeout" | "aborted" | "failed";

/**
 * MicrophoneError is why getAudioTrack could not open the microphone. The
 * error the browser gave, if any, is its `cause`.
 */
export class MicrophoneError extends Error {
	override readonly name = "MicrophoneError";
	readonly reason: MicrophoneFailure;

	constructor(reason: MicrophoneFailure, message: string, options?: ErrorOptions) {
		super(message, options);
		this.reason = reason;
	}
}

/** The getUserMedia error names that say why the microphone did not open. */
const FAILURE_BY_ERROR_NAME: ReadonlyMap<string, MicrophoneFailure> = new Map([
	["NotAllowedError", "blocked"],
	["SecurityError", "blocked"],
	["NotFoundError", "missing"],
	["OverconstrainedError", "missing"],
	["NotReadableError", "busy"],
	["TrackStartError", "busy"],
]);

/** microphoneErrorOf names why the microphone did not open. */
function microphoneErrorOf(error: unknown): MicrophoneError {
	if (error instanceof MicrophoneError) return error;
	if (error instanceof PermissionTimeoutError) {
		return new MicrophoneError("timeout", error.message, { cause: error });
	}
	if (error instanceof Error) {
		const reason = FAILURE_BY_ERROR_NAME.get(error.name) ?? "failed";
		return new MicrophoneError(reason, error.message, { cause: error });
	}
	return new MicrophoneError("failed", "Failed to obtain microphone track", { cause: error });
}

/** abortedBy is the error of an open abandoned while it ran; cause is how it ended, if it failed. */
function abortedBy(cause: unknown): MicrophoneError {
	return new MicrophoneError("aborted", "The microphone open was abandoned while it ran", {
		cause,
	});
}

/**
 * Microphone manages audio input from microphone devices.
 *
 * @example
 * ```typescript
 * const deviceContext = new MediaDeviceContext();
 * const microphone = new Microphone(deviceContext, { enabled: true });
 * const track = await microphone.getAudioTrack();
 * ```
 */
export class Microphone {
	readonly #device: Device<"audio">;
	/** The open in flight, which concurrent getAudioTrack calls share. */
	#opening: Promise<MediaStreamTrack> | undefined;
	/**
	 * Counts switches, closes and changes of `enabled` and `preferred`: an open
	 * that started before one is stale.
	 */
	#generation = 0;
	#closed = false;

	constructor(context: MediaDeviceContext, props?: MicrophoneProps) {
		this.#device = new Device(context, "audio", {
			...props,
			// The system's default microphone, as the context resolves it.
			getDefaultDeviceId: () => context.getDefaultDevice("audio")?.deviceId,
		});
	}

	// Delegate to Device
	get context(): MediaDeviceContext {
		return this.#device.context;
	}
	get kind(): "audio" {
		return this.#device.kind;
	}
	get enabled(): boolean {
		return this.#device.enabled;
	}
	/** Disabling the microphone abandons an open in flight. */
	set enabled(value: boolean) {
		if (!value) this.#abandonOpen();
		this.#device.enabled = value;
	}
	get constraints(): MediaTrackConstraints | undefined {
		return this.#device.constraints;
	}
	set constraints(value: MediaTrackConstraints | undefined) {
		this.#device.constraints = value;
	}
	get preferred(): string | undefined {
		return this.#device.preferred;
	}
	/**
	 * Setting the preferred device abandons an open in flight; unlike
	 * switchDevice, it leaves a live track open on its device.
	 */
	set preferred(value: string | undefined) {
		if (value !== this.#device.preferred) this.#abandonOpen();
		this.#device.preferred = value;
	}
	get activeDeviceId(): string | undefined {
		return this.#device.activeDeviceId;
	}
	set activeDeviceId(value: string | undefined) {
		this.#device.activeDeviceId = value;
	}
	get onTrackEnded(): ((reason: string) => void) | undefined {
		return this.#device.onTrackEnded;
	}
	set onTrackEnded(value: ((reason: string) => void) | undefined) {
		this.#device.onTrackEnded = value;
	}
	get onDefaultChange(): ((deviceId: string) => void) | undefined {
		return this.#device.onDefaultChange;
	}
	set onDefaultChange(value: ((deviceId: string) => void) | undefined) {
		this.#device.onDefaultChange = value;
	}

	/**
	 * switchDevice records deviceId as the microphone to use — or, given
	 * undefined, follows the system default again — and stops the live track.
	 * The next getAudioTrack opens the device switched to; an open still in
	 * flight is abandoned, and rejects as `aborted`.
	 */
	async switchDevice(deviceId: string | undefined): Promise<void> {
		this.#abandonOpen();
		return this.#device.switchDevice(deviceId);
	}

	async updateConstraints(constraints: MediaTrackConstraints): Promise<void> {
		return this.#device.updateConstraints(constraints);
	}

	/**
	 * close stops the live track and abandons an open in flight. A closed
	 * microphone opens no more tracks.
	 */
	close(): void {
		this.#closed = true;
		this.#abandonOpen();
		this.#device.close();
	}

	#abandonOpen(): void {
		this.#generation++;
		this.#opening = undefined;
	}

	/**
	 * getAudioTrack hands out the live microphone track, opening one when
	 * there is none; calls made while it opens share that open. A preferred
	 * microphone is opened by its id; one that follows the system default is
	 * left to the browser, which opens the default as it is now. A closed or
	 * disabled microphone rejects with a plain Error: that is the caller's
	 * mistake, not a microphone that failed. One that cannot be opened rejects
	 * with a MicrophoneError saying why.
	 */
	getAudioTrack(): Promise<MediaStreamTrack> {
		if (this.#closed) {
			return Promise.reject(new Error("Microphone is closed"));
		}
		if (!this.#device.enabled) {
			return Promise.reject(new Error("Microphone is not enabled"));
		}

		const live = this.#device.stream;
		if (live) return Promise.resolve(live);
		if (this.#opening) return this.#opening;

		const opening = this.#open(this.#generation).finally(() => {
			if (this.#opening === opening) this.#opening = undefined;
		});
		this.#opening = opening;
		return opening;
	}

	async #open(generation: number): Promise<MediaStreamTrack> {
		const context = this.#device.context;
		let stream: MediaStream;
		try {
			stream = await context.requestStream({ audio: this.#device.trackConstraints() });
		} catch (error) {
			// An open abandoned meanwhile is reported as such, however it ended.
			throw generation === this.#generation ? microphoneErrorOf(error) : abortedBy(error);
		}
		if (generation !== this.#generation) {
			stopTracks(stream);
			throw abortedBy(undefined);
		}

		const track = stream.getAudioTracks()[0];
		if (!track) {
			stopTracks(stream);
			throw new MicrophoneError("failed", "Failed to obtain microphone track");
		}

		// The device the track records from; an alias id ("default") names no
		// device, so the default the context resolved stays.
		const deviceId = track.getSettings().deviceId;
		if (deviceId && !isAliasDeviceId(deviceId)) {
			this.#device.activeDeviceId = deviceId;
		}

		// Set up track ended listener
		track.addEventListener("ended", () => {
			// A live track that already replaced this one stays.
			if (this.#device.stream) return;
			this.#device.stream = undefined;
			this.#device.onTrackEnded?.("Device disconnected or track ended");
		});

		this.#device.stream = track;

		// The first microphone opened grants the permission the browser needs
		// before it names devices.
		if (!context.hasPermission("audio")) void context.updateDevices();
		return track;
	}
}

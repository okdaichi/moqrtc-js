import { Device, MediaDeviceContext } from "./device.ts";

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
 * Why the microphone could not be opened: the browser or the user refused it
 * (`blocked`), there is no such microphone (`missing`), another application
 * holds it or the system could not start it (`busy`), or anything else
 * (`failed`).
 */
export type MicrophoneFailure = "blocked" | "missing" | "busy" | "failed";

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
	if (error instanceof Error) {
		const reason = FAILURE_BY_ERROR_NAME.get(error.name) ?? "failed";
		return new MicrophoneError(reason, error.message, { cause: error });
	}
	return new MicrophoneError("failed", "Failed to obtain microphone track", { cause: error });
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
	set enabled(value: boolean) {
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
	set preferred(value: string | undefined) {
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
	 * The next getAudioTrack opens the device switched to.
	 */
	async switchDevice(deviceId: string | undefined): Promise<void> {
		return this.#device.switchDevice(deviceId);
	}

	async updateConstraints(constraints: MediaTrackConstraints): Promise<void> {
		return this.#device.updateConstraints(constraints);
	}

	close(): void {
		this.#device.close();
	}

	/**
	 * getAudioTrack hands out the live microphone track, opening one through
	 * the context's media devices when there is none. A microphone that
	 * cannot be opened rejects with a MicrophoneError saying why.
	 */
	async getAudioTrack(): Promise<MediaStreamTrack> {
		if (!this.#device.enabled) {
			throw new Error("Microphone is not enabled");
		}

		if (this.#device.stream) return this.#device.stream;

		// Ensure permissions are granted
		try {
			await this.#device.context.requestPermission(this.#device.kind);
		} catch {
			// requestPermission is best-effort; continue to try
		}

		const deviceIdConstraint: MediaTrackConstraints = this.#device.activeDeviceId
			? { deviceId: { exact: this.#device.activeDeviceId } }
			: {};

		const constraints: MediaStreamConstraints = {
			audio: {
				...deviceIdConstraint,
				...(this.#device.constraints ?? {}),
			},
		};

		const media = this.#device.context.mediaDevices;
		if (media === undefined || typeof media.getUserMedia !== "function") {
			throw new MicrophoneError(
				"failed",
				"getUserMedia is not available in this environment",
			);
		}

		let stream: MediaStream | undefined;
		try {
			stream = await media.getUserMedia(constraints);
			const track = stream.getAudioTracks()[0];

			if (!track) {
				throw new MicrophoneError("failed", "Failed to obtain microphone track");
			}

			// Update activeDeviceId from actual settings
			const settings = track.getSettings();
			if (settings?.deviceId) {
				this.#device.activeDeviceId = settings.deviceId;
			}

			// Set up track ended listener
			track.addEventListener("ended", () => {
				// A live track that already replaced this one stays.
				if (this.#device.stream) return;
				this.#device.stream = undefined;
				this.#device.onTrackEnded?.("Device disconnected or track ended");
			});

			this.#device.stream = track;
			return track;
		} catch (error) {
			// Ensure any partial stream is stopped
			stream?.getTracks().forEach((t) => {
				try {
					t.stop();
				} catch {
					// Ignore errors when stopping track
				}
			});
			throw microphoneErrorOf(error);
		}
	}
}

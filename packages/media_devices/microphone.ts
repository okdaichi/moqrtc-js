import { Device, MediaDeviceContext } from "./device.ts";

export interface MicrophoneProps {
	enabled?: boolean;
	constraints?: MediaTrackConstraints;
	preferred?: string;
	onTrackEnded?: (reason: string) => void;
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

	async switchDevice(deviceId: string): Promise<void> {
		return this.#device.switchDevice(deviceId);
	}

	async updateConstraints(constraints: MediaTrackConstraints): Promise<void> {
		return this.#device.updateConstraints(constraints);
	}

	close(): void {
		this.#device.close();
	}

	/**
	 * Get audio track.
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

		if (!navigator?.mediaDevices?.getUserMedia) {
			throw new Error("getUserMedia is not available in this environment");
		}

		let stream: MediaStream | undefined;
		try {
			stream = await navigator.mediaDevices.getUserMedia(constraints);
			const track = stream.getAudioTracks()[0];

			if (!track) {
				stream.getTracks().forEach((t) => t.stop());
				throw new Error("Failed to obtain microphone track");
			}

			// Update activeDeviceId from actual settings
			const settings = track.getSettings();
			if (settings?.deviceId) {
				this.#device.activeDeviceId = settings.deviceId;
			}

			// Set up track ended listener
			track.addEventListener("ended", () => {
				this.#device.stream = undefined;
				this.#device.onTrackEnded?.("Device disconnected or track ended");
			});

			this.#device.stream = track;
			return this.#device.stream;
		} catch (error) {
			// Ensure any partial stream is stopped
			stream?.getTracks().forEach((t) => {
				try {
					t.stop();
				} catch {
					// Ignore errors when stopping track
				}
			});
			throw error instanceof Error ? error : new Error("Failed to obtain microphone track");
		}
	}
}

import { MediaDeviceContext } from "./device.ts";

export interface MicrophoneProps {
	enabled?: boolean;
	constraints?: MediaTrackConstraints;
	preferred?: string;
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
	readonly context: MediaDeviceContext;
	readonly kind: "audio" = "audio";
	enabled: boolean;
	constraints: MediaTrackConstraints | undefined;
	preferred: string | undefined;
	activeDeviceId: string | undefined;
	#stream: MediaStreamTrack | undefined;
	#unsubscribe: (() => void) | undefined;

	constructor(context: MediaDeviceContext, props?: MicrophoneProps) {
		this.context = context;
		this.enabled = props?.enabled ?? false;
		this.constraints = props?.constraints;
		this.preferred = props?.preferred;

		// Subscribe to device changes
		this.#unsubscribe = this.context.subscribe(() => {
			this.activeDeviceId = this.preferred || this.#getDefaultDeviceId();
		});

		// Set initial activeDeviceId
		this.activeDeviceId = this.preferred || this.#getDefaultDeviceId();
	}

	#getDefaultDeviceId(): string | undefined {
		const devices = this.context.getDevices(this.kind);
		
		if (devices.length === 0) {
			return undefined;
		}

		// Find default device using heuristics
		let defaultDevice = devices.find((d) => d.deviceId === "default");
		if (!defaultDevice) {
			defaultDevice = devices.find((d) =>
				d.label.toLowerCase().includes("default") ||
				d.label.toLowerCase().includes("communications")
			);
		}
		if (!defaultDevice) {
			defaultDevice = devices[0];
		}
		return defaultDevice?.deviceId;
	}

	/**
	 * Return a promise that resolves to the current MediaStreamTrack for the microphone.
	 * If the microphone is not started it will call start(). Caller should await
	 * this instead of accessing `.stream` directly.
	 */
	async getAudioTrack(): Promise<MediaStreamTrack> {
		if (!this.enabled) {
			throw new Error("Microphone is not enabled");
		}

		if (this.#stream) return this.#stream;

		// Ensure permissions are granted
		try {
			await this.context.requestPermission(this.kind);
		} catch {
			// requestPermission is best-effort; continue to try
		}

		const deviceIdConstraint = this.activeDeviceId
			? { deviceId: { exact: this.activeDeviceId } }
			: {};

		const constraints: MediaStreamConstraints = {
			audio: { ...(deviceIdConstraint as any), ...(this.constraints ?? {}) }
		};

		if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
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

			const settings = track.getSettings();
			if (settings && settings.deviceId) {
				this.activeDeviceId = settings.deviceId;
			}

			this.#stream = track;
			return this.#stream;
		} catch (error) {
			// Ensure any partial stream is stopped
			try {
				stream?.getTracks().forEach((t) => t.stop());
			} catch {
				// Ignore cleanup errors
			}
			throw error instanceof Error ? error : new Error("Failed to obtain microphone track");
		}
	}

	async getSettings(): Promise<MediaTrackSettings> {
		const track = await this.getAudioTrack();
		return track.getSettings();
	}

	close(): void {
		if (this.#stream) {
			try {
				this.#stream.stop();
			} catch (error) {
				// Ignore errors when stopping track
			}
			this.#stream = undefined;
		}
		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
		}
	}
}

import { MediaDeviceContext } from "./device.ts";

export interface CameraProps {
	enabled?: boolean;
	constraints?: MediaTrackConstraints;
	preferred?: string;
}

/**
 * Camera manages video input from camera devices.
 * 
 * @example
 * ```typescript
 * const deviceContext = new MediaDeviceContext();
 * const camera = new Camera(deviceContext, { enabled: true });
 * const track = await camera.getVideoTrack();
 * ```
 */
export class Camera {
	readonly context: MediaDeviceContext;
	readonly kind: "video" = "video";
	enabled: boolean;
	constraints: MediaTrackConstraints | undefined;
	preferred: string | undefined;
	activeDeviceId: string | undefined;
	#stream: MediaStreamTrack | undefined;
	#unsubscribe: (() => void) | undefined;

	constructor(context: MediaDeviceContext, props?: CameraProps) {
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
				d.label.toLowerCase().includes("front") ||
				d.label.toLowerCase().includes("external") ||
				d.label.toLowerCase().includes("usb")
			);
		}
		if (!defaultDevice) {
			defaultDevice = devices[0];
		}
		return defaultDevice?.deviceId;
	}

	/**
	 * Return a promise that resolves to the current MediaStreamTrack for the camera.
	 * If the camera is not started it will call start().
	 * On failure this rejects with an Error instead of returning undefined.
	 */
	async getVideoTrack(): Promise<MediaStreamTrack> {
		if (!this.enabled) {
			throw new Error("Camera is not enabled");
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
			video: { ...(deviceIdConstraint as any), ...(this.constraints ?? {}) }
		};

		if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			throw new Error("getUserMedia is not available in this environment");
		}

		let stream: MediaStream | undefined;
		try {
			stream = await navigator.mediaDevices.getUserMedia(constraints);
			const track = stream.getVideoTracks()[0];
			if (!track) {
				stream.getTracks().forEach((t) => t.stop());
				throw new Error("Failed to obtain camera track");
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
			throw error instanceof Error ? error : new Error("Failed to obtain camera track");
		}
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

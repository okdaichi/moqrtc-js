import { Device, MediaDeviceContext } from "./device.ts";

export interface CameraProps {
	enabled?: boolean;
	constraints?: MediaTrackConstraints;
	preferred?: string;
	onTrackEnded?: (reason: string) => void;
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
	readonly #device: Device<"video">;

	constructor(context: MediaDeviceContext, props?: CameraProps) {
		this.#device = new Device(context, "video", {
			...props,
			getDefaultDeviceId: (devices) => {
				if (devices.length === 0) {
					return undefined;
				}

				// Find default device using heuristics for cameras
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
			},
		});
	}

	// Delegate to Device
	get context() {
		return this.#device.context;
	}
	get kind() {
		return this.#device.kind;
	}
	get enabled() {
		return this.#device.enabled;
	}
	set enabled(value: boolean) {
		this.#device.enabled = value;
	}
	get constraints() {
		return this.#device.constraints;
	}
	set constraints(value: MediaTrackConstraints | undefined) {
		this.#device.constraints = value;
	}
	get preferred() {
		return this.#device.preferred;
	}
	set preferred(value: string | undefined) {
		this.#device.preferred = value;
	}
	get activeDeviceId() {
		return this.#device.activeDeviceId;
	}
	set activeDeviceId(value: string | undefined) {
		this.#device.activeDeviceId = value;
	}
	get onTrackEnded() {
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
	 * Get video track.
	 */
	async getVideoTrack(): Promise<MediaStreamTrack> {
		if (!this.#device.enabled) {
			throw new Error("Camera is not enabled");
		}

		if (this.#device.stream) return this.#device.stream;

		// Ensure permissions are granted
		try {
			await this.#device.context.requestPermission(this.#device.kind);
		} catch {
			// requestPermission is best-effort; continue to try
		}

		const deviceIdConstraint = this.#device.activeDeviceId
			? { deviceId: { exact: this.#device.activeDeviceId } }
			: {};

		const constraints: MediaStreamConstraints = {
			video: {
				...(deviceIdConstraint as any),
				...(this.#device.constraints ?? {}),
			},
		};

		if (!navigator?.mediaDevices?.getUserMedia) {
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
			throw error instanceof Error ? error : new Error("Failed to obtain camera track");
		}
	}
}

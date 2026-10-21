import { Device, MediaDeviceContext } from "./device.ts";
import { stopTracks } from "./internal.ts";

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
				let defaultDevice = devices.find((d) =>
					d.label.toLowerCase().includes("front") ||
					d.label.toLowerCase().includes("external") ||
					d.label.toLowerCase().includes("usb")
				);
				if (!defaultDevice) {
					defaultDevice = devices[0];
				}
				return defaultDevice?.deviceId;
			},
		});
	}

	// Delegate to Device
	get context(): MediaDeviceContext {
		return this.#device.context;
	}
	get kind(): "video" {
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

	/**
	 * switchDevice records deviceId as the camera to use — or, given
	 * undefined, follows the default camera again — and stops the live track.
	 * The next getVideoTrack opens the device switched to.
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
	 * Get video track.
	 */
	async getVideoTrack(): Promise<MediaStreamTrack> {
		if (!this.#device.enabled) {
			throw new Error("Camera is not enabled");
		}

		if (this.#device.stream) return this.#device.stream;

		// Permission names the devices, so the default camera can be chosen.
		await this.#device.context.requestPermission(this.#device.kind);

		const deviceIdConstraint: MediaTrackConstraints = this.#device.activeDeviceId
			? { deviceId: { exact: this.#device.activeDeviceId } }
			: {};

		const constraints: MediaStreamConstraints = {
			video: {
				...deviceIdConstraint,
				...(this.#device.constraints ?? {}),
			},
		};

		const stream = await this.#device.context.requestStream(constraints);
		if (stream === undefined) {
			throw new Error("The camera prompt was not answered in time");
		}

		const track = stream.getVideoTracks()[0];
		if (!track) {
			stopTracks(stream);
			throw new Error("Failed to obtain camera track");
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
	}
}

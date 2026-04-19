/**
 * MediaDeviceContext manages shared state for all media devices.
 * Context pattern allows explicit dependency injection and clear boundaries.
 *
 * @example
 * ```typescript
 * // Create a context for managing media devices
 * const deviceContext = new MediaDeviceContext();
 *
 * // Use it with Camera and Microphone
 * const camera = new Camera(deviceContext, { enabled: true });
 * const microphone = new Microphone(deviceContext, { enabled: true });
 *
 * // Subscribe to device changes
 * const unsubscribe = deviceContext.subscribe((devices) => {
 *   console.log('Available devices:', devices);
 * });
 *
 * // Cleanup when done
 * deviceContext.close();
 * ```
 */
export class MediaDeviceContext {
	#devices: MediaDeviceInfo[] = [];
	#permissions: Map<"audio" | "video", boolean> = new Map();
	#permissionRequests: Map<"audio" | "video", Promise<boolean>> = new Map();
	#listeners: Set<(devices: MediaDeviceInfo[]) => void> = new Set();
	#onchange: (() => void) | undefined;
	#debounceTimer: number | undefined;
	#updateInProgress: Promise<void> | undefined;

	static GET_USER_MEDIA_TIMEOUT = 8000; // 8s

	/** Get all available devices (readonly) */
	get devices(): readonly MediaDeviceInfo[] {
		return this.#devices;
	}

	constructor() {
		// Initial device enumeration
		void this.updateDevices();

		// Set up devicechange listener once for all Device instances
		this.#onchange = () => {
			// Debounce rapid devicechange events
			if (typeof this.#debounceTimer !== "undefined") {
				clearTimeout(this.#debounceTimer);
			}
			// Schedule update slightly later to aggregate rapid changes
			this.#debounceTimer = globalThis.setTimeout(() => {
				this.#debounceTimer = undefined;
				void this.updateDevices();
			}, 200);
		};

		// Only set up event listeners if mediaDevices is available
		if (navigator && navigator.mediaDevices) {
			try {
				navigator.mediaDevices.addEventListener(
					"devicechange",
					this.#onchange as EventListener,
				);
			} catch (_e) {
				// Some environments may not support addEventListener on mediaDevices
				// Fall back to assigning onchange if available
				if (typeof navigator.mediaDevices.ondevicechange !== "undefined") {
					navigator.mediaDevices.ondevicechange = this.#onchange;
				}
			}
		}
	}

	async updateDevices(): Promise<void> {
		// Prevent duplicate concurrent updates
		if (this.#updateInProgress) {
			return this.#updateInProgress;
		}

		if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
			this.#devices = [];
			return;
		}

		this.#updateInProgress = (async () => {
			try {
				const devices = await navigator.mediaDevices.enumerateDevices();
				this.#devices = devices;

				// Check if we have permission by looking for devices with IDs
				const hasAudioPermission = devices.some((d) =>
					d.kind === "audioinput" && d.deviceId !== ""
				);
				const hasVideoPermission = devices.some((d) =>
					d.kind === "videoinput" && d.deviceId !== ""
				);

				if (hasAudioPermission) this.#permissions.set("audio", true);
				if (hasVideoPermission) this.#permissions.set("video", true);

				// Notify all listeners
				this.#listeners.forEach((fn) => fn(devices));
			} catch (error) {
				console.warn("Failed to update devices:", error);
			}
		})();

		await this.#updateInProgress;
		this.#updateInProgress = undefined;
	}

	getDevices(kind: "audio" | "video"): MediaDeviceInfo[] {
		return this.#devices.filter((d) => d.kind === `${kind}input`);
	}

	/**
	 * Find a specific device by label, deviceId, or groupId.
	 */
	findDevice(kind: "audio" | "video", query: {
		label?: string;
		deviceId?: string;
		groupId?: string;
	}): MediaDeviceInfo | undefined {
		const devices = this.getDevices(kind);
		return devices.find((d) => {
			if (query.deviceId && d.deviceId === query.deviceId) return true;
			if (query.groupId && d.groupId === query.groupId) return true;
			if (query.label && d.label.toLowerCase().includes(query.label.toLowerCase())) {
				return true;
			}
			return false;
		});
	}

	/**
	 * Get statistics about devices and permissions.
	 */
	getStats(): {
		audioDevices: number;
		videoDevices: number;
		hasAudioPermission: boolean;
		hasVideoPermission: boolean;
		activeListeners: number;
	} {
		return {
			audioDevices: this.getDevices("audio").length,
			videoDevices: this.getDevices("video").length,
			hasAudioPermission: this.hasPermission("audio"),
			hasVideoPermission: this.hasPermission("video"),
			activeListeners: this.#listeners.size,
		};
	}

	hasPermission(kind: "audio" | "video"): boolean {
		return this.#permissions.get(kind) ?? false;
	}

	async requestPermission(kind: "audio" | "video"): Promise<boolean> {
		// Return cached permission state if already granted
		if (this.hasPermission(kind)) {
			return true;
		}

		// Return in-flight request if one exists (prevents duplicate getUserMedia calls)
		const existingRequest = this.#permissionRequests.get(kind);
		if (existingRequest) {
			return existingRequest;
		}

		if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			console.warn("getUserMedia is not available in this environment");
			return false;
		}

		// Create new permission request
		const request = (async () => {
			const controller = new AbortController();
			const timeoutId = globalThis.setTimeout(
				() => controller.abort(),
				MediaDeviceContext.GET_USER_MEDIA_TIMEOUT,
			);

			try {
				const stream = await navigator.mediaDevices.getUserMedia(
					{ [kind]: true } as MediaStreamConstraints,
				);
				this.#permissions.set(kind, true);

				// Clean up the temporary stream
				stream.getTracks().forEach((track) => track.stop());

				// Update device list to get fresh data with labels
				await this.updateDevices();

				return true;
			} catch (error) {
				console.warn(`Failed to request ${kind} permission:`, error);
				return false;
			} finally {
				clearTimeout(timeoutId);
				controller.abort();
				this.#permissionRequests.delete(kind);
			}
		})();

		this.#permissionRequests.set(kind, request);
		return request;
	}

	subscribe(listener: (devices: MediaDeviceInfo[]) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): void {
		if (this.#onchange && navigator && navigator.mediaDevices) {
			try {
				if (typeof navigator.mediaDevices.removeEventListener === "function") {
					navigator.mediaDevices.removeEventListener("devicechange", this.#onchange);
				} else if (typeof navigator.mediaDevices.ondevicechange !== "undefined") {
					navigator.mediaDevices.ondevicechange = null;
				}
			} catch (_e) {
				// Ignore
			}
			this.#onchange = undefined;
		}

		if (typeof this.#debounceTimer !== "undefined") {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = undefined;
		}

		this.#listeners.clear();
		this.#permissions.clear();
		this.#permissionRequests.clear();
	}
}

/**
 * Options for creating a Device instance.
 */
export interface DeviceOptions {
	enabled?: boolean;
	constraints?: MediaTrackConstraints;
	preferred?: string;
	onTrackEnded?: (reason: string) => void;
	getDefaultDeviceId: (devices: MediaDeviceInfo[]) => string | undefined;
}

/**
 * Device manages media input (audio/video) track lifecycle.
 * Designed to be embedded in Camera/Microphone classes.
 */
export class Device<K extends "audio" | "video"> {
	readonly context: MediaDeviceContext;
	readonly kind: K;
	enabled: boolean;
	constraints: MediaTrackConstraints | undefined;
	preferred: string | undefined;
	activeDeviceId: string | undefined;
	onTrackEnded?: (reason: string) => void;

	#stream: MediaStreamTrack | undefined;
	#unsubscribe: (() => void) | undefined;
	#getDefaultDeviceId: (devices: MediaDeviceInfo[]) => string | undefined;

	constructor(
		context: MediaDeviceContext,
		kind: K,
		options: DeviceOptions,
	) {
		this.context = context;
		this.kind = kind;
		this.enabled = options.enabled ?? false;
		this.constraints = options.constraints;
		this.preferred = options.preferred;
		this.onTrackEnded = options.onTrackEnded;
		this.#getDefaultDeviceId = options.getDefaultDeviceId;

		// Subscribe to device changes
		this.#unsubscribe = this.context.subscribe(() => {
			this.activeDeviceId = this.preferred || this.defaultDeviceId;
		});

		// Set initial activeDeviceId
		this.activeDeviceId = this.preferred || this.defaultDeviceId;
	}

	/** Get default device ID using provided heuristics */
	get defaultDeviceId(): string | undefined {
		const devices = this.context.getDevices(this.kind);
		return this.#getDefaultDeviceId(devices);
	}

	/** Get current stream */
	get stream(): MediaStreamTrack | undefined {
		return this.#stream;
	}

	/** Set current stream */
	set stream(track: MediaStreamTrack | undefined) {
		this.#stream = track;
	}

	/**
	 * Stop current track.
	 */
	stop(): void {
		if (this.#stream) {
			try {
				this.#stream.stop();
			} catch {
				// Ignore errors when stopping track
			}
			this.#stream = undefined;
		}
	}

	/**
	 * Switch to a different device.
	 * If currently streaming, stops and restarts with the new device.
	 */
	async switchDevice(deviceId: string): Promise<void> {
		this.preferred = deviceId;
		this.activeDeviceId = deviceId;

		// Stop current stream
		this.stop();
	}

	/**
	 * Update track constraints dynamically.
	 * Applies to active track if streaming.
	 */
	async updateConstraints(constraints: MediaTrackConstraints): Promise<void> {
		this.constraints = constraints;

		if (this.#stream) {
			await this.#stream.applyConstraints(constraints);
		}
	}

	/**
	 * Close and cleanup resources.
	 */
	close(): void {
		this.stop();

		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
		}
	}
}

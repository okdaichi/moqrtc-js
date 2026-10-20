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
/**
 * The deviceIds a browser gives entries that follow a system choice rather
 * than name a device: Chrome lists the system default as "default" and, on
 * Windows, the communications device as "communications", each beside the
 * device it currently points at.
 */
const ALIAS_DEVICE_IDS: ReadonlySet<string> = new Set(["default", "communications"]);

/**
 * DeviceList is what the context knows about one kind of device: the devices
 * a page can choose, each once, and the one the system uses by default.
 */
interface DeviceList {
	readonly devices: MediaDeviceInfo[];
	readonly defaultDevice: MediaDeviceInfo | undefined;
}

const EMPTY_LIST: DeviceList = { devices: [], defaultDevice: undefined };

/**
 * listOf builds the DeviceList of kind from the browser's enumeration. Entries
 * without an id are hidden until permission is granted and cannot be chosen;
 * alias entries name a device already listed under its own id. The default is
 * the device the "default" alias points at — the one sharing its group whose
 * label it ends with — or else the first, which the browser lists as default.
 */
function listOf(all: readonly MediaDeviceInfo[], kind: MediaDeviceKind): DeviceList {
	const entries = all.filter((d) => d.kind === kind && d.deviceId !== "");
	const devices = entries.filter((d) => !ALIAS_DEVICE_IDS.has(d.deviceId));
	const alias = entries.find((d) => d.deviceId === "default");
	const pointed = alias === undefined
		? undefined
		: devices.find((d) => d.groupId === alias.groupId && alias.label.endsWith(d.label));
	return { devices, defaultDevice: pointed ?? devices[0] };
}

export class MediaDeviceContext {
	#devices: MediaDeviceInfo[] = [];
	#lists: Map<MediaDeviceKind, DeviceList> = new Map();
	#permissions: Map<"audio" | "video", boolean> = new Map();
	#permissionRequests: Map<"audio" | "video", Promise<boolean>> = new Map();
	#listeners: Set<(devices: MediaDeviceInfo[]) => void> = new Set();
	#onchange: (() => void) | undefined;
	#debounceTimer: number | undefined;
	#updateInProgress: Promise<void> | undefined;
	#updateQueued: Promise<void> | undefined;

	static GET_USER_MEDIA_TIMEOUT = 8000; // 8s

	/**
	 * Every entry the browser enumerated, as it listed them: including alias
	 * entries and, before permission, entries without an id. To offer a
	 * choice, use getDevices or getOutputDevices.
	 */
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

	/**
	 * updateDevices reads the devices again. A caller wants the devices as they
	 * are now, and an enumeration already running may have started before the
	 * change it asks about (permission just granted, a device just plugged in),
	 * so one more runs after it; callers arriving meanwhile share that one.
	 */
	updateDevices(): Promise<void> {
		if (this.#updateQueued) return this.#updateQueued;
		if (this.#updateInProgress) {
			this.#updateQueued = this.#updateInProgress.then(() => {
				this.#updateQueued = undefined;
				return this.updateDevices();
			});
			return this.#updateQueued;
		}
		this.#updateInProgress = this.#enumerate().finally(() => {
			this.#updateInProgress = undefined;
		});
		return this.#updateInProgress;
	}

	async #enumerate(): Promise<void> {
		if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
			this.#devices = [];
			this.#lists = new Map();
			return;
		}

		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			this.#devices = devices;
			this.#lists = new Map(
				(["audioinput", "videoinput", "audiooutput"] as const).map((kind) => [
					kind,
					listOf(devices, kind),
				]),
			);

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
	}

	/**
	 * The input devices of kind a page can choose, each listed once. Empty
	 * until permission is granted, when the browser hides device ids.
	 */
	getDevices(kind: "audio" | "video"): MediaDeviceInfo[] {
		return [...(this.#lists.get(`${kind}input`) ?? EMPTY_LIST).devices];
	}

	/** The input device of kind the system uses by default, once known. */
	getDefaultDevice(kind: "audio" | "video"): MediaDeviceInfo | undefined {
		return (this.#lists.get(`${kind}input`) ?? EMPTY_LIST).defaultDevice;
	}

	/** The audio output devices a page can play through, each listed once. */
	getOutputDevices(): MediaDeviceInfo[] {
		return [...(this.#lists.get("audiooutput") ?? EMPTY_LIST).devices];
	}

	/** The audio output device the system plays through by default. */
	getDefaultOutputDevice(): MediaDeviceInfo | undefined {
		return (this.#lists.get("audiooutput") ?? EMPTY_LIST).defaultDevice;
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

	/**
	 * The current track, while it is live. A track stopped from outside — by
	 * whoever it was handed to — fires no "ended" event, so its state is read
	 * here: an ended track is never handed out again.
	 */
	get stream(): MediaStreamTrack | undefined {
		return this.#stream?.readyState === "ended" ? undefined : this.#stream;
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

import { isAliasDeviceId, stopTracks } from "./internal.ts";

/**
 * MediaDeviceAccess is the part of the browser's `navigator.mediaDevices` the
 * context and the devices made on it use. A page passes nothing and gets the
 * browser's; tests and apps that need control pass their own.
 */
export interface MediaDeviceAccess {
	enumerateDevices(): Promise<MediaDeviceInfo[]>;
	getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
	addEventListener(type: "devicechange", listener: () => void): void;
	removeEventListener(type: "devicechange", listener: () => void): void;
}

/** Options for creating a MediaDeviceContext. */
export interface MediaDeviceContextOptions {
	/** The media devices to use; defaults to the browser's `navigator.mediaDevices`. */
	mediaDevices?: MediaDeviceAccess;
	/**
	 * How long requestPermission waits for a permission prompt to be answered
	 * before it reports the permission as not granted. Defaults to
	 * `MediaDeviceContext.GET_USER_MEDIA_TIMEOUT`.
	 */
	permissionTimeoutMs?: number;
	/** The clock the permission timeout runs on; defaults to the global timers. */
	clock?: Clock;
}

/** Timeout is one running timeout: expired settles when it fires, unless cancelled first. */
export interface Timeout {
	readonly expired: Promise<void>;
	cancel(): void;
}

/** Clock starts timeouts; tests supply one they fire by hand. */
export interface Clock {
	timeout(ms: number): Timeout;
}

/** TimerClock runs timeouts on the global setTimeout. */
class TimerClock implements Clock {
	timeout(ms: number): Timeout {
		const { promise, resolve } = Promise.withResolvers<void>();
		const id = globalThis.setTimeout(resolve, ms);
		return { expired: promise, cancel: () => clearTimeout(id) };
	}
}

/**
 * DeviceListStatus is what the context knows about one kind of device:
 * - `unknown` until the browser has listed devices;
 * - `unlisted` when it listed no entry of the kind at all, which means either
 *   that there is no such device or that the browser does not list the kind
 *   (Safari and Firefox do not list audio outputs) — enumeration cannot tell
 *   the two apart;
 * - `hidden` while it lists the kind's entries without ids, as it does until
 *   permission is granted;
 * - `listed` once it names them: the devices a page can choose, each once,
 *   and the one the system uses by default.
 */
export type DeviceListStatus =
	| { readonly status: "unknown" }
	| { readonly status: "unlisted" }
	| { readonly status: "hidden" }
	| {
		readonly status: "listed";
		readonly devices: readonly MediaDeviceInfo[];
		readonly defaultDevice: MediaDeviceInfo | undefined;
	};

/** The kinds of device the context lists. */
const LISTED_KINDS: readonly MediaDeviceKind[] = ["audioinput", "videoinput", "audiooutput"];

/**
 * DeviceList is what one enumeration says about one kind of device: the
 * devices a page can choose, each once, the one the system uses by default,
 * and whether the browser listed the kind's entries at all, hid them, or
 * named them.
 */
interface DeviceList {
	readonly devices: MediaDeviceInfo[];
	readonly defaultDevice: MediaDeviceInfo | undefined;
	readonly status: "unlisted" | "hidden" | "listed";
}

const EMPTY_LIST: DeviceList = { devices: [], defaultDevice: undefined, status: "unlisted" };

/**
 * listOf builds the DeviceList of kind from the browser's enumeration. Entries
 * without an id are hidden until permission is granted and cannot be chosen;
 * alias entries name a device already listed under its own id. The default is
 * the device the "default" alias points at — the one sharing its group whose
 * label it ends with — or else the first device listed.
 */
function listOf(all: readonly MediaDeviceInfo[], kind: MediaDeviceKind): DeviceList {
	const ofKind = all.filter((d) => d.kind === kind);
	const entries = ofKind.filter((d) => d.deviceId !== "");
	const devices = entries.filter((d) => !isAliasDeviceId(d.deviceId));
	const alias = entries.find((d) => d.deviceId === "default");
	const pointed = alias === undefined
		? undefined
		: devices.find((d) => d.groupId === alias.groupId && alias.label.endsWith(d.label));
	return {
		devices,
		defaultDevice: pointed ?? devices[0],
		status: ofKind.length === 0
			? "unlisted"
			: entries.length < ofKind.length
			? "hidden"
			: "listed",
	};
}

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
	readonly #mediaDevices: MediaDeviceAccess | undefined;
	readonly #permissionTimeoutMs: number | undefined;
	readonly #clock: Clock;
	#devices: MediaDeviceInfo[] = [];
	#lists: Map<MediaDeviceKind, DeviceList> = new Map();
	#permissions: Map<"audio" | "video", boolean> = new Map();
	#permissionRequests: Map<"audio" | "video", Promise<boolean>> = new Map();
	#listeners: Set<(devices: MediaDeviceInfo[]) => void> = new Set();
	#onchange: (() => void) | undefined;
	#debounceTimer: number | undefined;
	#updateInProgress: Promise<void> | undefined;
	#updateQueued: Promise<void> | undefined;

	/** How long requestPermission waits for an answer, unless the context was given its own. */
	static GET_USER_MEDIA_TIMEOUT = 8000; // 8s

	/**
	 * Every entry the browser enumerated, as it listed them: including alias
	 * entries and, before permission, entries without an id. To offer a
	 * choice, use getDevices or getOutputDevices.
	 */
	get devices(): readonly MediaDeviceInfo[] {
		return this.#devices;
	}

	/**
	 * The media devices the context reads and opens: the ones it was given,
	 * or else the browser's. Undefined where the browser offers none (an
	 * insecure page, a server).
	 */
	get mediaDevices(): MediaDeviceAccess | undefined {
		return this.#mediaDevices;
	}

	constructor(options?: MediaDeviceContextOptions) {
		this.#mediaDevices = options?.mediaDevices ?? globalThis.navigator?.mediaDevices;
		this.#permissionTimeoutMs = options?.permissionTimeoutMs;
		this.#clock = options?.clock ?? new TimerClock();

		// Initial device enumeration
		void this.updateDevices();

		// One devicechange listener serves every Device made on the context.
		const onchange = () => {
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

		if (this.#mediaDevices !== undefined) {
			this.#mediaDevices.addEventListener("devicechange", onchange);
			this.#onchange = onchange;
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
		const media = this.#mediaDevices;
		if (media === undefined || typeof media.enumerateDevices !== "function") {
			this.#devices = [];
			this.#lists = new Map();
			return;
		}

		try {
			const devices = await media.enumerateDevices();
			this.#devices = devices;
			this.#lists = new Map(LISTED_KINDS.map((kind) => [kind, listOf(devices, kind)]));

			// Check if we have permission by looking for devices with IDs
			const hasAudioPermission = devices.some((d) =>
				d.kind === "audioinput" && d.deviceId !== ""
			);
			const hasVideoPermission = devices.some((d) =>
				d.kind === "videoinput" && d.deviceId !== ""
			);

			if (hasAudioPermission) this.#permissions.set("audio", true);
			if (hasVideoPermission) this.#permissions.set("video", true);
		} catch (error) {
			console.warn("Failed to update devices:", error);
			return;
		}
		this.#notify(this.#devices);
	}

	/** notify hands devices to every listener; one that throws holds up none of the others. */
	#notify(devices: MediaDeviceInfo[]): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener(devices);
			} catch (error) {
				console.error("A device listener failed:", error);
			}
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
	 * listStatus tells what the context knows of kind's devices: unknown before
	 * the browser has listed any, unlisted when it lists no entry of the kind,
	 * hidden while it lists them without ids, and then listed, with the devices
	 * to choose and the system default.
	 */
	listStatus(kind: MediaDeviceKind): DeviceListStatus {
		const list = this.#lists.get(kind);
		if (list === undefined) return { status: "unknown" };
		switch (list.status) {
			case "unlisted":
			case "hidden":
				return { status: list.status };
			case "listed":
				return {
					status: "listed",
					devices: [...list.devices],
					defaultDevice: list.defaultDevice,
				};
			default: {
				const unknown: never = list.status;
				return unknown;
			}
		}
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

	/**
	 * requestPermission asks the browser for kind, which it needs before it
	 * names devices, and releases the stream it grants at once. It resolves
	 * false when permission is refused, and also when the prompt is left
	 * unanswered for the permission timeout: getUserMedia cannot be aborted,
	 * so a stream granted after that is released as it arrives.
	 */
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

		const media = this.#mediaDevices;
		if (media === undefined || typeof media.getUserMedia !== "function") {
			console.warn("getUserMedia is not available in this environment");
			return false;
		}

		const request = this.#askPermission(kind).finally(() => {
			this.#permissionRequests.delete(kind);
		});
		this.#permissionRequests.set(kind, request);
		return request;
	}

	async #askPermission(kind: "audio" | "video"): Promise<boolean> {
		try {
			const stream = await this.requestStream(
				kind === "audio" ? { audio: true } : { video: true },
			);
			if (stream === undefined) {
				console.warn(`The ${kind} permission prompt was not answered in time`);
				return false;
			}

			this.#permissions.set(kind, true);
			stopTracks(stream);

			// Update device list to get fresh data with labels
			await this.updateDevices();
			return true;
		} catch (error) {
			console.warn(`Failed to request ${kind} permission:`, error);
			return false;
		}
	}

	/**
	 * requestStream asks the media devices for a stream, which may take a
	 * permission prompt. It resolves undefined when no answer comes within the
	 * permission timeout; getUserMedia cannot be aborted, so a stream granted
	 * after that is stopped as it arrives, and the devices are read again. It
	 * rejects with the browser's error when the request is refused, and when
	 * there are no media devices to ask.
	 */
	async requestStream(constraints: MediaStreamConstraints): Promise<MediaStream | undefined> {
		const media = this.#mediaDevices;
		if (media === undefined || typeof media.getUserMedia !== "function") {
			throw new Error("getUserMedia is not available in this environment");
		}

		// An async function: a getUserMedia that throws at once rejects it, like a refusal.
		const asked = media.getUserMedia(constraints);
		const timeout = this.#clock.timeout(
			this.#permissionTimeoutMs ?? MediaDeviceContext.GET_USER_MEDIA_TIMEOUT,
		);
		try {
			const stream = await Promise.race([asked, timeout.expired.then(() => undefined)]);
			if (stream === undefined) {
				asked.then(
					(late) => {
						stopTracks(late);
						// The grant names the devices, as one in time would.
						void this.updateDevices();
					},
					// reason: a request refused after the timeout changes nothing; undefined was returned.
					() => {},
				);
			}
			return stream;
		} finally {
			timeout.cancel();
		}
	}

	subscribe(listener: (devices: MediaDeviceInfo[]) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): void {
		if (this.#onchange !== undefined) {
			this.#mediaDevices?.removeEventListener("devicechange", this.#onchange);
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
	/**
	 * Called with the new default's deviceId when the system default moves to
	 * another device while the device follows the default (no preferred
	 * device). A track already open keeps recording from the device it was
	 * opened on: switchDevice(undefined) and asking for a new track moves it.
	 */
	onDefaultChange?: (deviceId: string) => void;
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
	onDefaultChange?: (deviceId: string) => void;

	#stream: MediaStreamTrack | undefined;
	#unsubscribe: (() => void) | undefined;
	#getDefaultDeviceId: (devices: MediaDeviceInfo[]) => string | undefined;
	/** The system default as last seen, to tell when it moves. */
	#knownDefault: string | undefined;

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
		this.onDefaultChange = options.onDefaultChange;
		this.#getDefaultDeviceId = options.getDefaultDeviceId;

		// Subscribe to device changes
		this.#unsubscribe = this.context.subscribe(() => this.#devicesChanged());

		// Set initial activeDeviceId
		this.#knownDefault = this.defaultDeviceId;
		this.activeDeviceId = this.preferred || this.#knownDefault;
	}

	/**
	 * devicesChanged follows a new enumeration: the active device is the
	 * preferred one or else the system default, and a default that moved
	 * while it is followed is reported.
	 */
	#devicesChanged(): void {
		const previous = this.#knownDefault;
		const next = this.defaultDeviceId;
		this.#knownDefault = next;
		this.activeDeviceId = this.preferred || next;

		if (this.preferred) return;
		// A default first learned, or lost with every device, is no move.
		if (previous === undefined || next === undefined || previous === next) return;
		this.onDefaultChange?.(next);
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
			this.#stream.stop();
			this.#stream = undefined;
		}
	}

	/**
	 * switchDevice records deviceId as the device to use — or, given
	 * undefined, stops preferring one and follows the system default again —
	 * and stops the live track. It opens nothing: the next track asked for is
	 * opened on the device switched to.
	 */
	async switchDevice(deviceId: string | undefined): Promise<void> {
		this.preferred = deviceId;
		this.activeDeviceId = deviceId || this.defaultDeviceId;

		// Stop current stream
		this.stop();
	}

	/**
	 * Update track constraints dynamically.
	 * Applies to active track if streaming.
	 */
	async updateConstraints(constraints: MediaTrackConstraints): Promise<void> {
		this.constraints = constraints;

		const track = this.stream;
		if (track) {
			await track.applyConstraints(constraints);
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

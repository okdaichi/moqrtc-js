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
	/**
	 * The media devices to use; defaults to the browser's
	 * `navigator.mediaDevices`. `null` says there are none, as on an insecure
	 * page.
	 */
	mediaDevices?: MediaDeviceAccess | null;
	/**
	 * How long a request waits for a permission prompt to be answered before
	 * it gives up (see requestStream). Defaults to
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

/**
 * PermissionTimeoutError is a request for media whose permission prompt was
 * not answered within the permission timeout.
 */
export class PermissionTimeoutError extends Error {
	override readonly name = "PermissionTimeoutError";
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`The permission prompt was not answered within ${timeoutMs}ms`);
		this.timeoutMs = timeoutMs;
	}
}

/** The kinds of input a request for media asks for. */
function kindsOf(constraints: MediaStreamConstraints): ("audio" | "video")[] {
	const kinds: ("audio" | "video")[] = [];
	if (constraints.audio) kinds.push("audio");
	if (constraints.video) kinds.push("video");
	return kinds;
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
 *   (not every browser lists audio outputs; Safari, as far as is known, does
 *   not) — enumeration cannot tell the two apart. Where there are no media
 *   devices at all, every kind is unlisted;
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
		this.#mediaDevices = options?.mediaDevices === undefined
			? globalThis.navigator?.mediaDevices
			: options.mediaDevices ?? undefined;
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
			// Nothing can be listed: every kind is known to have no entry.
			this.#devices = [];
			this.#lists = new Map(LISTED_KINDS.map((kind) => [kind, EMPTY_LIST]));
			this.#notify(this.#devices);
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
	 * requestStream asks the media devices for a stream. While permission for
	 * a kind it asks for is not known to be granted, the request may wait on
	 * a permission prompt, so it is bounded by the permission timeout: it then
	 * rejects with a PermissionTimeoutError, and since getUserMedia cannot be
	 * aborted, a stream granted later is stopped as it arrives (and the devices
	 * are read again). With permission granted it waits for the device as long
	 * as it takes, since a device may be slow to start. It rejects with the
	 * browser's error when the request is refused, and with an Error when there
	 * are no media devices to ask.
	 */
	async requestStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
		const media = this.#mediaDevices;
		if (media === undefined || typeof media.getUserMedia !== "function") {
			throw new Error("getUserMedia is not available in this environment");
		}

		// An async function: a getUserMedia that throws at once rejects it, like a refusal.
		const asked = media.getUserMedia(constraints);
		if (kindsOf(constraints).every((kind) => this.hasPermission(kind))) return asked;

		const timeoutMs = this.#permissionTimeoutMs ?? MediaDeviceContext.GET_USER_MEDIA_TIMEOUT;
		const timeout = this.#clock.timeout(timeoutMs);
		try {
			const stream = await Promise.race([asked, timeout.expired.then(() => undefined)]);
			if (stream !== undefined) return stream;
			asked.then(
				(late) => {
					stopTracks(late);
					// The grant names the devices, as one in time would.
					void this.updateDevices();
				},
				// reason: a request refused after the timeout changes nothing; it already failed.
				() => {},
			);
			throw new PermissionTimeoutError(timeoutMs);
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
	/**
	 * The device in use: the one the live track records from while a track is
	 * open, and otherwise the preferred device or, failing that, the system
	 * default.
	 */
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

		this.#knownDefault = this.defaultDeviceId;
		this.#resolveActive();
	}

	/** resolveActive names the device the next track opens on: the preferred one, or the default. */
	#resolveActive(): void {
		this.activeDeviceId = this.preferred || this.defaultDeviceId;
	}

	/**
	 * devicesChanged follows a new enumeration: with no live track, the active
	 * device is the preferred one or else the system default (a live track
	 * keeps naming the device it records from), and a default that moved
	 * while it is followed is reported.
	 */
	#devicesChanged(): void {
		const previous = this.#knownDefault;
		const next = this.defaultDeviceId;
		this.#knownDefault = next;
		if (this.stream === undefined) this.#resolveActive();

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

	/** Set current stream; clearing it makes the active device the one the next track opens on. */
	set stream(track: MediaStreamTrack | undefined) {
		this.#stream = track;
		if (track === undefined) this.#resolveActive();
	}

	/**
	 * Stop current track.
	 */
	stop(): void {
		this.#stream?.stop();
		this.stream = undefined;
	}

	/**
	 * trackConstraints are the constraints to open a track with: the
	 * preferred device by its id, and the configured constraints. A device
	 * that follows the default names none, so the browser opens the default
	 * as it is now rather than one an enumeration last saw.
	 */
	trackConstraints(): MediaTrackConstraints {
		return {
			...(this.preferred ? { deviceId: { exact: this.preferred } } : {}),
			...(this.constraints ?? {}),
		};
	}

	/**
	 * switchDevice records deviceId as the device to use — or, given
	 * undefined, stops preferring one and follows the system default again —
	 * and stops the live track. It opens nothing: the next track asked for is
	 * opened on the device switched to.
	 */
	async switchDevice(deviceId: string | undefined): Promise<void> {
		this.preferred = deviceId;
		this.stop();
		this.#resolveActive();
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

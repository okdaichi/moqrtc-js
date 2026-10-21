import type { Clock, Timeout } from "./device.ts";

/**
 * FakeMediaStreamTrack is a track a fake device handed out. Like a browser's,
 * stopping it fires no event; end() ends it as a device going away does,
 * firing "ended".
 */
export class FakeMediaStreamTrack extends EventTarget implements MediaStreamTrack {
	id: string = crypto.randomUUID();
	kind: string;
	label: string;
	muted = false;
	enabled = true;
	contentHint: string = "";
	readyState: MediaStreamTrackState = "live";
	// deno-lint-ignore no-explicit-any
	onended: ((this: MediaStreamTrack, ev: Event) => any) | null = null;
	// deno-lint-ignore no-explicit-any
	onmute: ((this: MediaStreamTrack, ev: Event) => any) | null = null;
	// deno-lint-ignore no-explicit-any
	onunmute: ((this: MediaStreamTrack, ev: Event) => any) | null = null;

	#constraints: MediaTrackConstraints = {};
	readonly #stopped = Promise.withResolvers<void>();
	#settings: MediaTrackSettings;

	constructor(
		kind: string,
		label: string,
		deviceId: string,
		constraints?: MediaTrackConstraints,
	) {
		super();
		this.#constraints = constraints || {};
		this.kind = kind;
		this.label = label;
		this.#settings = { deviceId };
	}

	clone(): MediaStreamTrack {
		throw new Error("Not implemented");
	}
	stop(): void {
		this.readyState = "ended";
		this.#stopped.resolve();
	}

	/** end ends the track as unplugging its device does: it fires "ended". */
	end(): void {
		this.readyState = "ended";
		this.dispatchEvent(new Event("ended"));
	}

	/** Settles once the track is stopped. */
	get stopped(): Promise<void> {
		return this.#stopped.promise;
	}
	getCapabilities(): MediaTrackCapabilities {
		return {};
	}
	getConstraints(): MediaTrackConstraints {
		return this.#constraints;
	}
	getSettings(): MediaTrackSettings {
		return this.#settings;
	}
	async applyConstraints(constraints?: MediaTrackConstraints): Promise<void> {
		this.#constraints = constraints || {};
	}
}

export class FakeMediaStream implements MediaStream {
	id: string = crypto.randomUUID();
	active = true;
	onaddtrack = null;
	onremovetrack = null;
	#tracks: MediaStreamTrack[] = [];

	constructor(tracks: MediaStreamTrack[] = []) {
		this.#tracks = tracks;
	}

	getTracks(): MediaStreamTrack[] {
		return this.#tracks;
	}
	getAudioTracks(): MediaStreamTrack[] {
		return this.#tracks.filter((t) => t.kind === "audio");
	}
	getVideoTracks(): MediaStreamTrack[] {
		return this.#tracks.filter((t) => t.kind === "video");
	}
	getTrackById(id: string): MediaStreamTrack | null {
		return this.#tracks.find((t) => t.id === id) || null;
	}
	addTrack(track: MediaStreamTrack): void {
		this.#tracks.push(track);
	}
	removeTrack(track: MediaStreamTrack): void {
		this.#tracks = this.#tracks.filter((t) => t !== track);
	}
	clone(): MediaStream {
		return new FakeMediaStream([...this.#tracks]);
	}
	addEventListener() {}
	removeEventListener() {}
	dispatchEvent(): boolean {
		return true;
	}
}

/** A device the fake lists; groupId defaults to one group shared by all. */
export interface FakeDeviceInit {
	kind: MediaDeviceKind;
	label: string;
	deviceId: string;
	groupId?: string;
}

/** exactDeviceIdOf is the deviceId a constraint requires exactly, if any. */
function exactDeviceIdOf(constraint: ConstrainDOMString | undefined): string | undefined {
	if (typeof constraint !== "object" || Array.isArray(constraint)) return undefined;
	const exact = constraint.exact;
	return typeof exact === "string" ? exact : undefined;
}

export class FakeMediaDevices implements MediaDevices {
	// deno-lint-ignore no-explicit-any
	ondevicechange: ((this: MediaDevices, ev: Event) => any) | null = null;
	devices: MediaDeviceInfo[] = [];
	permissions: { audio: boolean; video: boolean } = { audio: false, video: false };

	/**
	 * When set, getUserMedia waits for it before answering, as a permission
	 * prompt does; a promise never settled is a prompt never answered.
	 */
	answer: Promise<void> | undefined;
	/** When set, getUserMedia rejects with it, as the browser would. */
	failure: Error | undefined;
	/** When set, getUserMedia throws it synchronously instead of rejecting. */
	syncFailure: Error | undefined;
	/** Every track getUserMedia handed out, in order. */
	granted: FakeMediaStreamTrack[] = [];
	readonly #firstGrant = Promise.withResolvers<FakeMediaStreamTrack>();

	/** Settles with the first track getUserMedia hands out. */
	get firstGrant(): Promise<FakeMediaStreamTrack> {
		return this.#firstGrant.promise;
	}

	constructor(initialDevices: FakeDeviceInit[] = []) {
		this.setDevices(initialDevices);
	}

	/** setDevices replaces the devices listed, as plugging devices in and out does. */
	setDevices(devices: FakeDeviceInit[]): void {
		this.devices = devices.map((d) => ({
			...d,
			groupId: d.groupId ?? "group1",
			toJSON: () => d,
		}));
	}

	async enumerateDevices(): Promise<MediaDeviceInfo[]> {
		// If permission is not granted, labels and deviceIds should be empty per spec
		return this.devices.map((d) => {
			const hasPerm = d.kind.includes("audio")
				? this.permissions.audio
				: this.permissions.video;
			return hasPerm ? d : { ...d, deviceId: "", label: "" };
		});
	}

	getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
		if (this.syncFailure !== undefined) throw this.syncFailure;
		return this.#grant(constraints);
	}

	async #grant(constraints?: MediaStreamConstraints): Promise<MediaStream> {
		await this.answer;
		if (this.failure !== undefined) throw this.failure;
		const tracks: FakeMediaStreamTrack[] = [];
		if (constraints?.audio) {
			this.permissions.audio = true;
			tracks.push(this.#trackOf("audio", constraints.audio));
		}
		if (constraints?.video) {
			this.permissions.video = true;
			tracks.push(this.#trackOf("video", constraints.video));
		}
		this.granted.push(...tracks);
		const first = tracks[0];
		if (first !== undefined) this.#firstGrant.resolve(first);
		return new FakeMediaStream(tracks);
	}

	/**
	 * trackOf opens a device of kind as a browser does: the one an exact
	 * deviceId names, or else the system default (the "default" alias, when
	 * listed) or the first listed.
	 */
	#trackOf(
		kind: "audio" | "video",
		constraint: boolean | MediaTrackConstraints,
	): FakeMediaStreamTrack {
		const options = typeof constraint === "object" ? constraint : undefined;
		const ofKind = this.devices.filter((d) => d.kind === `${kind}input`);
		const exact = exactDeviceIdOf(options?.deviceId);
		const device = exact === undefined
			? ofKind.find((d) => d.deviceId === "default") ?? ofKind[0]
			: ofKind.find((d) => d.deviceId === exact);
		if (device === undefined) {
			throw exact === undefined
				? new DOMException("Requested device not found", "NotFoundError")
				: new DOMException("No device matches the constraints", "OverconstrainedError");
		}
		return new FakeMediaStreamTrack(kind, device.label, device.deviceId, options);
	}

	getSupportedConstraints(): MediaTrackSupportedConstraints {
		return {};
	}
	getDisplayMedia(options?: DisplayMediaStreamOptions): Promise<MediaStream> {
		const tracks = [];
		tracks.push(
			new FakeMediaStreamTrack(
				"video",
				"Screen",
				"screen-1",
				options?.video
					? (typeof options.video === "object" ? options.video : {})
					: undefined,
			),
		);
		if (options?.audio) {
			tracks.push(
				new FakeMediaStreamTrack(
					"audio",
					"System Audio",
					"sys-audio-1",
					typeof options.audio === "object" ? options.audio : undefined,
				),
			);
		}
		return Promise.resolve(new FakeMediaStream(tracks));
	}

	triggerDeviceChange() {
		if (this.ondevicechange) {
			this.ondevicechange(new Event("devicechange"));
		}
	}

	addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
		if (type === "devicechange") {
			this.ondevicechange = listener as (this: MediaDevices, ev: Event) => void;
		}
	}
	removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
		if (type === "devicechange" && this.ondevicechange === listener) this.ondevicechange = null;
	}
	dispatchEvent(): boolean {
		return true;
	}
}

/**
 * Replace global navigator.mediaDevices with FakeMediaDevices during the test block.
 */
export function setupFakeMediaDevices(devices: FakeDeviceInit[]) {
	const fake = new FakeMediaDevices(devices);
	const originalNavigator = globalThis.navigator;

	Object.defineProperty(globalThis, "navigator", {
		writable: true,
		configurable: true,
		value: { mediaDevices: fake },
	});

	function restore() {
		Object.defineProperty(globalThis, "navigator", {
			writable: true,
			configurable: true,
			value: originalNavigator,
		});
	}

	return {
		fake,
		restore,
		[Symbol.dispose]() {
			restore();
		},
	};
}

/**
 * FakeClock starts timeouts that fire only when the test says so, so a test
 * decides when a permission prompt has waited too long.
 */
export class FakeClock implements Clock {
	/** The durations of the timeouts started, in order. */
	started: number[] = [];
	#pending: Set<() => void> = new Set();

	timeout(ms: number): Timeout {
		this.started.push(ms);
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#pending.add(resolve);
		return { expired: promise, cancel: () => this.#pending.delete(resolve) };
	}

	/** fire expires every timeout running. */
	fire(): void {
		for (const resolve of this.#pending) resolve();
		this.#pending.clear();
	}
}

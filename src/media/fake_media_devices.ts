export class FakeMediaStreamTrack implements MediaStreamTrack {
	id: string = crypto.randomUUID();
	kind: string;
	label: string;
	muted = false;
	enabled = true;
	contentHint: string = "";
	readyState: MediaStreamTrackState = "live";
	onended: ((this: MediaStreamTrack, ev: Event) => any) | null = null;
	onmute: ((this: MediaStreamTrack, ev: Event) => any) | null = null;
	onunmute: ((this: MediaStreamTrack, ev: Event) => any) | null = null;

	#constraints: MediaTrackConstraints = {};
	#settings: MediaTrackSettings;

	constructor(
		kind: string,
		label: string,
		deviceId: string,
		constraints?: MediaTrackConstraints,
	) {
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
	addEventListener() {}
	removeEventListener() {}
	dispatchEvent(): boolean {
		return true;
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

export class FakeMediaDevices implements MediaDevices {
	ondevicechange: ((this: MediaDevices, ev: Event) => any) | null = null;
	devices: MediaDeviceInfo[] = [];
	permissions: { audio: boolean; video: boolean } = { audio: false, video: false };

	constructor(initialDevices: { kind: MediaDeviceKind; label: string; deviceId: string }[] = []) {
		this.devices = initialDevices.map((d) => ({
			...d,
			groupId: "group1",
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

	async getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
		const tracks: MediaStreamTrack[] = [];
		if (constraints?.audio) {
			this.permissions.audio = true;
			const device = this.devices.find((d) => d.kind === "audioinput") || this.devices[0];
			if (device) {
				tracks.push(
					new FakeMediaStreamTrack(
						"audio",
						device.label,
						device.deviceId,
						typeof constraints?.audio === "object" ? constraints.audio : undefined,
					),
				);
			} else throw new Error("NotFoundError");
		}
		if (constraints?.video) {
			this.permissions.video = true;
			const device = this.devices.find((d) => d.kind === "videoinput") || this.devices[0];
			if (device) {
				tracks.push(
					new FakeMediaStreamTrack(
						"video",
						device.label,
						device.deviceId,
						typeof constraints?.video === "object" ? constraints.video : undefined,
					),
				);
			} else throw new Error("NotFoundError");
		}
		return new FakeMediaStream(tracks);
	}

	getSupportedConstraints(): MediaTrackSupportedConstraints {
		return {};
	}
getDisplayMedia(options?: DisplayMediaStreamOptions): Promise<MediaStream> {
                const tracks = [];
                tracks.push(new FakeMediaStreamTrack('video', 'Screen', 'screen-1', options?.video ? (typeof options.video === "object" ? options.video : {}) : undefined));
                if (options?.audio) {
                        tracks.push(new FakeMediaStreamTrack('audio', 'System Audio', 'sys-audio-1', typeof options.audio === "object" ? options.audio : undefined));
                }
                return Promise.resolve(new FakeMediaStream(tracks));
	}

	triggerDeviceChange() {
		if (this.ondevicechange) {
			this.ondevicechange(new Event("devicechange"));
		}
	}

	addEventListener(type: string, listener: any) {
		if (type === "devicechange") this.ondevicechange = listener;
	}
	removeEventListener(type: string, listener: any) {
		if (type === "devicechange" && this.ondevicechange === listener) this.ondevicechange = null;
	}
	dispatchEvent(): boolean {
		return true;
	}
}

/**
 * Replace global navigator.mediaDevices with FakeMediaDevices during the test block.
 */
export function setupFakeMediaDevices(
	devices: { kind: MediaDeviceKind; label: string; deviceId: string }[],
) {
	const fake = new FakeMediaDevices(devices);
	const originalNavigator = (globalThis as any).navigator;

	Object.defineProperty(globalThis, "navigator", {
		writable: true,
		configurable: true,
		value: { mediaDevices: fake },
	});

	// Mock setTimeout/clearTimeout for instant debounce resolution if needed
	const ogSetTimeout = globalThis.setTimeout;
	const ogClearTimeout = globalThis.clearTimeout;

	globalThis.setTimeout = ((fn: Function) => {
		fn();
		return 1 as any;
	}) as any;

	globalThis.clearTimeout = (() => {}) as any;

	return {
		fake,
		[Symbol.dispose]() {
			Object.defineProperty(globalThis, "navigator", {
				writable: true,
				configurable: true,
				value: originalNavigator,
			});
			globalThis.setTimeout = ogSetTimeout;
			globalThis.clearTimeout = ogClearTimeout;
		},
	};
}

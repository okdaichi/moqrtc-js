// filepath: src/media/mock_device_test.ts
// Mock Device for testing

export class MockDevice {
	kind: "audio" | "video" = "video";
	preferred: string | undefined;
	available: MediaDeviceInfo[] | undefined;
	default: string | undefined;
	activeDeviceId: string | undefined;
	hasPermission: boolean = false;

	getTrackCallCount = 0;
	getTrackArgs: (MediaTrackConstraints | undefined)[] = [];
	getTrackResult: MediaStreamTrack | undefined | Error;
	getTrackError: Error | undefined;

	closeCallCount = 0;

	async getTrack(options?: MediaTrackConstraints): Promise<MediaStreamTrack | undefined> {
		this.getTrackCallCount++;
		this.getTrackArgs.push(options);
		if (this.getTrackError) {
			throw this.getTrackError;
		}
		if (this.getTrackResult instanceof Error) {
			throw this.getTrackResult;
		}
		return this.getTrackResult;
	}

	close(): void {
		this.closeCallCount++;
	}

	// Stub other properties/methods not used in tests
	updated(): Promise<[undefined, false] | [void, true]> {
		throw new Error("Not implemented");
	}
}

// Mock classes for MediaDevices API testing
export class MockMediaDeviceInfo {
	deviceId: string;
	kind: MediaDeviceKind;
	label: string;
	groupId: string;

	constructor(deviceId: string, kind: MediaDeviceKind, label: string, groupId: string) {
		this.deviceId = deviceId;
		this.kind = kind;
		this.label = label;
		this.groupId = groupId;
	}

	toJSON() {
		return {
			deviceId: this.deviceId,
			kind: this.kind,
			label: this.label,
			groupId: this.groupId,
		};
	}
}

export class MockMediaDevices {
	enumerateDevicesCallCount = 0;
	enumerateDevicesResult: MediaDeviceInfo[] = [];
	getUserMediaCallCount = 0;
	getUserMediaArgs: MediaStreamConstraints[] = [];
	getUserMediaResult: MediaStream | Error | undefined;
	addEventListenerCallCount = 0;
	addEventListenerArgs: [string, EventListener][] = [];
	removeEventListenerCallCount = 0;
	removeEventListenerArgs: [string, EventListener][] = [];
	ondevicechange: ((this: MediaDevices, ev: Event) => any) | null = null;

	async enumerateDevices(): Promise<MediaDeviceInfo[]> {
		this.enumerateDevicesCallCount++;
		return this.enumerateDevicesResult;
	}

	async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
		this.getUserMediaCallCount++;
		this.getUserMediaArgs.push(constraints);
		if (this.getUserMediaResult instanceof Error) {
			throw this.getUserMediaResult;
		}
		if (!this.getUserMediaResult) {
			throw new Error("getUserMedia not mocked");
		}
		return this.getUserMediaResult;
	}

	addEventListener(type: string, listener: EventListener): void {
		this.addEventListenerCallCount++;
		this.addEventListenerArgs.push([type, listener]);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.removeEventListenerCallCount++;
		this.removeEventListenerArgs.push([type, listener]);
	}
}

// Mock MediaStream for testing
export class MockMediaStream {
	getTracks(): MediaStreamTrack[] {
		return [];
	}
}

// Setup function to create test environment
export function setupTestEnvironment(): {
	mockMediaDevices: MockMediaDevices;
	originalNavigator: any;
	originalSetTimeout: any;
	originalClearTimeout: any;
	activeTimers: number[];
} {
	const mockMediaDevices = new MockMediaDevices();
	const originalNavigator = (globalThis as any).navigator;
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const activeTimers: number[] = [];

	// Mock setTimeout to track timers
	const mockSetTimeout = (
		callback: (...args: any[]) => void,
		delay?: number,
		...args: any[]
	): number => {
		const timerId = originalSetTimeout(callback, delay, ...args);
		activeTimers.push(timerId);
		return timerId;
	};

	// Mock clearTimeout to remove from tracking
	const mockClearTimeout = (timerId: number): void => {
		const index = activeTimers.indexOf(timerId);
		if (index !== -1) {
			activeTimers.splice(index, 1);
		}
		originalClearTimeout(timerId);
	};

	// Mock global navigator
	Object.defineProperty(globalThis, "navigator", {
		writable: true,
		configurable: true,
		value: { mediaDevices: mockMediaDevices },
	});

	// Mock global timers
	globalThis.setTimeout = mockSetTimeout as any;
	globalThis.clearTimeout = mockClearTimeout as any;

	return {
		mockMediaDevices,
		originalNavigator,
		originalSetTimeout,
		originalClearTimeout,
		activeTimers,
	};
}

// Cleanup function
export function cleanupTestEnvironment(
	originalNavigator: any,
	originalSetTimeout: any,
	originalClearTimeout: any,
	activeTimers: number[],
): void {
	// Clear all active timers
	for (const timerId of activeTimers) {
		try {
			originalClearTimeout(timerId);
		} catch {
			// Ignore errors when clearing timers
		}
	}
	activeTimers.length = 0;

	// Restore original navigator
	Object.defineProperty(globalThis, "navigator", {
		writable: true,
		configurable: true,
		value: originalNavigator,
	});

	// Restore original timers
	globalThis.setTimeout = originalSetTimeout;
	globalThis.clearTimeout = originalClearTimeout;
}

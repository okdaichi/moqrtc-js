import { assert, assertEquals, assertExists } from "@std/assert";
import { Channel } from "golikejs";
import { Cond } from "golikejs/sync";
import { Device } from "./device.ts";
import {
	cleanupTestEnvironment,
	MockMediaDeviceInfo,
	setupTestEnvironment,
} from "./mock_device_test.ts";

// Helper to create mock functions with call tracking
function createMockFunction<T = any>(): { (): T; calls: any[][]; returns: T } {
	const calls: any[][] = [];
	const mockFn = Object.assign(
		(...args: any[]) => {
			calls.push(args);
			return (mockFn as any).returns;
		},
		{ calls, returns: undefined as T },
	);
	return mockFn;
}

Deno.test("Device", async (t) => {
	let mockCond: Cond;
	let mockChannel: Channel<void>;

	await t.step("setup", async () => {
		// Import golikejs conditionally to avoid issues
		try {
			const golikejsSync = await import("golikejs/sync");
			mockCond = new (golikejsSync as any).Cond(new (golikejsSync as any).Mutex());
			mockChannel = new (golikejsSync as any).Channel();
		} catch {
			// Fallback if golikejs not available
			mockCond = {} as any;
			mockChannel = {} as any;
		}
	});

	await t.step("Constructor", async (t) => {
		await t.step("creates audio device with default props", () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const device = new Device("audio");

				assertEquals(device.kind, "audio");
				assertEquals(device.preferred, undefined);
				assertEquals(device.available, undefined);
				assertEquals(device.hasPermission, false);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("creates video device with preferred device", () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const device = new Device("video", { preferred: "test-device-id" });

				assertEquals(device.kind, "video");
				assertEquals(device.preferred, "test-device-id");
				assertEquals(device.available, undefined);
				assertEquals(device.hasPermission, false);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("sets up devicechange event listener", () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				new Device("audio");

				assertEquals(mockMediaDevices.addEventListenerCallCount, 1);
				assertEquals(mockMediaDevices.addEventListenerArgs[0]?.[0], "devicechange");
				assertExists(mockMediaDevices.addEventListenerArgs[0]?.[1]);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("falls back to ondevicechange if addEventListener not available", () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			let addEventListenerCallCount = 0;
			mockMediaDevices.addEventListener = (type: string, listener: EventListener) => {
				addEventListenerCallCount++;
				throw new Error("Not supported");
			};
			try {
				new Device("audio");

				// Should have tried addEventListener and failed
				assertEquals(addEventListenerCallCount, 1);
				// Should fall back to direct assignment
				assertExists((mockMediaDevices as any).ondevicechange);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("handles missing navigator.mediaDevices gracefully", () => {
			const originalNavigator = (globalThis as any).navigator;
			try {
				// Temporarily remove mediaDevices
				Object.defineProperty(globalThis, "navigator", {
					writable: true,
					configurable: true,
					value: {},
				});

				// Should not throw
				const device = new Device("audio");
				assertExists(device);
			} finally {
				Object.defineProperty(globalThis, "navigator", {
					writable: true,
					configurable: true,
					value: originalNavigator,
				});
			}
		});
	});

	await t.step("updateDevices", async (t) => {
		const mockAudioDevices = [
			new MockMediaDeviceInfo("audio1", "audioinput", "Microphone 1", "group1"),
			new MockMediaDeviceInfo("audio2", "audioinput", "Microphone 2", "group2"),
		];

		const mockVideoDevices = [
			new MockMediaDeviceInfo("video1", "videoinput", "Camera 1", "group1"),
			new MockMediaDeviceInfo("video2", "videoinput", "Camera 2", "group2"),
		];

		await t.step("updates available devices successfully", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			mockMediaDevices.enumerateDevicesResult = [...mockAudioDevices, ...mockVideoDevices];
			try {
				const device = new Device("audio");
				await device.updateDevices();

				assertEquals(device.available, mockAudioDevices);
				assertEquals(device.hasPermission, true);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("detects no permission when deviceIds are empty", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			const devicesWithoutIds = mockAudioDevices.map((d) =>
				new MockMediaDeviceInfo("", d.kind, d.label, d.groupId)
			);
			mockMediaDevices.enumerateDevicesResult = devicesWithoutIds;
			try {
				const device = new Device("audio");
				await device.updateDevices();

				assertEquals(device.hasPermission, false);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("finds default audio device using heuristics", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			const devicesWithDefault = [
				new MockMediaDeviceInfo("audio1", "audioinput", "Microphone 1", "group1"),
				new MockMediaDeviceInfo(
					"default",
					"audioinput",
					"Default - Microphone 2",
					"group2",
				),
			];
			mockMediaDevices.enumerateDevicesResult = devicesWithDefault;
			try {
				const device = new Device("audio");
				await device.updateDevices();

				assertEquals(device.default, "default");
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("finds default video device using heuristics", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			const devicesWithDefault = [
				new MockMediaDeviceInfo("video1", "videoinput", "Camera 1", "group1"),
				new MockMediaDeviceInfo("video2", "videoinput", "Front Camera", "group2"),
			];
			mockMediaDevices.enumerateDevicesResult = devicesWithDefault;
			try {
				const device = new Device("video");
				await device.updateDevices();

				assertEquals(device.default, "video2");
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("handles enumerateDevices error gracefully", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			mockMediaDevices.enumerateDevices = () =>
				Promise.reject(new Error("Enumeration failed"));
			try {
				const device = new Device("audio");
				await device.updateDevices();

				assertEquals(device.available, undefined);
				assertEquals(device.hasPermission, false);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("handles missing navigator.mediaDevices", async () => {
			const originalNavigator = (globalThis as any).navigator;
			try {
				// Temporarily remove mediaDevices
				Object.defineProperty(globalThis, "navigator", {
					writable: true,
					configurable: true,
					value: {},
				});

				const device = new Device("audio");
				await device.updateDevices();

				assertEquals(device.available, undefined);
				assertEquals(device.hasPermission, false);
			} finally {
				Object.defineProperty(globalThis, "navigator", {
					writable: true,
					configurable: true,
					value: originalNavigator,
				});
			}
		});
	});

	await t.step("requestPermission", async (t) => {
		await t.step("skips request if already has permission", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				// First request to grant permission
				mockMediaDevices.getUserMedia = async () => {
					mockMediaDevices.getUserMediaCallCount++;
					const mockTrack = {
						kind: "audio",
						stop: () => {},
						getSettings: () => ({ deviceId: "mock-device-id" }),
					};
					return {
						getTracks: () => [mockTrack],
						getAudioTracks: () => [mockTrack],
						getVideoTracks: () => [],
					} as any;
				};

				const device = new Device("audio");
				await device.requestPermission(); // First call grants permission

				// Reset call count
				const callCountAfterFirst = mockMediaDevices.getUserMediaCallCount;

				// Second call should skip getUserMedia
				const result = await device.requestPermission();

				assertEquals(result, true);
				assertEquals(mockMediaDevices.getUserMediaCallCount, callCountAfterFirst); // No additional calls
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("requests audio permission successfully", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const mockTrack = {
					stop: createMockFunction(),
					getSettings: createMockFunction(),
				};
				mockTrack.getSettings.returns = {
					deviceId: "audio-device-id",
				};
				const mockStream = {
					getTracks: createMockFunction(),
					getAudioTracks: createMockFunction(),
					getVideoTracks: createMockFunction(),
					active: true,
					id: "stream1",
					addTrack: createMockFunction(),
					removeTrack: createMockFunction(),
					clone: createMockFunction(),
					dispatchEvent: createMockFunction(),
					onaddtrack: null,
					onremovetrack: null,
					onactive: null,
					oninactive: null,
				} as any;
				mockStream.getTracks.returns = [mockTrack];
				mockStream.getAudioTracks.returns = [mockTrack];
				mockStream.getVideoTracks.returns = [];
				mockMediaDevices.getUserMediaResult = mockStream as MediaStream;

				const device = new Device("audio");
				const result = await device.requestPermission();

				assertEquals(result, true);
				assertEquals(mockMediaDevices.getUserMediaArgs.length, 1);
				assertEquals(mockMediaDevices.getUserMediaArgs[0], { audio: true });
				assertEquals(mockTrack.stop.calls.length, 1);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("requests video permission successfully", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const mockTrack = {
					stop: createMockFunction(),
					getSettings: createMockFunction(),
				};
				mockTrack.getSettings.returns = {
					deviceId: "video-device-id",
				};
				const mockStream = {
					getTracks: createMockFunction(),
				} as any;
				mockStream.getTracks.returns = [mockTrack];
				mockMediaDevices.getUserMediaResult = mockStream as MediaStream;

				const device = new Device("video");
				const result = await device.requestPermission();

				assertEquals(result, true);
				assertEquals(mockMediaDevices.getUserMediaArgs.length, 1);
				assertEquals(mockMediaDevices.getUserMediaArgs[0], { video: true });
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("handles getUserMedia error gracefully", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				mockMediaDevices.getUserMediaResult = new Error("Permission denied");

				const device = new Device("audio");
				const result = await device.requestPermission();

				assertEquals(result, false);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("handles missing getUserMedia", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				// Temporarily remove getUserMedia
				const originalGetUserMedia = mockMediaDevices.getUserMedia;
				delete (mockMediaDevices as any).getUserMedia;

				const device = new Device("audio");
				const result = await device.requestPermission();

				assertEquals(result, false);

				// Restore
				mockMediaDevices.getUserMedia = originalGetUserMedia;
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});
	});

	await t.step("getTrack", async (t) => {
		await t.step("gets audio track with preferred device", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const mockTrack = {
					kind: "audio" as const,
					id: "track1",
					getSettings: createMockFunction(),
					stop: createMockFunction(),
				};
				mockTrack.getSettings.returns = {
					deviceId: "preferred-device",
				};

				// Mock for requestPermission call
				const permissionStream = {
					getTracks: createMockFunction(),
				} as any;
				permissionStream.getTracks.returns = [{
					stop: createMockFunction(),
					getSettings: createMockFunction(),
				}];
				permissionStream.getTracks.returns[0].getSettings.returns = {
					deviceId: "preferred-device",
				};

				// Mock for getTrack call
				const trackStream = {
					getTracks: createMockFunction(),
					getAudioTracks: createMockFunction(),
					getVideoTracks: createMockFunction(),
				} as any;
				trackStream.getTracks.returns = [mockTrack];
				trackStream.getAudioTracks.returns = [mockTrack];
				trackStream.getVideoTracks.returns = [];

				// Set up mock to return different streams for different calls
				let callCount = 0;
				const originalGetUserMedia = mockMediaDevices.getUserMedia;
				mockMediaDevices.getUserMedia = async (constraints) => {
					callCount++;
					mockMediaDevices.getUserMediaCallCount++;
					mockMediaDevices.getUserMediaArgs.push(constraints);
					if (callCount === 1) {
						return permissionStream as MediaStream;
					} else {
						return trackStream as MediaStream;
					}
				};

				const device = new Device("audio", { preferred: "preferred-device" });
				const track = await device.getTrack();

				assertEquals(track?.kind, "audio");
				assertEquals(track?.id, "track1");
				assertEquals(mockMediaDevices.getUserMediaArgs.length, 2);
				assertEquals(mockMediaDevices.getUserMediaArgs[1], {
					audio: { deviceId: { exact: "preferred-device" } },
				});
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("gets video track with constraints", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const mockTrack = {
					kind: "video" as const,
					id: "track1",
					getSettings: createMockFunction(),
					stop: createMockFunction(),
				};
				mockTrack.getSettings.returns = {
					deviceId: "video-device",
				};

				// Mock for requestPermission call
				const permissionStream = {
					getTracks: createMockFunction(),
				} as any;
				permissionStream.getTracks.returns = [{
					stop: createMockFunction(),
					getSettings: createMockFunction(),
				}];
				permissionStream.getTracks.returns[0].getSettings.returns = {
					deviceId: "video-device",
				};

				// Mock for getTrack call
				const trackStream = {
					getTracks: createMockFunction(),
					getAudioTracks: createMockFunction(),
					getVideoTracks: createMockFunction(),
				} as any;
				trackStream.getTracks.returns = [mockTrack];
				trackStream.getAudioTracks.returns = [];
				trackStream.getVideoTracks.returns = [mockTrack];

				// Set up mock to return different streams for different calls
				let callCount = 0;
				const originalGetUserMedia = mockMediaDevices.getUserMedia;
				mockMediaDevices.getUserMedia = async (constraints) => {
					callCount++;
					mockMediaDevices.getUserMediaCallCount++;
					mockMediaDevices.getUserMediaArgs.push(constraints);
					if (callCount === 1) {
						return permissionStream as MediaStream;
					} else {
						return trackStream as MediaStream;
					}
				};

				const device = new Device("video");
				const track = await device.getTrack({ width: 1920, height: 1080 });

				assertEquals(track?.kind, "video");
				assertEquals(track?.id, "track1");
				assertEquals(mockMediaDevices.getUserMediaArgs.length, 2);
				assertEquals(mockMediaDevices.getUserMediaArgs[1], {
					video: { deviceId: { exact: "video-device" }, width: 1920, height: 1080 },
				});
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("returns undefined when no tracks available", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const mockStream = {
					getTracks: createMockFunction(),
				} as any;
				mockStream.getTracks.returns = [];
				mockMediaDevices.getUserMediaResult = mockStream as MediaStream;

				const device = new Device("audio");
				const track = await device.getTrack();

				assertEquals(track, undefined);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("handles getUserMedia error gracefully", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				mockMediaDevices.getUserMediaResult = new Error("Access denied");

				const device = new Device("audio");
				const track = await device.getTrack();

				assertEquals(track, undefined);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("handles missing getUserMedia", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				// Temporarily remove getUserMedia
				const originalGetUserMedia = mockMediaDevices.getUserMedia;
				delete (mockMediaDevices as any).getUserMedia;

				const device = new Device("audio");
				const track = await device.getTrack();

				assertEquals(track, undefined);

				// Restore
				mockMediaDevices.getUserMedia = originalGetUserMedia;
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});
	});

	await t.step("close", async (t) => {
		await t.step("removes event listener and cleans up", () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const device = new Device("audio");
				device.close();

				assertEquals(mockMediaDevices.removeEventListenerCallCount, 1);
				assertEquals(mockMediaDevices.removeEventListenerArgs[0]?.[0], "devicechange");
				assertEquals(typeof mockMediaDevices.removeEventListenerArgs[0]?.[1], "function");
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("clears ondevicechange if removeEventListener not available", () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				// Set up scenario where addEventListener fails so ondevicechange is used
				const originalAddEventListener = mockMediaDevices.addEventListener;
				mockMediaDevices.addEventListener = () => {
					throw new Error("Not supported");
				};
				// Set up scenario where removeEventListener is not available
				(mockMediaDevices as any).removeEventListener = undefined;

				const device = new Device("audio");
				// Verify ondevicechange was set during construction
				assertExists(mockMediaDevices.ondevicechange);
				device.close();

				assertEquals(mockMediaDevices.ondevicechange, null);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("handles cleanup errors gracefully", () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				// Mock removeEventListener to throw
				const originalRemoveEventListener = mockMediaDevices.removeEventListener;
				mockMediaDevices.removeEventListener = () => {
					throw new Error("Cleanup error");
				};

				const device = new Device("audio");
				// Should not throw
				device.close();

				// Restore
				mockMediaDevices.removeEventListener = originalRemoveEventListener;
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});
	});

	await t.step("updated", async (t) => {
		await t.step("returns a promise", () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const device = new Device("audio");
				const result = device.updated();

				// Should return a promise
				assert(result instanceof Promise);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});
	});

	await t.step("Device timeout and error handling", async (t) => {
		await t.step("handles GET_USER_MEDIA_TIMEOUT constant", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();

			try {
				const device = new Device("audio");

				// Mock a slow getUserMedia that exceeds timeout
				mockMediaDevices.getUserMedia = () =>
					new Promise((_resolve, reject) => {
						setTimeout(() => reject(new Error("Timeout")), 10);
					});

				const track = await device.getTrack();
				assertEquals(track, undefined);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("handles debounce timer in devicechange", () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				// Mock globalThis.setTimeout to verify debounce behavior
				const mockSetTimeoutCalls: any[] = [];
				const mockSetTimeout = (fn: () => void, delay: number) => {
					mockSetTimeoutCalls.push({ fn, delay });
					return 123 as any;
				};
				const mockClearTimeoutCalls: any[] = [];
				const mockClearTimeout = (id: any) => {
					mockClearTimeoutCalls.push(id);
				};

				const originalSetTimeout = globalThis.setTimeout;
				const originalClearTimeout = globalThis.clearTimeout;

				globalThis.setTimeout = mockSetTimeout as any;
				globalThis.clearTimeout = mockClearTimeout as any;

				const device = new Device("audio");

				// Simulate devicechange event
				const onchangeHandler = mockMediaDevices.addEventListenerArgs[0]?.[1] as (
					event: Event,
				) => void;

				// Call the handler multiple times rapidly
				onchangeHandler(new Event("devicechange"));
				onchangeHandler(new Event("devicechange"));
				onchangeHandler(new Event("devicechange"));

				// Verify debounce behavior - setTimeout should be called 3 times (once per call), clearTimeout 2 times (for the first 2 calls)
				assertEquals(mockSetTimeoutCalls.length, 3);
				assertEquals(mockSetTimeoutCalls[0].delay, 200);
				assertEquals(mockClearTimeoutCalls.length, 2); // Should clear previous timers

				// Restore
				globalThis.setTimeout = originalSetTimeout;
				globalThis.clearTimeout = originalClearTimeout;
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});
	});

	await t.step("Integration and Real-world Scenarios", async (t) => {
		await t.step("handles complete audio device setup flow", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const mockDevices = [
					new MockMediaDeviceInfo("audio1", "audioinput", "Microphone 1", "group1"),
					new MockMediaDeviceInfo(
						"default",
						"audioinput",
						"Default - Microphone 2",
						"group2",
					),
				];

				mockMediaDevices.enumerateDevicesResult = mockDevices as MediaDeviceInfo[];

				const mockTrack = {
					kind: "audio" as const,
					id: "track1",
					stop: createMockFunction(),
					getSettings: createMockFunction(),
				};
				mockTrack.getSettings.returns = {
					deviceId: "audio1",
				};
				const mockStream = {
					getTracks: createMockFunction(),
					getAudioTracks: createMockFunction(),
					getVideoTracks: createMockFunction(),
				} as any;
				mockStream.getTracks.returns = [mockTrack];
				mockStream.getAudioTracks.returns = [mockTrack];
				mockStream.getVideoTracks.returns = [];

				// Mock for both requestPermission and getTrack calls
				mockMediaDevices.getUserMediaResult = mockStream as MediaStream;

				const device = new Device("audio", { preferred: "audio1" });

				// Complete flow: update devices -> request permission -> get track
				await device.updateDevices();
				assertEquals(device.available, mockDevices.filter((d) => d.kind === "audioinput"));
				assertEquals(device.default, "default");

				const permissionGranted = await device.requestPermission();
				assertEquals(permissionGranted, true);

				const track = await device.getTrack();
				assertExists(track);
				assertEquals(track?.kind, "audio");

				device.close();
				assertEquals(mockMediaDevices.removeEventListenerCallCount, 1);
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});

		await t.step("handles device switching scenario", async () => {
			const {
				mockMediaDevices,
				originalNavigator,
				originalSetTimeout,
				originalClearTimeout,
				activeTimers,
			} = setupTestEnvironment();
			try {
				const initialDevices = [
					new MockMediaDeviceInfo("audio1", "audioinput", "Microphone 1", "group1"),
				];

				const updatedDevices = [
					new MockMediaDeviceInfo("audio1", "audioinput", "Microphone 1", "group1"),
					new MockMediaDeviceInfo("audio2", "audioinput", "Microphone 2", "group2"),
				];

				// Set up mock to return different results for different calls
				let enumerateCallCount = 0;
				const originalEnumerateDevices = mockMediaDevices.enumerateDevices;
				mockMediaDevices.enumerateDevices = async () => {
					enumerateCallCount++;
					mockMediaDevices.enumerateDevicesCallCount++;
					if (enumerateCallCount === 1) {
						return initialDevices as MediaDeviceInfo[];
					} else {
						return updatedDevices as MediaDeviceInfo[];
					}
				};

				const device = new Device("audio");
				// Wait for initial update
				await new Promise((resolve) => setTimeout(resolve, 0));
				assertEquals(device.available?.length, 1);

				// Simulate device change
				// Trigger devicechange event
				const onchangeHandler = mockMediaDevices.addEventListenerArgs[0]?.[1] as (
					event: Event,
				) => void;
				onchangeHandler(new Event("devicechange"));

				// Wait for debounced update
				await new Promise((resolve) => setTimeout(resolve, 300));
				assertEquals(device.available?.length, 2);
				// Note: mockCond.broadcast would be called in the real implementation
			} finally {
				cleanupTestEnvironment(
					originalNavigator,
					originalSetTimeout,
					originalClearTimeout,
					activeTimers,
				);
			}
		});
	});
});

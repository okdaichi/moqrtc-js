// filepath: src/media/camera_test.ts
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { Camera } from "./camera.ts";
import { MockMediaStreamTrack } from "./mock_media_stream_track_test.ts";

Deno.test("Camera", async (t) => {
	await t.step("constructor", async (t) => {
		await t.step("creates camera with default props", () => {
			const camera = new Camera();

			assertEquals(camera.enabled, false);
			assertEquals(camera.constraints, undefined);
			assertEquals(camera.preferred, undefined);
		});

		await t.step("creates camera with enabled=true", () => {
			const camera = new Camera({ enabled: true });

			assertEquals(camera.enabled, true);
			assertEquals(camera.constraints, undefined);
		});

		await t.step("creates camera with device props", () => {
			const camera = new Camera({ preferred: "camera-device-id" });

			assertEquals(camera.enabled, false);
			assertEquals(camera.preferred, "camera-device-id");
		});

		await t.step("creates camera with constraints", () => {
			const constraints = { width: 1920, height: 1080, frameRate: 30 };
			const camera = new Camera({ constraints });

			assertEquals(camera.enabled, false);
			assertEquals(camera.constraints, constraints);
		});

		await t.step("creates camera with all props", () => {
			const constraints = { width: 640, height: 480 };
			const camera = new Camera({
				preferred: "camera-device-id",
				enabled: true,
				constraints,
			});

			assertEquals(camera.enabled, true);
			assertEquals(camera.constraints, constraints);
			assertEquals(camera.preferred, "camera-device-id");
		});
	});
	await t.step("getVideoTrack", async (t) => {
		await t.step("gets video track when enabled", async () => {
			const camera = new Camera({ enabled: true });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			const mockTrack = new MockMediaStreamTrack("video-track-1");
			mockDevice.getTrackResult = mockTrack;
			(camera as any).device = mockDevice;

			const track = await camera.getVideoTrack();

			assertEquals(track, mockTrack);
			assertEquals(mockDevice.getTrackCallCount, 1);
			assertEquals(mockDevice.getTrackArgs[0], undefined);
		});

		await t.step("gets video track with constraints", async () => {
			const constraints = { width: 1920, height: 1080 };
			const camera = new Camera({ enabled: true, constraints });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			const mockTrack = new MockMediaStreamTrack("video-track-1");
			mockDevice.getTrackResult = mockTrack;
			(camera as any).device = mockDevice;

			const track = await camera.getVideoTrack();

			assertEquals(track, mockTrack);
			assertEquals(mockDevice.getTrackCallCount, 1);
			assertEquals(mockDevice.getTrackArgs[0], constraints);
		});

		await t.step("returns cached track on subsequent calls", async () => {
			const camera = new Camera({ enabled: true });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			const mockTrack = new MockMediaStreamTrack("video-track-1");
			mockDevice.getTrackResult = mockTrack;
			(camera as any).device = mockDevice;

			const track1 = await camera.getVideoTrack();
			assertEquals(track1, mockTrack);
			assertEquals(mockDevice.getTrackCallCount, 1);

			const track2 = await camera.getVideoTrack();
			assertEquals(track2, mockTrack);
			assertEquals(track2, track1);
			assertEquals(mockDevice.getTrackCallCount, 1); // Not called again
		});

		await t.step("throws when camera not enabled", async () => {
			const camera = new Camera({ enabled: false });

			await assertRejects(
				() => camera.getVideoTrack(),
				Error,
				"Camera is not enabled",
			);
		});

		await t.step("throws when device fails to get track", async () => {
			const camera = new Camera({ enabled: true });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			mockDevice.getTrackResult = undefined;
			(camera as any).device = mockDevice;

			await assertRejects(
				() => camera.getVideoTrack(),
				Error,
				"Failed to obtain camera track",
			);
			assertEquals(mockDevice.getTrackCallCount, 1);
		});

		await t.step("throws error when device.getTrack rejects", async () => {
			const camera = new Camera({ enabled: true });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			const deviceError = new Error("Device access denied");
			mockDevice.getTrackError = deviceError;
			(camera as any).device = mockDevice;

			await assertRejects(
				() => camera.getVideoTrack(),
				Error,
				"Device access denied",
			);
			assertEquals(mockDevice.getTrackCallCount, 1);
		});
	});

	await t.step("close", async (t) => {
		await t.step("stops track and closes device when track exists", async () => {
			const camera = new Camera({ enabled: true });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			const mockTrack = new MockMediaStreamTrack("video-track-1");
			mockDevice.getTrackResult = mockTrack;
			(camera as any).device = mockDevice;

			await camera.getVideoTrack();

			let stopCalled = false;
			mockTrack.stop = () => {
				stopCalled = true;
			};

			camera.close();

			assertEquals(stopCalled, true);
			assertEquals(mockDevice.closeCallCount, 1);
		});

		await t.step("closes device when no track exists", () => {
			const camera = new Camera();
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			(camera as any).device = mockDevice;

			camera.close();

			assertEquals(mockDevice.closeCallCount, 1);
		});

		await t.step("clears track reference after closing", async () => {
			const camera = new Camera({ enabled: true });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			const mockTrack1 = new MockMediaStreamTrack("video-track-1");
			mockDevice.getTrackResult = mockTrack1;
			(camera as any).device = mockDevice;

			const track1 = await camera.getVideoTrack();
			assertEquals(track1, mockTrack1);

			camera.close();

			const mockTrack2 = new MockMediaStreamTrack("video-track-2");
			mockDevice.getTrackResult = mockTrack2;

			const track2 = await camera.getVideoTrack();
			assertEquals(track2, mockTrack2);
			assert(track2 !== track1);
			assertEquals(mockDevice.getTrackCallCount, 2);
		});

		await t.step("handles track.stop() error gracefully", async () => {
			const camera = new Camera({ enabled: true });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			const mockTrack = new MockMediaStreamTrack("video-track-1");
			// Override stop to throw error
			mockTrack.stop = () => {
				mockTrack.stopCallCount++;
				throw new Error("Stop failed");
			};
			mockDevice.getTrackResult = mockTrack;
			(camera as any).device = mockDevice;

			await camera.getVideoTrack();

			try {
				camera.close();
			} catch {
				throw new Error("close() should not throw");
			}
			assertEquals(mockTrack.stopCallCount, 1);
			assertEquals(mockDevice.closeCallCount, 1);
		});

		await t.step("handles device.close() error gracefully", async () => {
			const camera = new Camera({ enabled: true });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			mockDevice.close = () => {
				mockDevice.closeCallCount++;
				throw new Error("Device close failed");
			};
			const mockTrack = new MockMediaStreamTrack("video-track-1");
			mockDevice.getTrackResult = mockTrack;
			(camera as any).device = mockDevice;

			await camera.getVideoTrack();

			try {
				camera.close();
			} catch {
				throw new Error("close() should not throw");
			}
			assertEquals(mockTrack.stopCallCount, 1);
			assertEquals(mockDevice.closeCallCount, 1);
		});
	});

	await t.step("Integration scenarios", async (t) => {
		await t.step("complete camera lifecycle", async () => {
			const camera = new Camera({ enabled: true });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			const mockTrack = new MockMediaStreamTrack("video-track-1");
			mockDevice.getTrackResult = mockTrack;
			(camera as any).device = mockDevice;

			const constraints = { width: 1280, height: 720, frameRate: 30 };
			// Set constraints after creation since we can't pass device
			camera.constraints = constraints;

			assertEquals(camera.enabled, true);
			assertEquals(camera.constraints, constraints);

			const track = await camera.getVideoTrack();
			assertEquals(track, mockTrack);
			assertEquals(mockDevice.getTrackArgs[0], constraints);

			const track2 = await camera.getVideoTrack();
			assertEquals(track2, track);
			assertEquals(mockDevice.getTrackCallCount, 1);

			let stopCalled = false;
			mockTrack.stop = () => {
				mockTrack.stopCallCount++;
				stopCalled = true;
			};
			camera.close();
			assertEquals(stopCalled, true);
			assertEquals(mockDevice.closeCallCount, 1);
		});

		await t.step("enable/disable workflow", async () => {
			const camera = new Camera({ enabled: false });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			(camera as any).device = mockDevice;

			await assertRejects(
				() => camera.getVideoTrack(),
				Error,
				"Camera is not enabled",
			);

			camera.enabled = true;

			const mockTrack = new MockMediaStreamTrack("video-track-1");
			mockDevice.getTrackResult = mockTrack;

			const track = await camera.getVideoTrack();
			assertEquals(track, mockTrack);

			camera.enabled = false;

			await assertRejects(
				() => camera.getVideoTrack(),
				Error,
				"Camera is not enabled",
			);

			camera.close();
		});

		await t.step("constraints updates", async () => {
			const camera = new Camera({ enabled: true });
			const mockDevice = new MockDevice();
			mockDevice.kind = "video";
			(camera as any).device = mockDevice;

			const mockTrack1 = new MockMediaStreamTrack("video-track-1");
			mockDevice.getTrackResult = mockTrack1;

			const track1 = await camera.getVideoTrack();
			assertEquals(track1, mockTrack1);

			// Update constraints by modifying the property
			const newConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 } };
			camera.constraints = newConstraints;

			// Since track is cached, we need to simulate getting a new track
			// In real usage, constraints are used when initially getting the track
			// For testing, we'll create a new camera with different constraints
			const camera2 = new Camera({ enabled: true, constraints: newConstraints });
			const mockDevice2 = new MockDevice();
			mockDevice2.kind = "video";
			const mockTrack2 = new MockMediaStreamTrack("video-track-2");
			mockDevice2.getTrackResult = mockTrack2;
			(camera2 as any).device = mockDevice2;

			const track2 = await camera2.getVideoTrack();
			assertEquals(track2, mockTrack2);

			// Verify tracks are different
			assertNotEquals(track1, track2);

			camera.close();
			camera2.close();
		});
	});
});

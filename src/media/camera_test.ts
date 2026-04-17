import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { Camera } from "./camera.ts";
import { MediaDeviceContext } from "./device.ts";
import { setupFakeMediaDevices } from "./fake_media_devices.ts";

Deno.test("Camera", async (t) => {
	await t.step("constructor", async (t) => {
		await t.step("creates camera with default props", () => {
			using _env = setupFakeMediaDevices([]);
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx);

			assertEquals(camera.enabled, false);
			assertEquals(camera.constraints, undefined);
			assertEquals(camera.preferred, undefined);
		});

		await t.step("creates camera with options", () => {
			using _env = setupFakeMediaDevices([]);
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx, {
				enabled: true,
				preferred: "camera-device-id",
				constraints: { width: 1920 },
			});

			assertEquals(camera.enabled, true);
			assertEquals(camera.preferred, "camera-device-id");
			assertEquals(camera.constraints, { width: 1920 });
		});
	});

	await t.step("getVideoTrack", async (t) => {
		await t.step("gets video track when enabled", async () => {
			using _env = setupFakeMediaDevices([
				{ kind: "videoinput", label: "Camera 1", deviceId: "vid1" },
			]);
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx, { enabled: true });

			const track = await camera.getVideoTrack();
			assertEquals(track.kind, "video");
			assertEquals(track.label, "Camera 1");
		});

		await t.step("gets video track with constraints", async () => {
			using _env = setupFakeMediaDevices([
				{ kind: "videoinput", label: "Camera 1", deviceId: "vid1" },
			]);
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx, { enabled: true, constraints: { width: 1080 } });

			const track = await camera.getVideoTrack();
			const settings = track.getSettings();
			assertEquals(settings.deviceId, "vid1");
			assertEquals(track.getConstraints(), { width: 1080 });
		});

		await t.step("returns cached track on subsequent calls", async () => {
			using _env = setupFakeMediaDevices([
				{ kind: "videoinput", label: "Camera 1", deviceId: "vid1" },
			]);
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx, { enabled: true });

			const track1 = await camera.getVideoTrack();
			const track2 = await camera.getVideoTrack();

			assertEquals(track1.id, track2.id); // Same object instance should be returned
		});

		await t.step("throws when camera not enabled", async () => {
			using _env = setupFakeMediaDevices([]);
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx, { enabled: false });

			await assertRejects(
				() => camera.getVideoTrack(),
				Error,
				"Camera is not enabled",
			);
		});

		await t.step("throws when device fails to get track", async () => {
			using _env = setupFakeMediaDevices([]); // No video devices available
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx, { enabled: true });

			await assertRejects(
				() => camera.getVideoTrack(),
			);
		});
	});

	await t.step("close", async (t) => {
		await t.step("stops track and closes device when track exists", async () => {
			using _env = setupFakeMediaDevices([
				{ kind: "videoinput", label: "Camera 1", deviceId: "vid1" },
			]);
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx, { enabled: true });

			const track = await camera.getVideoTrack();
			assertEquals(track.readyState, "live");

			camera.close();
			assertEquals(track.readyState, "ended");
		});

		await t.step("clears track reference after closing", async () => {
			using _env = setupFakeMediaDevices([
				{ kind: "videoinput", label: "Camera 1", deviceId: "vid1" },
			]);
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx, { enabled: true });

			const track1 = await camera.getVideoTrack();
			camera.close();

			// Re-enable and get track again
			camera.enabled = true;
			const track2 = await camera.getVideoTrack();
			assertNotEquals(track1.id, track2.id);
		});
	});

	await t.step("Integration scenarios", async (t) => {
		await t.step("enable/disable workflow", async () => {
			using _env = setupFakeMediaDevices([
				{ kind: "videoinput", label: "Camera 1", deviceId: "vid1" },
			]);
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx, { enabled: false });

			await assertRejects(
				() => camera.getVideoTrack(),
				Error,
				"Camera is not enabled",
			);

			camera.enabled = true;
			const track = await camera.getVideoTrack();
			assertEquals(track.kind, "video");

			camera.enabled = false;
			await assertRejects(
				() => camera.getVideoTrack(),
				Error,
				"Camera is not enabled",
			);

			camera.close();
		});

		await t.step("constraints updates", async () => {
			using _env = setupFakeMediaDevices([
				{ kind: "videoinput", label: "Camera 1", deviceId: "vid1" },
			]);
			const ctx = new MediaDeviceContext();
			const camera = new Camera(ctx, { enabled: true });

			const track = await camera.getVideoTrack();

			const newConstraints = { width: 1920 };
			await camera.updateConstraints(newConstraints);

			assertEquals(camera.constraints, newConstraints);
			assertEquals(track.getConstraints(), newConstraints);

			camera.close();
		});
	});
});

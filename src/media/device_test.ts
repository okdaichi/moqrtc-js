import { assertEquals, assertExists } from "@std/assert";
import { Device, MediaDeviceContext } from "./device.ts";
import { setupFakeMediaDevices } from "./fake_media_devices_test.ts";

const devices = [
	{ kind: "audioinput" as MediaDeviceKind, label: "Mic", deviceId: "mic-1" },
	{ kind: "videoinput" as MediaDeviceKind, label: "Cam", deviceId: "cam-1" },
];

Deno.test("MediaDeviceContext", async (t) => {
	await t.step("enumerates devices on creation", async () => {
		using _fakeMap = setupFakeMediaDevices(devices);
		const context = new MediaDeviceContext();
		await context.updateDevices();

		const all = context.devices;
		assertEquals(all.length, 2);
		assertEquals(all[0]?.deviceId, ""); // No permissions yet
	});

	await t.step("requests permissions and exposes true devices", async () => {
		using _fakeMap = setupFakeMediaDevices(devices);
		const context = new MediaDeviceContext();

		await context.requestPermission("video");
		await context.updateDevices();

		const videoDevices = context.getDevices("video");
		assertEquals(videoDevices[0]?.deviceId, "cam-1"); // Permissions granted

		const audioDevices = context.getDevices("audio");
		assertEquals(audioDevices[0]?.deviceId, ""); // Still no audio permissions
	});

	await t.step("findDevice finds by exact or partial match", async () => {
		using _fakeMap = setupFakeMediaDevices(devices);
		const context = new MediaDeviceContext();
		await context.requestPermission("video");
		await context.updateDevices();

		const device = context.findDevice("video", { label: "caM" }); // case insensitive
		assertExists(device);
		assertEquals(device.deviceId, "cam-1");
	});

	await t.step("subscribe/unsubscribe and trigger devicechange", async () => {
		using _fakeMap = setupFakeMediaDevices(devices);
		const context = new MediaDeviceContext();
		await context.updateDevices();

		let callCount = 0;
		const unsubscribe = context.subscribe((_devices) => {
			callCount++;
		});

		// Trigger a device change in our fake
		_fakeMap.fake.triggerDeviceChange();

		// Using setImmediate or small timeout to wait for debounce
		await new Promise((r) => setTimeout(r, 250));

		assertEquals(callCount, 1);

		unsubscribe();
		_fakeMap.fake.triggerDeviceChange();
		await new Promise((r) => setTimeout(r, 250));

		assertEquals(callCount, 1); // should not increment
	});
});

Deno.test("abstract Device", async (t) => {
	const getDefaultDeviceId = () => "cam-1";

	await t.step("initializes correctly", () => {
		using _fakeMap = setupFakeMediaDevices(devices);
		const context = new MediaDeviceContext();
		const device = new Device(context, "video", {
			enabled: true,
			preferred: "cam-1",
			constraints: { width: 1920 },
			getDefaultDeviceId,
		});

		assertEquals(device.kind, "video");
		assertEquals(device.enabled, true);
		assertEquals(device.preferred, "cam-1");
		assertEquals(device.constraints?.width, 1920);
	});

	await t.step("stop() clears stream", async () => {
		using _fakeMap = setupFakeMediaDevices(devices);
		const context = new MediaDeviceContext();
		const device = new Device(context, "video", { enabled: true, getDefaultDeviceId });

		device.stream =
			(await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0];
		assertEquals(device.stream?.readyState, "live");

		device.stop();
		assertEquals(device.stream, undefined);
	});

	await t.step("switchDevice updates preferred device ID and stops old track", async () => {
		using _fakeMap = setupFakeMediaDevices(devices);
		const context = new MediaDeviceContext();
		const device = new Device(context, "video", { enabled: true, getDefaultDeviceId });

		device.stream =
			(await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0];

		await device.switchDevice("cam-2");
		assertEquals(device.preferred, "cam-2");
		assertEquals(device.activeDeviceId, "cam-2");
		assertEquals(device.stream, undefined);
	});

	await t.step("updateConstraints applies constraints to active track", async () => {
		using _fakeMap = setupFakeMediaDevices(devices);
		const context = new MediaDeviceContext();
		const device = new Device(context, "video", { enabled: true, getDefaultDeviceId });

		device.stream =
			(await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0];
		assertEquals(device.stream?.readyState, "live");

		await device.updateConstraints({ height: 1080 });
		assertEquals(device.constraints?.height, 1080);
		assertEquals(device.stream?.getConstraints()?.height, 1080);
	});
});

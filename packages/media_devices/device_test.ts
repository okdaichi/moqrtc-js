import { assertEquals, assertExists } from "@std/assert";
import { Device, MediaDeviceContext } from "./device.ts";
import { FakeClock, FakeMediaDevices, setupFakeMediaDevices } from "./fake_media_devices_test.ts";

const devices = [
	{ kind: "audioinput" as MediaDeviceKind, label: "Mic", deviceId: "mic-1" },
	{ kind: "videoinput" as MediaDeviceKind, label: "Cam", deviceId: "cam-1" },
];

// Chrome on Windows: a USB microphone is both the default and the
// communications device, and is listed under both aliases besides its own id.
const windowsHeadset = [
	{
		kind: "audioinput" as MediaDeviceKind,
		label: "Default - USB Mic",
		deviceId: "default",
		groupId: "g-usb",
	},
	{
		kind: "audioinput" as MediaDeviceKind,
		label: "Communications - USB Mic",
		deviceId: "communications",
		groupId: "g-usb",
	},
	{
		kind: "audioinput" as MediaDeviceKind,
		label: "Built-in Mic",
		deviceId: "mic-1",
		groupId: "g-builtin",
	},
	{
		kind: "audioinput" as MediaDeviceKind,
		label: "USB Mic",
		deviceId: "mic-2",
		groupId: "g-usb",
	},
];

Deno.test("MediaDeviceContext", async (t) => {
	await t.step("enumerates devices on creation", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		await context.updateDevices();

		const all = context.devices;
		assertEquals(all.length, 2);
		assertEquals(all[0]?.deviceId, ""); // No permissions yet
	});

	await t.step("requests permissions and exposes true devices", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });

		await context.requestPermission("video");
		await context.updateDevices();

		const videoDevices = context.getDevices("video");
		assertEquals(videoDevices[0]?.deviceId, "cam-1"); // Permissions granted

		// Still no audio permission: the hidden microphone cannot be chosen.
		assertEquals(context.getDevices("audio"), []);
	});

	await t.step("lists each device once beside the browser's aliases", async () => {
		const fake = new FakeMediaDevices(windowsHeadset);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		await context.requestPermission("audio");

		assertEquals(context.getDevices("audio").map((d) => d.deviceId), ["mic-1", "mic-2"]);
	});

	await t.step("resolves the default alias to the device it points at", async () => {
		const fake = new FakeMediaDevices(windowsHeadset);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		await context.requestPermission("audio");

		assertEquals(context.getDefaultDevice("audio")?.deviceId, "mic-2");
	});

	await t.step("takes the first device as default when there is no alias", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		await context.requestPermission("audio");

		assertEquals(context.getDefaultDevice("audio")?.deviceId, "mic-1");
	});

	await t.step("lists the audio outputs and their default", async () => {
		const fake = new FakeMediaDevices([
			...windowsHeadset,
			{
				kind: "audiooutput",
				label: "Default - Speakers",
				deviceId: "default",
				groupId: "g-spk",
			},
			{ kind: "audiooutput", label: "Speakers", deviceId: "spk-1", groupId: "g-spk" },
			{ kind: "audiooutput", label: "Headphones", deviceId: "spk-2", groupId: "g-hp" },
		]);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		await context.requestPermission("audio");

		assertEquals({
			outputs: context.getOutputDevices().map((d) => d.deviceId),
			defaultOutput: context.getDefaultOutputDevice()?.deviceId,
		}, { outputs: ["spk-1", "spk-2"], defaultOutput: "spk-1" });
	});

	await t.step("findDevice finds by exact or partial match", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		await context.requestPermission("video");
		await context.updateDevices();

		const device = context.findDevice("video", { label: "caM" }); // case insensitive
		assertExists(device);
		assertEquals(device.deviceId, "cam-1");
	});

	await t.step("subscribe/unsubscribe and trigger devicechange", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		await context.updateDevices();

		let callCount = 0;
		const unsubscribe = context.subscribe((_devices) => {
			callCount++;
		});

		// Trigger a device change in our fake
		fake.triggerDeviceChange();

		// Using setImmediate or small timeout to wait for debounce
		await new Promise((r) => setTimeout(r, 250));

		assertEquals(callCount, 1);

		unsubscribe();
		fake.triggerDeviceChange();
		await new Promise((r) => setTimeout(r, 250));

		assertEquals(callCount, 1); // should not increment
	});
});

Deno.test("abstract Device", async (t) => {
	const getDefaultDeviceId = () => "cam-1";

	await t.step("initializes correctly", () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
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
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		const device = new Device(context, "video", { enabled: true, getDefaultDeviceId });

		device.stream = (await fake.getUserMedia({ video: true })).getVideoTracks()[0];
		assertEquals(device.stream?.readyState, "live");

		device.stop();
		assertEquals(device.stream, undefined);
	});

	await t.step("switchDevice updates preferred device ID and stops old track", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		const device = new Device(context, "video", { enabled: true, getDefaultDeviceId });

		device.stream = (await fake.getUserMedia({ video: true })).getVideoTracks()[0];

		await device.switchDevice("cam-2");
		assertEquals(device.preferred, "cam-2");
		assertEquals(device.activeDeviceId, "cam-2");
		assertEquals(device.stream, undefined);
	});

	await t.step("switchDevice(undefined) follows the default device again", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		const device = new Device(context, "video", {
			enabled: true,
			preferred: "cam-2",
			getDefaultDeviceId,
		});

		await device.switchDevice(undefined);

		assertEquals({ preferred: device.preferred, active: device.activeDeviceId }, {
			preferred: undefined,
			active: "cam-1",
		});
	});

	await t.step("switchDevice(undefined) stops the live track", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		const device = new Device(context, "video", {
			enabled: true,
			preferred: "cam-2",
			getDefaultDeviceId,
		});
		const track = (await fake.getUserMedia({ video: true })).getVideoTracks()[0];
		device.stream = track;

		await device.switchDevice(undefined);

		assertEquals(track?.readyState, "ended");
	});

	await t.step("updateConstraints applies constraints to active track", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		const device = new Device(context, "video", { enabled: true, getDefaultDeviceId });

		device.stream = (await fake.getUserMedia({ video: true })).getVideoTracks()[0];
		assertEquals(device.stream?.readyState, "live");

		await device.updateConstraints({ height: 1080 });
		assertEquals(device.constraints?.height, 1080);
		assertEquals(device.stream?.getConstraints()?.height, 1080);
	});
});

Deno.test("MediaDeviceContext media devices", async (t) => {
	await t.step("uses the browser's media devices when given none", async () => {
		using env = setupFakeMediaDevices(devices);
		const context = new MediaDeviceContext();

		await context.requestPermission("audio");

		assertEquals(context.getDevices("audio").map((d) => d.deviceId), ["mic-1"]);
		assertEquals(env.fake.granted.length, 1);
	});

	await t.step("enumerates the media devices it was given", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });

		await context.requestPermission("video");

		assertEquals(context.getDevices("video").map((d) => d.deviceId), ["cam-1"]);
	});
});

Deno.test("MediaDeviceContext.requestPermission", async (t) => {
	await t.step("resolves true once the prompt is answered", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });

		assertEquals(await context.requestPermission("audio"), true);
	});

	await t.step("resolves false when the prompt is not answered in time", async () => {
		const fake = new FakeMediaDevices(devices);
		fake.answer = new Promise(() => {});
		const clock = new FakeClock();
		const context = new MediaDeviceContext({ mediaDevices: fake, clock });
		const granted = context.requestPermission("audio");

		clock.fire();

		assertEquals(await granted, false);
	});

	await t.step("waits the permission timeout it was given", () => {
		const fake = new FakeMediaDevices(devices);
		fake.answer = new Promise(() => {});
		const clock = new FakeClock();
		const context = new MediaDeviceContext({
			mediaDevices: fake,
			clock,
			permissionTimeoutMs: 1500,
		});

		void context.requestPermission("audio");

		assertEquals(clock.started, [1500]);
	});

	await t.step("resolves false when permission is refused", async () => {
		const fake = new FakeMediaDevices(devices);
		fake.failure = new DOMException("Permission denied", "NotAllowedError");
		const context = new MediaDeviceContext({ mediaDevices: fake });

		assertEquals(await context.requestPermission("audio"), false);
	});

	await t.step("resolves false when getUserMedia throws at once", async () => {
		const fake = new FakeMediaDevices(devices);
		fake.syncFailure = new TypeError("bad constraints");
		const context = new MediaDeviceContext({ mediaDevices: fake });

		assertEquals(await context.requestPermission("audio"), false);
	});

	await t.step("stops a stream granted after the timeout", async () => {
		const fake = new FakeMediaDevices(devices);
		const prompt = Promise.withResolvers<void>();
		fake.answer = prompt.promise;
		const clock = new FakeClock();
		const context = new MediaDeviceContext({ mediaDevices: fake, clock });
		const granted = context.requestPermission("audio");
		clock.fire();
		await granted;

		prompt.resolve();
		const late = await fake.firstGrant;
		await late.stopped;

		assertEquals(late.readyState, "ended");
	});

	await t.step("asks again after a prompt timed out", async () => {
		const fake = new FakeMediaDevices(devices);
		fake.answer = new Promise(() => {});
		const clock = new FakeClock();
		const context = new MediaDeviceContext({ mediaDevices: fake, clock });
		const first = context.requestPermission("audio");
		clock.fire();
		await first;
		fake.answer = undefined;

		assertEquals(await context.requestPermission("audio"), true);
	});
});

Deno.test("MediaDeviceContext.subscribe", async (t) => {
	await t.step("hands the devices to every listener when one throws", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });
		await context.updateDevices();
		let heard = 0;
		context.subscribe(() => {
			throw new Error("listener failed");
		});
		context.subscribe(() => heard++);

		await context.updateDevices();

		assertEquals(heard, 1);
	});
});

Deno.test("MediaDeviceContext.listStatus", async (t) => {
	await t.step("is unknown before the browser has listed devices", () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });

		assertEquals(context.listStatus("audioinput"), { status: "unknown" });
	});

	await t.step("is hidden while the browser lists devices without ids", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });

		await context.updateDevices();

		assertEquals(context.listStatus("audioinput"), { status: "hidden" });
	});

	await t.step("lists the devices and the default once permission is granted", async () => {
		const fake = new FakeMediaDevices(windowsHeadset);
		const context = new MediaDeviceContext({ mediaDevices: fake });

		await context.requestPermission("audio");

		const status = context.listStatus("audioinput");
		assertEquals(
			status.status === "listed"
				? {
					devices: status.devices.map((d) => d.deviceId),
					defaultDevice: status.defaultDevice?.deviceId,
				}
				: status,
			{ devices: ["mic-1", "mic-2"], defaultDevice: "mic-2" },
		);
	});

	await t.step("is unlisted for a kind the browser lists no entry of", async () => {
		const fake = new FakeMediaDevices(windowsHeadset);
		const context = new MediaDeviceContext({ mediaDevices: fake });

		await context.updateDevices();

		assertEquals(context.listStatus("videoinput"), { status: "unlisted" });
	});

	await t.step("is unlisted for audio outputs a browser never lists", async () => {
		const fake = new FakeMediaDevices(devices);
		const context = new MediaDeviceContext({ mediaDevices: fake });

		await context.requestPermission("audio");

		assertEquals(context.listStatus("audiooutput"), { status: "unlisted" });
	});

	await t.step("is hidden for audio outputs until permission is granted", async () => {
		const fake = new FakeMediaDevices([
			{ kind: "audiooutput", label: "Speakers", deviceId: "spk-1" },
		]);
		const context = new MediaDeviceContext({ mediaDevices: fake });

		await context.updateDevices();

		assertEquals(context.listStatus("audiooutput"), { status: "hidden" });
	});

	await t.step("lists the audio outputs once permission is granted", async () => {
		const fake = new FakeMediaDevices([
			...devices,
			{ kind: "audiooutput", label: "Speakers", deviceId: "spk-1" },
		]);
		const context = new MediaDeviceContext({ mediaDevices: fake });

		await context.requestPermission("audio");

		const status = context.listStatus("audiooutput");
		assertEquals(
			status.status === "listed" ? status.devices.map((d) => d.deviceId) : status,
			["spk-1"],
		);
	});
});

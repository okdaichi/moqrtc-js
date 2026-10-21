import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { MediaDeviceContext } from "./device.ts";
import { FakeMediaDevices } from "./fake_media_devices_test.ts";
import { Microphone, MicrophoneError } from "./microphone.ts";

const devices = [
	{ kind: "audioinput" as MediaDeviceKind, label: "Built-in Microphone", deviceId: "mic-1" },
	{ kind: "audioinput" as MediaDeviceKind, label: "External USB Mic", deviceId: "mic-2" },
];

// The system default, as Chrome lists it: an alias beside the device it points at.
const usbDefault = [
	{
		kind: "audioinput" as MediaDeviceKind,
		label: "Default - USB Mic",
		deviceId: "default",
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

// The same devices once the system default moved to the built-in microphone.
const builtInDefault = [
	{
		kind: "audioinput" as MediaDeviceKind,
		label: "Default - Built-in Mic",
		deviceId: "default",
		groupId: "g-builtin",
	},
	...usbDefault.slice(1),
];

Deno.test("Microphone", async (t) => {
	await t.step("constructor", async (st) => {
		await st.step("creates microphone with default props", () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context);

			assertEquals(mic.kind, "audio");
			assertEquals(mic.enabled, false);
			assertEquals(mic.preferred, undefined);
			assertEquals(mic.activeDeviceId, undefined);
			assertEquals(mic.constraints, undefined);
		});

		await st.step("creates microphone with options", () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const constraints = { echoCancellation: true };
			const onTrackEnded = () => {};

			const mic = new Microphone(context, {
				enabled: true,
				preferred: "mic-2",
				constraints,
				onTrackEnded,
			});

			assertEquals(mic.enabled, true);
			assertEquals(mic.preferred, "mic-2");
			assertEquals(mic.constraints, constraints);
			assertEquals(mic.onTrackEnded, onTrackEnded);
		});
	});

	await t.step("getAudioTrack", async (st) => {
		await st.step("gets audio track when enabled", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });

			const track = await mic.getAudioTrack();
			assertExists(track);
			assertEquals(track.kind, "audio");
			assertEquals(track.readyState, "live");
		});

		await st.step("gets audio track with constraints", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const constraints = { echoCancellation: true, noiseSuppression: true };
			const mic = new Microphone(context, {
				enabled: true,
				constraints,
			});

			const track = await mic.getAudioTrack();
			assertExists(track);
			// The device is named once permission reveals it.
			assertEquals(track.getConstraints(), { deviceId: { exact: "mic-1" }, ...constraints });
		});

		await st.step("returns cached track on subsequent calls", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });

			const track1 = await mic.getAudioTrack();
			const track2 = await mic.getAudioTrack();

			assertEquals(track1, track2);
		});

		await st.step("asks for a new track after the cached one was stopped", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			const stopped = await mic.getAudioTrack();
			stopped.stop();

			const track = await mic.getAudioTrack();

			assertEquals({ fresh: track !== stopped, state: track.readyState }, {
				fresh: true,
				state: "live",
			});
		});

		await st.step("throws when microphone not enabled", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: false });

			await assertRejects(
				() => mic.getAudioTrack(),
				Error,
				"Microphone is not enabled",
			);
		});

		await st.step("rejects as missing when there is no microphone", async () => {
			const fake = new FakeMediaDevices([]);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });

			const error = await assertRejects(() => mic.getAudioTrack(), MicrophoneError);

			assertEquals(error.reason, "missing");
		});

		const failures = [
			{ name: "NotAllowedError", reason: "blocked" },
			{ name: "SecurityError", reason: "blocked" },
			{ name: "NotFoundError", reason: "missing" },
			{ name: "OverconstrainedError", reason: "missing" },
			{ name: "NotReadableError", reason: "busy" },
			{ name: "TrackStartError", reason: "busy" },
			{ name: "AbortError", reason: "failed" },
		] as const;
		for (const c of failures) {
			await st.step(`rejects as ${c.reason} when the browser says ${c.name}`, async () => {
				const fake = new FakeMediaDevices(devices);
				const cause = new DOMException("refused", c.name);
				fake.failure = cause;
				const context = new MediaDeviceContext({ mediaDevices: fake });
				const mic = new Microphone(context, { enabled: true });

				const error = await assertRejects(() => mic.getAudioTrack(), MicrophoneError);

				assertEquals({ reason: error.reason, cause: error.cause }, {
					reason: c.reason,
					cause,
				});
			});
		}

		await st.step("rejects as failed where the browser has no media devices", async () => {
			const context = new MediaDeviceContext();
			const mic = new Microphone(context, { enabled: true });

			const error = await assertRejects(() => mic.getAudioTrack(), MicrophoneError);

			assertEquals(error.reason, "failed");
		});

		await st.step("opens the new default after following it again", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true, preferred: "mic-1" });
			await context.requestPermission("audio");
			await mic.switchDevice(undefined);

			const track = await mic.getAudioTrack();

			assertEquals(track.getConstraints().deviceId, { exact: "mic-2" });
		});
	});

	await t.step("switchDevice", async (st) => {
		await st.step("follows the system default again given undefined", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true, preferred: "mic-1" });
			await context.requestPermission("audio");

			await mic.switchDevice(undefined);

			assertEquals({ preferred: mic.preferred, active: mic.activeDeviceId }, {
				preferred: undefined,
				active: "mic-2",
			});
		});

		await st.step("stops the live track", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true, preferred: "mic-1" });
			const track = await mic.getAudioTrack();

			await mic.switchDevice(undefined);

			assertEquals(track.readyState, "ended");
		});
	});

	await t.step("onDefaultChange", async (st) => {
		await st.step("reports a default that moved while the microphone follows it", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const moves: string[] = [];
			new Microphone(context, { onDefaultChange: (id) => moves.push(id) });
			await context.requestPermission("audio");
			fake.setDevices(builtInDefault);

			await context.updateDevices();

			assertEquals(moves, ["mic-1"]);
		});

		await st.step("does not report the default first learned", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const moves: string[] = [];
			new Microphone(context, { onDefaultChange: (id) => moves.push(id) });

			await context.requestPermission("audio");

			assertEquals(moves, []);
		});

		await st.step("does not report a default that stayed", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const moves: string[] = [];
			new Microphone(context, { onDefaultChange: (id) => moves.push(id) });
			await context.requestPermission("audio");

			await context.updateDevices();

			assertEquals(moves, []);
		});

		await st.step("does not report a moved default while a device is preferred", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const moves: string[] = [];
			new Microphone(context, {
				preferred: "mic-2",
				onDefaultChange: (id) => moves.push(id),
			});
			await context.requestPermission("audio");
			fake.setDevices(builtInDefault);

			await context.updateDevices();

			assertEquals(moves, []);
		});
	});

	await t.step("close", async (st) => {
		await st.step("stops track and closes device when track exists", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });

			const track = await mic.getAudioTrack();
			assertEquals(track.readyState, "live");

			mic.close();

			assertEquals(track.readyState, "ended");
		});

		await st.step("clears track reference after closing", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });

			await mic.getAudioTrack();
			mic.close();

			mic.enabled = true; // RE-enable
			const track2 = await mic.getAudioTrack(); // should create new track
			assertExists(track2);
			assertEquals(track2.readyState, "live");
		});
	});

	await t.step("Integration scenarios", async (st) => {
		await st.step("enable/disable workflow", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });

			const track = await mic.getAudioTrack();
			assertEquals(track.readyState, "live");

			mic.enabled = false;
			mic.close();
			assertEquals(track.readyState, "ended");

			mic.enabled = true;
			const newTrack = await mic.getAudioTrack();
			assertEquals(newTrack.readyState, "live");
			assertEquals(newTrack !== track, true);
		});

		await st.step("constraints updates", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, {
				enabled: true,
				constraints: { echoCancellation: true },
			});

			const track = await mic.getAudioTrack();
			assertEquals(track.getConstraints(), {
				deviceId: { exact: "mic-1" },
				echoCancellation: true,
			});

			await mic.updateConstraints({ echoCancellation: false, noiseSuppression: true });
			const updatedTrack = await mic.getAudioTrack();

			// updateConstraints applies to existing track
			assertEquals(updatedTrack.getConstraints(), {
				echoCancellation: false,
				noiseSuppression: true,
			});
			assertEquals(updatedTrack === track, true);
			assertEquals(track.readyState, "live");
		});
	});
});

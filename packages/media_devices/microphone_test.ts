import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { MediaDeviceContext } from "./device.ts";
import { FakeClock, FakeMediaDevices } from "./fake_media_devices_test.ts";
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
			// Following the system default names no device.
			assertEquals(track.getConstraints(), constraints);
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
			const context = new MediaDeviceContext({ mediaDevices: null });
			const mic = new Microphone(context, { enabled: true });

			const error = await assertRejects(() => mic.getAudioTrack(), MicrophoneError);

			assertEquals(error.reason, "failed");
		});

		await st.step("names no device after following the default again", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true, preferred: "mic-1" });
			await context.requestPermission("audio");
			await mic.switchDevice(undefined);

			const track = await mic.getAudioTrack();

			assertEquals(track.getConstraints().deviceId, undefined);
		});

		await st.step("opens a preferred microphone by its id", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true, preferred: "mic-1" });

			const track = await mic.getAudioTrack();

			assertEquals(track.getSettings().deviceId, "mic-1");
		});

		await st.step("opens the default even when the listed default is stale", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			await context.requestPermission("audio");
			// The USB microphone is unplugged; the context has not listed devices since.
			fake.setDevices(builtInDefault.filter((d) => d.deviceId !== "mic-2"));

			const track = await mic.getAudioTrack();

			assertEquals(track.readyState, "live");
		});

		await st.step("keeps the resolved default when the browser reports its alias", async () => {
			const fake = new FakeMediaDevices(usbDefault);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			await context.requestPermission("audio");

			await mic.getAudioTrack();

			assertEquals(mic.activeDeviceId, "mic-2");
		});

		await st.step("rejects as timeout when the prompt is not answered in time", async () => {
			const fake = new FakeMediaDevices(devices);
			fake.answer = new Promise(() => {});
			const clock = new FakeClock();
			const context = new MediaDeviceContext({ mediaDevices: fake, clock });
			const mic = new Microphone(context, { enabled: true });
			const opening = mic.getAudioTrack();

			clock.fire();

			const error = await assertRejects(() => opening, MicrophoneError);
			assertEquals(error.reason, "timeout");
		});

		await st.step("stops a microphone granted after the timeout", async () => {
			const fake = new FakeMediaDevices(devices);
			const prompt = Promise.withResolvers<void>();
			fake.answer = prompt.promise;
			const clock = new FakeClock();
			const context = new MediaDeviceContext({ mediaDevices: fake, clock });
			const mic = new Microphone(context, { enabled: true });
			const opening = mic.getAudioTrack();
			clock.fire();
			await assertRejects(() => opening, MicrophoneError);

			prompt.resolve();
			const late = await fake.firstGrant;
			await late.stopped;

			assertEquals(late.readyState, "ended");
		});

		await st.step("answers concurrent calls with the same track", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });

			const [first, second] = await Promise.all([mic.getAudioTrack(), mic.getAudioTrack()]);

			assertEquals(first === second, true);
		});

		await st.step("opens the microphone once for concurrent calls", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });

			await Promise.all([mic.getAudioTrack(), mic.getAudioTrack()]);

			assertEquals(fake.granted.length, 1);
		});

		await st.step("rejects an open overtaken by switchDevice as aborted", async () => {
			const fake = new FakeMediaDevices(devices);
			const prompt = Promise.withResolvers<void>();
			fake.answer = prompt.promise;
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			const opening = mic.getAudioTrack();
			await mic.switchDevice("mic-2");

			prompt.resolve();

			const error = await assertRejects(() => opening, MicrophoneError);
			assertEquals(error.reason, "aborted");
		});

		await st.step("stops the track of an open overtaken by switchDevice", async () => {
			const fake = new FakeMediaDevices(devices);
			const prompt = Promise.withResolvers<void>();
			fake.answer = prompt.promise;
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			const opening = mic.getAudioTrack();
			await mic.switchDevice("mic-2");

			prompt.resolve();
			await assertRejects(() => opening, MicrophoneError);

			assertEquals(fake.granted.map((track) => track.readyState), ["ended"]);
		});

		await st.step("opens the device switched to for a call made after the switch", async () => {
			const fake = new FakeMediaDevices(devices);
			const prompt = Promise.withResolvers<void>();
			fake.answer = prompt.promise;
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			const overtaken = mic.getAudioTrack();
			await mic.switchDevice("mic-2");
			const opening = mic.getAudioTrack();

			prompt.resolve();
			await assertRejects(() => overtaken, MicrophoneError);

			assertEquals((await opening).getSettings().deviceId, "mic-2");
		});

		await st.step("rejects an open overtaken by close as aborted", async () => {
			const fake = new FakeMediaDevices(devices);
			const prompt = Promise.withResolvers<void>();
			fake.answer = prompt.promise;
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			const opening = mic.getAudioTrack();
			mic.close();

			prompt.resolve();

			const error = await assertRejects(() => opening, MicrophoneError);
			assertEquals(error.reason, "aborted");
		});

		await st.step("rejects a refused open overtaken by switchDevice as aborted", async () => {
			const fake = new FakeMediaDevices(devices);
			const prompt = Promise.withResolvers<void>();
			fake.answer = prompt.promise;
			fake.failure = new DOMException("Permission denied", "NotAllowedError");
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			const opening = mic.getAudioTrack();
			await mic.switchDevice("mic-2");

			prompt.resolve();

			const error = await assertRejects(() => opening, MicrophoneError);
			assertEquals(error.reason, "aborted");
		});

		await st.step("rejects a timed-out open overtaken by close as aborted", async () => {
			const fake = new FakeMediaDevices(devices);
			fake.answer = new Promise(() => {});
			const clock = new FakeClock();
			const context = new MediaDeviceContext({ mediaDevices: fake, clock });
			const mic = new Microphone(context, { enabled: true });
			const opening = mic.getAudioTrack();
			mic.close();

			clock.fire();

			const error = await assertRejects(() => opening, MicrophoneError);
			assertEquals(error.reason, "aborted");
		});

		await st.step("rejects an open overtaken by disabling as aborted", async () => {
			const fake = new FakeMediaDevices(devices);
			const prompt = Promise.withResolvers<void>();
			fake.answer = prompt.promise;
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			const opening = mic.getAudioTrack();
			mic.enabled = false;

			prompt.resolve();

			const error = await assertRejects(() => opening, MicrophoneError);
			assertEquals(error.reason, "aborted");
		});

		await st.step(
			"rejects an open overtaken by a new preferred device as aborted",
			async () => {
				const fake = new FakeMediaDevices(devices);
				const prompt = Promise.withResolvers<void>();
				fake.answer = prompt.promise;
				const context = new MediaDeviceContext({ mediaDevices: fake });
				const mic = new Microphone(context, { enabled: true });
				const opening = mic.getAudioTrack();
				mic.preferred = "mic-2";

				prompt.resolve();

				const error = await assertRejects(() => opening, MicrophoneError);
				assertEquals(error.reason, "aborted");
			},
		);

		await st.step("waits for a slow microphone once permission is granted", async () => {
			const fake = new FakeMediaDevices(devices);
			const clock = new FakeClock();
			const context = new MediaDeviceContext({ mediaDevices: fake, clock });
			await context.requestPermission("audio");
			const mic = new Microphone(context, { enabled: true });
			const waking = Promise.withResolvers<void>();
			fake.answer = waking.promise;
			const opening = mic.getAudioTrack();
			clock.fire();

			waking.resolve();

			assertEquals((await opening).readyState, "live");
		});
	});

	await t.step("track ended", async (st) => {
		await st.step("reports a track that ended to onTrackEnded", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const reasons: string[] = [];
			const mic = new Microphone(context, {
				enabled: true,
				onTrackEnded: (reason) => reasons.push(reason),
			});
			await mic.getAudioTrack();

			fake.granted[0]?.end();

			assertEquals(reasons, ["Device disconnected or track ended"]);
		});

		await st.step("opens a new track after the live one ended", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			const ended = await mic.getAudioTrack();
			fake.granted[0]?.end();

			const track = await mic.getAudioTrack();

			assertEquals(track !== ended && track.readyState === "live", true);
		});
	});

	await t.step("activeDeviceId", async (st) => {
		// The browser opens mic-1; the system default then moves to mic-2.
		const movedToUsb = [
			...devices,
			{
				kind: "audioinput" as MediaDeviceKind,
				label: "Default - External USB Mic",
				deviceId: "default",
			},
		];

		await st.step("names the live track's device when the default moves", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			await mic.getAudioTrack();
			fake.setDevices(movedToUsb);

			await context.updateDevices();

			assertEquals(mic.activeDeviceId, "mic-1");
		});

		await st.step("names the default again once the live track ended", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			await mic.getAudioTrack();
			fake.setDevices(movedToUsb);
			await context.updateDevices();

			fake.granted[0]?.end();

			assertEquals(mic.activeDeviceId, "mic-2");
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

		await st.step("rejects a track asked for after close", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });
			await mic.getAudioTrack();
			mic.close();

			await assertRejects(() => mic.getAudioTrack(), Error, "Microphone is closed");
		});
	});

	await t.step("Integration scenarios", async (st) => {
		await st.step("hands back the live track once enabled again", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, { enabled: true });

			const track = await mic.getAudioTrack();
			mic.enabled = false;
			await assertRejects(() => mic.getAudioTrack(), Error, "Microphone is not enabled");

			mic.enabled = true;
			const again = await mic.getAudioTrack();

			assertEquals(again === track, true);
		});

		await st.step("constraints updates", async () => {
			const fake = new FakeMediaDevices(devices);
			const context = new MediaDeviceContext({ mediaDevices: fake });
			const mic = new Microphone(context, {
				enabled: true,
				constraints: { echoCancellation: true },
			});

			const track = await mic.getAudioTrack();
			assertEquals(track.getConstraints(), { echoCancellation: true });

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

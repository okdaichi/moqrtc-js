import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { MediaDeviceContext } from "./device.ts";
import { setupFakeMediaDevices } from "./fake_media_devices.ts";
import { Microphone } from "./microphone.ts";

const devices = [
        { kind: "audioinput" as MediaDeviceKind, label: "Built-in Microphone", deviceId: "mic-1" },
        { kind: "audioinput" as MediaDeviceKind, label: "External USB Mic", deviceId: "mic-2" },
];

Deno.test("Microphone", async (t) => {
        await t.step("constructor", async (st) => {
                await st.step("creates microphone with default props", () => {
                        using _fakeMap = setupFakeMediaDevices(devices);
                        const context = new MediaDeviceContext();
                        const mic = new Microphone(context);

                        assertEquals(mic.kind, "audio");
                        assertEquals(mic.enabled, false);
                        assertEquals(mic.preferred, undefined);
                        assertEquals(mic.activeDeviceId, undefined);
                        assertEquals(mic.constraints, undefined);
                });

                await st.step("creates microphone with options", () => {
                        using _fakeMap = setupFakeMediaDevices(devices);
                        const context = new MediaDeviceContext();
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
                        using _fakeMap = setupFakeMediaDevices(devices);
                        const context = new MediaDeviceContext();
                        const mic = new Microphone(context, { enabled: true });

                        const track = await mic.getAudioTrack();
                        assertExists(track);
                        assertEquals(track.kind, "audio");
                        assertEquals(track.readyState, "live");
                });

                await st.step("gets audio track with constraints", async () => {
                        using _fakeMap = setupFakeMediaDevices(devices);
                        const context = new MediaDeviceContext();
                        const constraints = { echoCancellation: true, noiseSuppression: true };
                        const mic = new Microphone(context, {
                                enabled: true,
                                constraints,
                        });

                        const track = await mic.getAudioTrack();
                        assertExists(track);
                        assertEquals(track.getConstraints(), constraints);
                });

                await st.step("returns cached track on subsequent calls", async () => {
                        using _fakeMap = setupFakeMediaDevices(devices);
                        const context = new MediaDeviceContext();
                        const mic = new Microphone(context, { enabled: true });

                        const track1 = await mic.getAudioTrack();
                        const track2 = await mic.getAudioTrack();

                        assertEquals(track1, track2);
                });

                await st.step("throws when microphone not enabled", async () => {
                        using _fakeMap = setupFakeMediaDevices(devices);
                        const context = new MediaDeviceContext();
                        const mic = new Microphone(context, { enabled: false });

                        await assertRejects(
                                () => mic.getAudioTrack(),
                                Error,
                                "Microphone is not enabled",
                        );
                });

                await st.step("throws when device fails to get track", async () => {
                        using _fakeMap = setupFakeMediaDevices([]); // No devices
                        const context = new MediaDeviceContext();
                        const mic = new Microphone(context, { enabled: true });

                        await assertRejects(
                                () => mic.getAudioTrack(),
                                Error,
                                "NotFoundError",
                        );
                });
        });

        await t.step("close", async (st) => {
                await st.step("stops track and closes device when track exists", async () => {
                        using _fakeMap = setupFakeMediaDevices(devices);
                        const context = new MediaDeviceContext();
                        const mic = new Microphone(context, { enabled: true });

                        const track = await mic.getAudioTrack();
                        assertEquals(track.readyState, "live");

                        mic.close();

                        assertEquals(track.readyState, "ended");
                });

                await st.step("clears track reference after closing", async () => {
                        using _fakeMap = setupFakeMediaDevices(devices);
                        const context = new MediaDeviceContext();
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
                        using _fakeMap = setupFakeMediaDevices(devices);
                        const context = new MediaDeviceContext();
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
                        using _fakeMap = setupFakeMediaDevices(devices);
                        const context = new MediaDeviceContext();
                        const mic = new Microphone(context, { enabled: true, constraints: { echoCancellation: true } });

                        const track = await mic.getAudioTrack();
                        assertEquals(track.getConstraints(), { echoCancellation: true });

                        await mic.updateConstraints({ echoCancellation: false, noiseSuppression: true });
                        const updatedTrack = await mic.getAudioTrack();

                        // updateConstraints applies to existing track
                        assertEquals(updatedTrack.getConstraints(), { echoCancellation: false, noiseSuppression: true });
                        assertEquals(updatedTrack === track, true);
                        assertEquals(track.readyState, "live");
                });
        });
});

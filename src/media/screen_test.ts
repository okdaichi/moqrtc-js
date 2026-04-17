import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { setupFakeMediaDevices } from "./fake_media_devices.ts";
import { Screen } from "./screen.ts";

Deno.test("Screen", async (t) => {
        await t.step("constructor", async (st) => {
                await st.step("creates screen with default props", () => {
                        const screen = new Screen();
                        assertEquals(screen.enabled, false);
                        assertEquals(screen.constraints, undefined);
                });

                await st.step("creates screen with options", () => {
                        const constraints = { video: { cursor: "always" } as any, audio: true };
                        const screen = new Screen({ enabled: true, constraints });
                        assertEquals(screen.enabled, true);
                        assertEquals(screen.constraints, constraints);
                });
        });

        await t.step("getVideoTrack", async (st) => {
                await st.step("returns video track when enabled", async () => {
                        using _fakeMap = setupFakeMediaDevices([]);
                        const screen = new Screen({ enabled: true });
                        const track = await screen.getVideoTrack();
                        assertExists(track);
                        assertEquals(track.kind, "video");
                        assertEquals(track.label, "Screen");
                });

                await st.step("returns cached track on subsequent calls", async () => {
                        using _fakeMap = setupFakeMediaDevices([]);
                        const screen = new Screen({ enabled: true });
                        const track1 = await screen.getVideoTrack();
                        const track2 = await screen.getVideoTrack();
                        assertEquals(track1, track2, "Should return cached track");
                });

                await st.step("throws when not enabled", async () => {
                        using _fakeMap = setupFakeMediaDevices([]);
                        const screen = new Screen({ enabled: false });
                        await assertRejects(
                                () => screen.getVideoTrack(),
                                Error,
                                "Screen capture is not enabled",
                        );
                });
        });

        await t.step("getAudioTrack", async (st) => {
                await st.step("returns audio track if requested via constraints", async () => {
                        using _fakeMap = setupFakeMediaDevices([]);
                        const screen = new Screen({ enabled: true, constraints: { audio: true } });
                        const audioTrack = await screen.getAudioTrack();
                        assertExists(audioTrack);
                        assertEquals(audioTrack.kind, "audio");
                        assertEquals(audioTrack.label, "System Audio");
                });

                await st.step("returns undefined if not requested via constraints", async () => {
                        using _fakeMap = setupFakeMediaDevices([]);
                        const screen = new Screen({ enabled: true, constraints: { audio: false } });
                        const audioTrack = await screen.getAudioTrack();
                        assertEquals(audioTrack, undefined);
                });
        });

        await t.step("close", async (st) => {
                await st.step("stops all tracks when closing", async () => {
                        using _fakeMap = setupFakeMediaDevices([]);
                        const screen = new Screen({ enabled: true, constraints: { audio: true } });

                        const video = await screen.getVideoTrack();
                        const audio = await screen.getAudioTrack();

                        assertEquals(video.readyState, "live");
                        assertEquals(audio?.readyState, "live");

                        await screen.close();

                        assertEquals(video.readyState, "ended");
                        assertEquals(audio?.readyState, "ended");
                });

                await st.step("clears track references", async () => {
                        using _fakeMap = setupFakeMediaDevices([]);
                        const screen = new Screen({ enabled: true });
                        const video1 = await screen.getVideoTrack();
                        
                        await screen.close();
                        const video2 = await screen.getVideoTrack(); // requests new stream
                        
                        assertExists(video2);
                        assertEquals(video2.readyState, "live");
                        assertEquals(video1 !== video2, true);
                });
        });
});

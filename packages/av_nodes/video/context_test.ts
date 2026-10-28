import { assert, assertEquals } from "@std/assert";
import { VideoContext } from "./context.ts";

// VideoContext._admitFrame is the frame-rate cap every source passes through.
// Frames are taken as they arrive; the cap has half a frame of slack so a
// source whose frames come a few ms early or late keeps its own rate.

/** Frame times (ms) of an `fps` source over `seconds`, each shifted by `jitterMs(i)`. */
function frameTimes(fps: number, seconds: number, jitterMs: (i: number) => number): number[] {
	const gap = 1000 / fps;
	return Array.from({ length: fps * seconds }, (_, i) => 1000 + i * gap + jitterMs(i));
}

function admitted(context: VideoContext, times: number[]): number {
	return times.filter((at) => context._admitFrame(at)).length;
}

Deno.test("VideoContext._admitFrame", async (t) => {
	await t.step("keeps every frame of a jittery source at the frame rate", () => {
		const context = new VideoContext({ frameRate: 30 });
		// 4 ms early and late in turn: well inside half a frame (16.7 ms).
		const times = frameTimes(30, 10, (i) => (i % 2 === 0 ? -4 : 4));
		assertEquals(admitted(context, times), times.length);
	});

	await t.step("thins a faster source to the frame rate", () => {
		const context = new VideoContext({ frameRate: 30 });
		const kept = admitted(context, frameTimes(60, 10, () => 0));
		assert(kept >= 299 && kept <= 301, `kept ${kept} of 600`);
	});

	await t.step("does not burst after the source stalls", () => {
		const context = new VideoContext({ frameRate: 30 });
		assertEquals(admitted(context, frameTimes(30, 1, () => 0)), 30);
		// A one-second stall, then frames at twice the rate.
		const after = frameTimes(60, 1, () => 0).map((at) => at + 2000);
		const kept = admitted(context, after);
		assert(kept <= 31, `kept ${kept} in the second after the stall`);
	});

	await t.step("admits nothing while suspended, and starts over on resume", async () => {
		const context = new VideoContext({ frameRate: 30 });
		assert(context._admitFrame(1000));
		await context.suspend();
		assertEquals(context._admitFrame(1100), false);
		await context.resume();
		// Pacing restarts: the first frame after resume passes at once.
		assert(context._admitFrame(1101));
		await context.close();
	});
});

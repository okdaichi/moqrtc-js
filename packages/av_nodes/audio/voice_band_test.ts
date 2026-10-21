import { assertEquals, assertGreaterOrEqual, assertLessOrEqual } from "@std/assert";
import { VoiceBandFilter } from "./voice_band.ts";
import { levelDb } from "./voice_detector.ts";

const RATE = 48_000;

/** The level (dBFS) a full-scale sine at `hz` keeps through the filter, once settled. */
function passed(hz: number): number {
	const filter = new VoiceBandFilter(RATE);
	const input = new Float32Array(RATE / 2); // half a second
	for (let i = 0; i < input.length; i++) input[i] = Math.sin(2 * Math.PI * hz * i / RATE);
	const output = new Float32Array(input.length);

	filter.process(input, output);

	// The second half, after the filter has settled; a full-scale sine is -3 dB.
	return Math.round(levelDb(output.subarray(output.length / 2)) + 3);
}

Deno.test("VoiceBandFilter keeps the voice band", () => {
	for (const hz of [500, 1000, 2000]) {
		assertGreaterOrEqual(passed(hz), -1, `${hz} Hz`);
	}
});

Deno.test("VoiceBandFilter cuts hum and rumble", () => {
	for (const hz of [50, 60, 100]) {
		assertLessOrEqual(passed(hz), -15, `${hz} Hz`);
	}
});

Deno.test("VoiceBandFilter cuts hiss", () => {
	for (const hz of [10_000, 15_000]) {
		assertLessOrEqual(passed(hz), -15, `${hz} Hz`);
	}
});

Deno.test("VoiceBandFilter is -3 dB at its edges", () => {
	assertEquals([passed(300), passed(3400)], [-3, -3]);
});

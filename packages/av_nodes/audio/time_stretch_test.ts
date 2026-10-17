import {
	assertAlmostEquals,
	assertEquals,
	assertGreater,
	assertLess,
	assertLessOrEqual,
} from "@std/assert";
import { insertSegment, removeSegment, TimeStretcher } from "./time_stretch.ts";

const SAMPLE_RATE = 48000;
const MIN_LAG = 120; // 2.5 ms
const MAX_LAG = 720; // 15 ms
const OVERLAP = 480; // 10 ms
const AMPLITUDE = 0.5;
const LENGTH = 9600; // 200 ms

// A sum of harmonics of `frequency`: amplitude and phase per harmonic.
interface Tone {
	readonly frequency: number;
	readonly harmonics: readonly { readonly amplitude: number; readonly phase: number }[];
}

const SINE_440: Tone = { frequency: 440, harmonics: [{ amplitude: AMPLITUDE, phase: 0.3 }] };
const SINE_150: Tone = { frequency: 150, harmonics: [{ amplitude: AMPLITUDE, phase: 1.1 }] };
// A voiced-speech-like signal: a 200 Hz fundamental with falling harmonics.
const HARMONIC_200: Tone = {
	frequency: 200,
	harmonics: [
		{ amplitude: 0.3, phase: 0 },
		{ amplitude: 0.15, phase: 0.7 },
		{ amplitude: 0.08, phase: 2.1 },
		{ amplitude: 0.04, phase: 4.0 },
	],
};

function sampleOf(tone: Tone, frame: number): number {
	let sum = 0;
	tone.harmonics.forEach((h, i) => {
		sum += h.amplitude *
			Math.sin(2 * Math.PI * tone.frequency * (i + 1) * frame / SAMPLE_RATE + h.phase);
	});
	return sum;
}

function render(tone: Tone, length: number): Float32Array {
	return Float32Array.from({ length }, (_, frame) => sampleOf(tone, frame));
}

function period(tone: Tone): number {
	return SAMPLE_RATE / tone.frequency;
}

// Distance (frames) from `lag` to the nearest whole number of periods.
function offPeriod(lag: number, periodFrames: number): number {
	const periods = Math.max(1, Math.round(lag / periodFrames));
	return Math.abs(lag - periods * periodFrames);
}

// Largest second difference |x[n+1] - 2x[n] + x[n-1]| over [from, to): a
// discontinuity in the waveform or its slope stands out against a smooth
// signal's.
function largestSecondDifference(signal: Float32Array, from: number, to: number): number {
	let max = 0;
	for (let n = Math.max(1, from); n < Math.min(to, signal.length - 1); n++) {
		const d = (signal[n + 1] ?? 0) - 2 * (signal[n] ?? 0) + (signal[n - 1] ?? 0);
		max = Math.max(max, Math.abs(d));
	}
	return max;
}

// Smallest peak level of any whole period window over [from, to): a dip
// where two out-of-phase stretches were crossfaded stands out.
function smallestPeak(
	signal: Float32Array,
	from: number,
	to: number,
	periodFrames: number,
): number {
	const width = Math.ceil(periodFrames);
	let min = Infinity;
	for (let start = from; start + width <= to; start += 8) {
		let peak = 0;
		for (let n = start; n < start + width; n++) peak = Math.max(peak, Math.abs(signal[n] ?? 0));
		min = Math.min(min, peak);
	}
	return min;
}

// Deterministic pseudo-random numbers in [0, 1).
function random(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let x = Math.imul(s ^ (s >>> 15), 1 | s);
		x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

// Removes the best-matching segment before `end` from a rendering of
// `tone`, as the playback worklet lowers its delay. Returns the result, the
// lag removed and where the seam starts.
function accelerate(tone: Tone, end: number) {
	const stretcher = new TimeStretcher(SAMPLE_RATE);
	const signal = render(tone, LENGTH);
	const at = end - MAX_LAG - OVERLAP;
	const lag = stretcher.findLag(signal, at, 1, MAX_LAG, OVERLAP);
	removeSegment(signal, at, lag, OVERLAP, end);
	return { signal, lag, at };
}

// Repeats the best-matching segment before `end` in a rendering of `tone`
// that stops there, then lets the tone go on after the repetition, as the
// playback worklet raises its delay. Returns the result and the lag added.
function expand(tone: Tone, end: number) {
	const stretcher = new TimeStretcher(SAMPLE_RATE);
	const clean = render(tone, LENGTH);
	const signal = new Float32Array(LENGTH + MAX_LAG);
	signal.set(clean.subarray(0, end));
	const lag = stretcher.findLag(signal, end - OVERLAP, -1, MAX_LAG, OVERLAP);
	insertSegment(signal, end, lag, OVERLAP);
	signal.set(clean.subarray(end), end + lag);
	return { signal: signal.subarray(0, LENGTH + lag), lag };
}

const TONES = [
	{ name: "a 440 Hz sine", tone: SINE_440 },
	{ name: "a 150 Hz sine", tone: SINE_150 },
	{ name: "a 200 Hz harmonic signal", tone: HARMONIC_200 },
] as const;

// No second difference may exceed the clean signal's by more than this
// factor.
const SMOOTHNESS = 1.1;

Deno.test("TimeStretcher.findLag", async (t) => {
	const directions = [
		{ name: "forwards", direction: 1, at: 2000 },
		{ name: "backwards", direction: -1, at: 4000 },
	] as const;
	for (const c of TONES) {
		for (const d of directions) {
			await t.step(
				`finds a whole number of periods of ${c.name}, searching ${d.name}`,
				() => {
					const stretcher = new TimeStretcher(SAMPLE_RATE);
					const signal = render(c.tone, LENGTH);

					const lag = stretcher.findLag(signal, d.at, d.direction, MAX_LAG, OVERLAP);

					assertLessOrEqual(offPeriod(lag, period(c.tone)), 0.5);
				},
			);
		}
	}

	await t.step("returns the longest lag for silence", () => {
		const stretcher = new TimeStretcher(SAMPLE_RATE);

		const lag = stretcher.findLag(new Float32Array(LENGTH), 2000, 1, 600, OVERLAP);

		assertEquals(lag, 600);
	});

	await t.step("caps the lag at the stretcher's longest", () => {
		const stretcher = new TimeStretcher(SAMPLE_RATE);

		const lag = stretcher.findLag(new Float32Array(LENGTH), 2000, 1, 5000, OVERLAP);

		assertEquals(lag, MAX_LAG);
	});

	await t.step("searches lags from 2.5 to 15 ms with a 10 ms overlap", () => {
		const stretcher = new TimeStretcher(SAMPLE_RATE);

		assertEquals(
			[stretcher.minLag, stretcher.maxLag, stretcher.overlap],
			[MIN_LAG, MAX_LAG, OVERLAP],
		);
	});

	await t.step("reads a ring across its end", () => {
		const stretcher = new TimeStretcher(SAMPLE_RATE);
		const ring = new Float32Array(LENGTH);
		// The tone from frame LENGTH - 1000 on, wrapping to the start.
		for (let f = 0; f < LENGTH; f++) ring[(LENGTH - 1000 + f) % LENGTH] = sampleOf(SINE_150, f);

		const lag = stretcher.findLag(ring, LENGTH - 1000, 1, MAX_LAG, OVERLAP);

		assertEquals(lag % 320, 0);
	});
});

Deno.test("removeSegment", async (t) => {
	const END = 6000;
	for (const c of TONES) {
		await t.step(`shortens ${c.name} without a discontinuity`, () => {
			const clean = render(c.tone, LENGTH);

			const { signal, lag } = accelerate(c.tone, END);

			assertLessOrEqual(
				largestSecondDifference(signal, 1, END - lag - 1),
				SMOOTHNESS * largestSecondDifference(clean, 1, LENGTH),
			);
		});

		await t.step(`keeps the level of ${c.name} through the seam`, () => {
			const clean = render(c.tone, LENGTH);

			const { signal, lag, at } = accelerate(c.tone, END);

			assertGreater(
				smallestPeak(signal, at - 200, at + OVERLAP + 200, period(c.tone)),
				0.97 * smallestPeak(clean, 0, LENGTH - lag, period(c.tone)),
			);
		});

		await t.step(`moves the audio of ${c.name} after the seam up by the lag`, () => {
			const clean = render(c.tone, LENGTH);

			const { signal, lag, at } = accelerate(c.tone, END);

			assertEquals(
				signal.subarray(at + OVERLAP, END - lag),
				clean.subarray(at + OVERLAP + lag, END),
			);
		});
	}

	await t.step("leaves the audio before the seam as it was", () => {
		const clean = render(SINE_440, LENGTH);

		const { signal, at } = accelerate(SINE_440, END);

		assertEquals(signal.subarray(0, at), clean.subarray(0, at));
	});

	// Controls: the checks above catch a seam that does not match.
	await t.step("dips in level at a crossfade half a period out of phase", () => {
		const clean = render(SINE_150, LENGTH);
		const signal = render(SINE_150, LENGTH);
		const at = 2000;

		removeSegment(signal, at, 160, OVERLAP, END);

		assertLess(
			smallestPeak(signal, at, at + OVERLAP, period(SINE_150)),
			0.97 * smallestPeak(clean, 0, LENGTH, period(SINE_150)),
		);
	});

	await t.step("breaks the waveform at a cut half a period out of phase", () => {
		const clean = render(SINE_150, LENGTH);
		const signal = render(SINE_150, LENGTH);

		removeSegment(signal, 2000, 160, 0, END);

		assertGreater(
			largestSecondDifference(signal, 1, END - 161),
			SMOOTHNESS * largestSecondDifference(clean, 1, LENGTH),
		);
	});
});

Deno.test("insertSegment", async (t) => {
	const END = 6000;
	for (const c of TONES) {
		await t.step(`lengthens ${c.name} without a discontinuity`, () => {
			const clean = render(c.tone, LENGTH);

			const { signal } = expand(c.tone, END);

			assertLessOrEqual(
				largestSecondDifference(signal, 1, signal.length),
				SMOOTHNESS * largestSecondDifference(clean, 1, LENGTH),
			);
		});

		await t.step(`keeps the level of ${c.name} through the seam`, () => {
			const clean = render(c.tone, LENGTH);

			const { signal, lag } = expand(c.tone, END);

			assertGreater(
				smallestPeak(signal, END - OVERLAP - 200, END + lag + 200, period(c.tone)),
				0.97 * smallestPeak(clean, 0, LENGTH, period(c.tone)),
			);
		});
	}

	await t.step("repeats the lag before the end after it", () => {
		const signal = render(SINE_440, LENGTH);
		const before = signal.slice(4000, 4100);

		insertSegment(signal, 4100, 100, OVERLAP);

		assertEquals(signal.subarray(4100, 4200), before);
	});

	await t.step("leaves the audio before the overlap as it was", () => {
		const clean = render(SINE_440, LENGTH);

		const { signal } = expand(SINE_440, END);

		assertEquals(signal.subarray(0, END - OVERLAP), clean.subarray(0, END - OVERLAP));
	});

	await t.step("crossfades a lag shorter than the overlap from unchanged audio", () => {
		// A lag of 120 frames: the overlap's sources lie partly inside it.
		const signal = render(SINE_150, LENGTH);
		const end = 4000;
		const expected = sampleOf(SINE_150, end - 1) * (1 / (OVERLAP + 1)) +
			sampleOf(SINE_150, end - 1 - 120) * (OVERLAP / (OVERLAP + 1));

		insertSegment(signal, end, 120, OVERLAP);

		assertAlmostEquals(signal[end - 1] ?? NaN, expected, 1e-6);
	});
});

Deno.test("time stretching random periodic signals", async (t) => {
	const next = random(11);
	const cases = Array.from({ length: 40 }, (_, i) => {
		const periodFrames = Math.round(MIN_LAG + next() * (MAX_LAG - MIN_LAG));
		const tone: Tone = {
			frequency: SAMPLE_RATE / periodFrames,
			harmonics: Array.from({ length: 4 }, (_, h) => ({
				amplitude: (0.1 + 0.3 * next()) / (h + 1),
				phase: 2 * Math.PI * next(),
			})),
		};
		return {
			name: `case ${i}, period ${periodFrames}`,
			tone,
			end: 4000 + Math.floor(next() * 3000),
		};
	});

	for (const c of cases) {
		await t.step(`${c.name}: removes whole periods without a discontinuity`, () => {
			const clean = render(c.tone, LENGTH);

			const { signal, lag } = accelerate(c.tone, c.end);

			assertLessOrEqual(offPeriod(lag, period(c.tone)), 1);
			assertLessOrEqual(
				largestSecondDifference(signal, 1, c.end - lag - 1),
				SMOOTHNESS * largestSecondDifference(clean, 1, LENGTH),
			);
		});

		await t.step(`${c.name}: repeats whole periods without a discontinuity`, () => {
			const clean = render(c.tone, LENGTH);

			const { signal, lag } = expand(c.tone, c.end);

			assertLessOrEqual(offPeriod(lag, period(c.tone)), 1);
			assertLessOrEqual(
				largestSecondDifference(signal, 1, signal.length),
				SMOOTHNESS * largestSecondDifference(clean, 1, LENGTH),
			);
		});
	}
});

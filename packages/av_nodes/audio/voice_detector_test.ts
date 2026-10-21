import { assertEquals } from "@std/assert";
import {
	DEFAULT_VOICE_DETECTOR_OPTIONS,
	isVoiceDetectorOptions,
	levelDb,
	VoiceDetector,
} from "./voice_detector.ts";
import shared from "./voice_detector_cases.json" with { type: "json" };

interface Run {
	readonly startMs: number;
	readonly stepMs: number;
	readonly levels?: readonly (number | null)[];
	readonly repeat?: { readonly level: number | null; readonly count: number };
}

type Expectation =
	| { readonly at: number; readonly heard: boolean }
	| { readonly never: true }
	| { readonly always: true };

interface Case {
	readonly name: string;
	readonly runs: readonly Run[];
	readonly expect: readonly Expectation[];
}

const levelsOf = (run: Run): number[] =>
	(run.levels ?? Array(run.repeat?.count ?? 0).fill(run.repeat?.level ?? null)).map((db) =>
		db === null ? -Infinity : db
	);

/** Plays every run into one detector; returns what the last run heard. */
function play(c: Case): boolean[] {
	const detector = new VoiceDetector();
	let heard: boolean[] = [];
	for (const run of c.runs) {
		heard = levelsOf(run).map((db, i) => detector.update(db, run.startMs + i * run.stepMs));
	}
	return heard;
}

for (const c of shared.cases as Case[]) {
	Deno.test(`VoiceDetector: ${c.name}`, () => {
		const heard = play(c);

		for (const e of c.expect) {
			if ("never" in e) assertEquals(heard.includes(true), false, "heard at some point");
			else if ("always" in e) assertEquals(heard.includes(false), false, "went dark");
			else assertEquals(heard.at(e.at), e.heard, `reading ${e.at}`);
		}
	});
}

Deno.test("levelDb is 0 dB at full scale and -Infinity in silence", () => {
	const cases = [
		{ name: "full scale", samples: [1, -1, 1, -1], db: 0 },
		{ name: "half scale", samples: [0.5, -0.5], db: -6.02 },
		{ name: "silence", samples: [0, 0, 0], db: -Infinity },
		{ name: "no samples", samples: [], db: -Infinity },
	];
	for (const c of cases) {
		const db = levelDb(new Float32Array(c.samples));
		assertEquals(Number.isFinite(db) ? Math.round(db * 100) / 100 : db, c.db, c.name);
	}
});

Deno.test("reset forgets the voice and measures the room afresh", () => {
	const detector = new VoiceDetector();
	for (let i = 0; i < 10; i++) detector.update(-70, i * 100);
	for (let i = 0; i < 3; i++) detector.update(-30, 1000 + i * 100);

	detector.reset();

	assertEquals([detector.heard, detector.update(-40, 5000)], [false, false]);
});

Deno.test("isVoiceDetectorOptions accepts what can work and refuses the rest", () => {
	const ok = DEFAULT_VOICE_DETECTOR_OPTIONS;
	const cases: { name: string; options: unknown; valid: boolean }[] = [
		{ name: "defaults", options: ok, valid: true },
		{ name: "equal thresholds", options: { ...ok, offDb: ok.onDb }, valid: true },
		{ name: "stop above start", options: { ...ok, offDb: ok.onDb + 1 }, valid: false },
		{ name: "negative hold", options: { ...ok, holdMs: -1 }, valid: false },
		{ name: "falling floor", options: { ...ok, floorRiseDbPerSec: -1 }, valid: false },
		{ name: "not finite", options: { ...ok, minDb: Number.NaN }, valid: false },
		{ name: "missing field", options: { onDb: 9 }, valid: false },
		{ name: "not an object", options: "loud", valid: false },
	];
	for (const c of cases) {
		assertEquals(isVoiceDetectorOptions(c.options), c.valid, c.name);
	}
});

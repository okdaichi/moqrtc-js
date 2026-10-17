/// <reference path="../../../src/test_globals.d.ts" />
import {
	assert,
	assertAlmostEquals,
	assertEquals,
	assertExists,
	assertGreater,
	assertGreaterOrEqual,
	assertLess,
	assertLessOrEqual,
	assertThrows,
} from "@std/assert";
import type { AudioPlayoutStats } from "./audio_playback_stats.ts";
import { importWorkletUrl } from "./audio_offload_worklet.ts";
import {
	type FakeProcessorPort,
	setupFakeAudioWorkletEnvironment,
} from "./fake_audio_worklet_environment_test.ts";

type AudioOffloadProcessorInstance = {
	append(channels: readonly Float32Array[], tsUs: number): void;
	stats(): AudioPlayoutStats;
	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
	port: FakeProcessorPort;
};

type AudioOffloadProcessorConstructor = new (
	options: AudioWorkletNodeOptions,
) => AudioOffloadProcessorInstance;

// Deterministic timing constants for the scheduling tests.
// sampleRate 48000, latency 80ms → a 3840-frame cushion, a multiple of the
// 128-frame render quantum, so block boundaries line up with quantum
// boundaries and assertions are exact.
const SAMPLE_RATE = 48000;
const LATENCY_MS = 80;
const LAG_SAMPLES = 3840; // ceil(48000 * 80 / 1000)
const QUANTUM = 128;
// microseconds per 128-sample block (≈2666.67), rounded so that consecutive
// 128-sample blocks map to consecutive 128-frame playout slots.
const BLOCK_US = Math.round(QUANTUM / SAMPLE_RATE * 1_000_000); // 2667
// Fades at every edge between audio and silence last this many frames.
const FADE_FRAMES = 144; // ceil(48000 * 3 / 1000)

// The real AudioOffloadProcessor: the worklet module evaluated once in a fake
// worklet scope, so the behavioural tests exercise the code that ships.
const OffloadProcessor = await (async () => {
	const env = setupFakeAudioWorkletEnvironment();
	try {
		await import("./audio_offload_worklet.ts?behaviour");
		return env.registerProcessorCalls[0]![1] as AudioOffloadProcessorConstructor;
	} finally {
		env.restore();
	}
})();

function createProcessor(
	options: { latency?: number; maxLatency?: number } = {},
): AudioOffloadProcessorInstance {
	return new OffloadProcessor({
		channelCount: 2,
		processorOptions: {
			sampleRate: SAMPLE_RATE,
			latency: options.latency ?? LATENCY_MS,
			maxLatency: options.maxLatency,
		},
	});
}

// A processor whose delay never moves from `latency`.
function createFixedProcessor(): AudioOffloadProcessorInstance {
	return createProcessor({ maxLatency: LATENCY_MS });
}

// Run `quanta` render quanta through `processor`, concatenating channel 0 of the
// output into one flat Float32Array of length quanta * QUANTUM.
function drain(processor: AudioOffloadProcessorInstance, quanta: number): Float32Array {
	const out = new Float32Array(quanta * QUANTUM);
	const left = new Float32Array(QUANTUM);
	const buffers = [[left, new Float32Array(QUANTUM)]];
	for (let q = 0; q < quanta; q++) {
		processor.process([], buffers);
		out.set(left, q * QUANTUM);
	}
	return out;
}

// Delivers `data` to the processor's port as a message.
function post(processor: AudioOffloadProcessorInstance, data: unknown): void {
	processor.port.onmessage?.(new MessageEvent("message", { data }));
}

// A block of `frames` samples of `value` on both channels.
function block(value: number, frames: number = QUANTUM): Float32Array[] {
	return [new Float32Array(frames).fill(value), new Float32Array(frames).fill(value)];
}

// Timestamp (µs) of media frame `frames`.
function ts(frames: number): number {
	return Math.round(frames * 1_000_000 / SAMPLE_RATE);
}

// Audio after an asserted region, so the fade-out ahead of the end of the
// written audio falls outside it.
function appendTail(processor: AudioOffloadProcessorInstance, frame: number): void {
	processor.append(block(0.5, 4 * QUANTUM), ts(frame));
}

function sampleAt(out: Float32Array, index: number): number {
	const sample = out[index];
	if (sample === undefined) throw new RangeError(`no sample ${index} in ${out.length}`);
	return sample;
}

function countOf(out: Float32Array, value: number): number {
	let count = 0;
	for (const sample of out) if (sample === value) count++;
	return count;
}

Deno.test("audio_offload_worklet", async (t) => {
	await t.step("provides a URL for the offload worklet", () => {
		const url = importWorkletUrl();
		assert(url.endsWith("audio_offload_worklet.js"));
	});

	await t.step(
		"registers the offload processor when AudioWorkletProcessor is defined",
		() => {
			const env = setupFakeAudioWorkletEnvironment();
			try {
				if (typeof AudioWorkletProcessor !== "undefined") {
					globalThis.registerProcessor(
						"audio-offloader",
						class extends AudioWorkletProcessor {
							process() {
								return true;
							}
						},
					);
				}
				assertEquals(env.registerProcessorCalls.length, 1);
				const [name, processorCtor] = env.registerProcessorCalls[0]!;
				assertEquals(name, "audio-offloader");
				assertEquals(typeof processorCtor, "function");
			} finally {
				env.restore();
			}
		},
	);

	await t.step(
		"does not register the offload processor when AudioWorkletProcessor is not defined",
		() => {
			const g = globalThis as unknown as Record<string, unknown>;
			const hasRegisterProcessor = Object.prototype.hasOwnProperty.call(
				g,
				"registerProcessor",
			);
			const originalRegisterProcessor = g.registerProcessor;
			const mockRegisterProcessor = { calls: [] as Parameters<typeof registerProcessor>[] };
			g.registerProcessor = (
				name: string,
				processor: Parameters<typeof registerProcessor>[1],
			) => {
				mockRegisterProcessor.calls.push([name, processor]);
			};

			try {
				if (typeof AudioWorkletProcessor !== "undefined") {
					globalThis.registerProcessor(
						"audio-offloader",
						class extends AudioWorkletProcessor {
							process() {
								return true;
							}
						},
					);
				}
				assertEquals(mockRegisterProcessor.calls.length, 0);
			} finally {
				if (hasRegisterProcessor) {
					g.registerProcessor = originalRegisterProcessor;
				} else {
					delete g.registerProcessor;
				}
			}
		},
	);

	await t.step("throws error in constructor for invalid options", () => {
		const env = setupFakeAudioWorkletEnvironment();
		try {
			globalThis.registerProcessor(
				"audio-offloader",
				class AudioOffloadProcessor extends AudioWorkletProcessor {
					constructor(options: AudioWorkletNodeOptions) {
						super();
						if (!options.processorOptions) {
							throw new Error("processorOptions is required");
						}
						const channelCount = options.channelCount;
						if (!channelCount || channelCount <= 0) {
							throw new Error("invalid channelCount");
						}
						const sampleRate = options.processorOptions.sampleRate;
						if (!sampleRate || sampleRate <= 0) {
							throw new Error("invalid sampleRate");
						}
						const latency = options.processorOptions.latency;
						if (!latency || latency <= 0) {
							throw new Error("invalid latency");
						}
					}
					append(_channels: Float32Array[], _tsUs: number): void {}
					process(): boolean {
						return true;
					}
				},
			);

			const ProcessorCtor = env
				.registerProcessorCalls[0]![1] as AudioOffloadProcessorConstructor;

			assertThrows(() => new ProcessorCtor({}), Error, "processorOptions is required");
			assertThrows(
				() => new ProcessorCtor({ processorOptions: {} }),
				Error,
				"invalid channelCount",
			);
			assertThrows(
				() => new ProcessorCtor({ channelCount: 2, processorOptions: {} }),
				Error,
				"invalid sampleRate",
			);
			assertThrows(
				() =>
					new ProcessorCtor({
						channelCount: 2,
						processorOptions: { sampleRate: 48000 },
					}),
				Error,
				"invalid latency",
			);
		} finally {
			env.restore();
		}
	});

	await t.step("exposes a port onmessage handler", () => {
		const processor = createProcessor();
		assertExists(processor.port.onmessage);
		assertEquals(typeof processor.process, "function");
		assertEquals(typeof processor.append, "function");
	});

	const invalidOptions = [
		{ name: "latency 0", latency: 0, maxLatency: undefined, message: "invalid latency" },
		{ name: "latency -1", latency: -1, maxLatency: undefined, message: "invalid latency" },
		{ name: "latency NaN", latency: NaN, maxLatency: undefined, message: "invalid latency" },
		{
			name: "latency Infinity",
			latency: Infinity,
			maxLatency: undefined,
			message: "invalid latency",
		},
		{ name: "maxLatency 0", latency: 80, maxLatency: 0, message: "invalid maxLatency" },
		{ name: "maxLatency NaN", latency: 80, maxLatency: NaN, message: "invalid maxLatency" },
		{
			name: "maxLatency Infinity",
			latency: 80,
			maxLatency: Infinity,
			message: "invalid maxLatency",
		},
		{
			name: "maxLatency below latency",
			latency: 80,
			maxLatency: 79,
			message: "invalid maxLatency",
		},
	] as const;
	for (const c of invalidOptions) {
		await t.step(`rejects ${c.name}`, () => {
			assertThrows(
				() => createProcessor({ latency: c.latency, maxLatency: c.maxLatency }),
				RangeError,
				c.message,
			);
		});
	}

	const validOptions = [
		{ name: "maxLatency equal to latency", latency: 80, maxLatency: 80 },
		{ name: "a 20 ms latency", latency: 20, maxLatency: undefined },
		{ name: "a latency above the default maxLatency", latency: 500, maxLatency: undefined },
	] as const;
	for (const c of validOptions) {
		await t.step(`starts at the latency with ${c.name}`, () => {
			const processor = createProcessor({ latency: c.latency, maxLatency: c.maxLatency });

			const stats = processor.stats();

			assertEquals(stats.targetDelayMs, c.latency);
		});
	}

	await t.step("process() with no outputs still advances the playback clock", () => {
		const processor = createProcessor();
		// A no-output quantum must still advance the clock, else a block arriving
		// next would be anchored to a stale frame and schedule into the past.
		assertEquals(processor.process([], []), true);
		processor.append(block(1), 0);
		appendTail(processor, QUANTUM);
		// originFrame captured the advanced frame (QUANTUM), so the block is due at
		// QUANTUM + LAG_SAMPLES. Drain the pre-roll then the block quantum.
		const out = drain(processor, LAG_SAMPLES / QUANTUM + 1);
		assertEquals(
			out.subarray(LAG_SAMPLES, LAG_SAMPLES + QUANTUM),
			new Float32Array(QUANTUM).fill(1),
		);
	});

	await t.step("handles empty/missing append without crashing", () => {
		const processor = createProcessor();
		processor.append([], 0);
		processor.append([new Float32Array(0)], 0);
		processor.append([null as unknown as Float32Array], 0);
		assertEquals(
			processor.process([], [[new Float32Array(1), new Float32Array(1)]]),
			true,
		);
	});

	await t.step("emits pre-roll silence before the first block", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		const out = drain(processor, LAG_SAMPLES / QUANTUM);
		assertEquals(out, new Float32Array(LAG_SAMPLES));
	});

	await t.step("absorbs a multi-frame burst with no gaps or drops", () => {
		// Three 128-sample blocks posted at once (burst), each scheduled one
		// quantum apart. They must emerge contiguously at their scheduled frames
		// with no silence between them.
		const processor = createProcessor();
		processor.append(
			[new Float32Array(QUANTUM).fill(1), new Float32Array(QUANTUM).fill(2)],
			0,
		);
		processor.append(
			[new Float32Array(QUANTUM).fill(3), new Float32Array(QUANTUM).fill(4)],
			BLOCK_US,
		);
		processor.append(
			[new Float32Array(QUANTUM).fill(5), new Float32Array(QUANTUM).fill(6)],
			2 * BLOCK_US,
		);
		appendTail(processor, 3 * QUANTUM);

		const totalQuanta = LAG_SAMPLES / QUANTUM + 3;
		const out = drain(processor, totalQuanta);

		const expect = new Float32Array(totalQuanta * QUANTUM);
		expect.fill(1, LAG_SAMPLES, LAG_SAMPLES + QUANTUM);
		expect.fill(3, LAG_SAMPLES + QUANTUM, LAG_SAMPLES + 2 * QUANTUM);
		expect.fill(5, LAG_SAMPLES + 2 * QUANTUM, LAG_SAMPLES + 3 * QUANTUM);
		assertEquals(out, expect);
	});

	// Two 512-frame blocks of 1 with a 512-frame gap between them, each
	// arriving when it is captured.
	const GAP_BLOCK = 4 * QUANTUM;
	function playAroundGap() {
		const processor = createProcessor();
		processor.append(block(1, GAP_BLOCK), 0);
		const before = drain(processor, 2 * GAP_BLOCK / QUANTUM);
		processor.append(block(1, GAP_BLOCK), ts(2 * GAP_BLOCK));
		const between = drain(processor, GAP_BLOCK / QUANTUM);
		appendTail(processor, 3 * GAP_BLOCK);
		const after = drain(processor, LAG_SAMPLES / QUANTUM);

		const out = new Float32Array(before.length + between.length + after.length);
		out.set(before);
		out.set(between, before.length);
		out.set(after, before.length + between.length);
		return {
			first: out.subarray(LAG_SAMPLES, LAG_SAMPLES + GAP_BLOCK),
			gap: out.subarray(LAG_SAMPLES + GAP_BLOCK, LAG_SAMPLES + 2 * GAP_BLOCK),
			second: out.subarray(LAG_SAMPLES + 2 * GAP_BLOCK, LAG_SAMPLES + 3 * GAP_BLOCK),
		};
	}

	await t.step("fades out the audio before a silence gap", () => {
		const { first } = playAroundGap();

		assertEquals(
			first.subarray(0, GAP_BLOCK - FADE_FRAMES),
			new Float32Array(GAP_BLOCK - FADE_FRAMES).fill(1),
		);
		assertAlmostEquals(sampleAt(first, GAP_BLOCK - 1), 1 / (FADE_FRAMES + 1), 1e-6);
	});

	await t.step("keeps a silence gap silent", () => {
		const { gap } = playAroundGap();

		assertEquals(gap, new Float32Array(GAP_BLOCK));
	});

	await t.step("fades in the audio after a silence gap", () => {
		const { second } = playAroundGap();

		assertAlmostEquals(sampleAt(second, 0), 1 / (FADE_FRAMES + 1), 1e-6);
		assertEquals(
			second.subarray(FADE_FRAMES),
			new Float32Array(GAP_BLOCK - FADE_FRAMES).fill(1),
		);
	});

	// A fixed-delay processor that played one block, ran two quanta dry, and
	// then got that block again (stale) and a fresh 512-frame block of 8 due now.
	function playStaleBlock() {
		const processor = createFixedProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 2);
		processor.append(block(42), 0);
		processor.append(block(8, 4 * QUANTUM), 2 * BLOCK_US);
		appendTail(processor, 6 * QUANTUM);
		return { processor, out: drain(processor, 4) };
	}

	await t.step("with a fixed delay, drops a stale (late) block", () => {
		const { processor, out } = playStaleBlock();

		assertEquals(countOf(out, 42), 0);
		assertEquals(processor.stats().droppedBlocks, 1);
	});

	await t.step("fades in the block after an underrun", () => {
		const { out } = playStaleBlock();

		assertLess(sampleAt(out, 0), 8);
		assertEquals(sampleAt(out, 4 * QUANTUM - 1), 8);
	});

	// A processor that played one block and ran dry, then got the next block one
	// quantum after its playout frame.
	function playLateBlock() {
		const processor = createProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 2);
		processor.append(block(42, 4 * QUANTUM), ts(QUANTUM));
		appendTail(processor, 5 * QUANTUM);
		return { processor, out: drain(processor, 20) };
	}

	await t.step("plays a late block instead of dropping it", () => {
		const { processor, out } = playLateBlock();

		// All of it but the fade-in.
		assertEquals(countOf(out, 42), 4 * QUANTUM - FADE_FRAMES);
		assertEquals(processor.stats().lateBlocks, 1);
	});

	await t.step("raises the delay to cover a late block", () => {
		const { processor } = playLateBlock();

		assertGreater(processor.stats().delayMs, LATENCY_MS);
	});

	await t.step("recovers from underrun when a future block arrives", () => {
		const processor = createProcessor();
		// No data at all for 10 quanta → pure silence.
		assertEquals(drain(processor, 10), new Float32Array(10 * QUANTUM));

		// A block arrives now; the cushion is anchored to the current frame, so it
		// is scheduled LAG_SAMPLES ahead of where playback already is.
		processor.append(block(5), 0);
		appendTail(processor, QUANTUM);
		const silenceBeforeBlock = LAG_SAMPLES / QUANTUM;
		assertEquals(
			drain(processor, silenceBeforeBlock),
			new Float32Array(silenceBeforeBlock * QUANTUM),
		);

		// The quantum containing the recovered block:
		const out = drain(processor, 1);
		assertEquals(out, new Float32Array(QUANTUM).fill(5));
	});

	await t.step("treats a missing source channel as silence for that block", () => {
		const processor = createProcessor();
		processor.append(
			[new Float32Array(QUANTUM).fill(1), undefined as unknown as Float32Array],
			0,
		);
		appendTail(processor, QUANTUM);
		// Drain pre-roll + the block quantum.
		const out = drain(processor, LAG_SAMPLES / QUANTUM + 1);
		assertEquals(
			out.subarray(LAG_SAMPLES, LAG_SAMPLES + QUANTUM),
			new Float32Array(QUANTUM).fill(1),
		);
	});

	await t.step("keeps a full cushion when the first block arrives late", () => {
		// If process() idles for a while before the first decode, the first block
		// must still play a full cushion later, not be dropped as stale.
		const processor = createProcessor();
		const idleQuanta = 20;
		assertEquals(drain(processor, idleQuanta), new Float32Array(idleQuanta * QUANTUM));

		processor.append(block(7), 0);
		appendTail(processor, QUANTUM);
		// Cushion measured from arrival, so the block is due a full LAG_SAMPLES
		// after the idle period, not at absolute LAG_SAMPLES.
		const silenceBeforeBlock = LAG_SAMPLES / QUANTUM;
		assertEquals(
			drain(processor, silenceBeforeBlock),
			new Float32Array(silenceBeforeBlock * QUANTUM),
		);
		const out = drain(processor, 1);
		assertEquals(out, new Float32Array(QUANTUM).fill(7));
	});

	// A block of 9 stamped 100 ms before the first: with a fixed 80 ms delay
	// its start is in the playback past and its end is not.
	const preBaseBlock = () => block(9, 2400);
	const PRE_BASE_TS = -100_000;

	const preBaseProcessors = [
		{ name: "an adaptive delay", create: createProcessor },
		{ name: "a fixed delay", create: createFixedProcessor },
	] as const;
	for (const c of preBaseProcessors) {
		await t.step(`with ${c.name}, accepts a pre-base (non-monotonic) timestamp`, () => {
			const processor = c.create();
			processor.append(block(1), 0);

			processor.append(preBaseBlock(), PRE_BASE_TS);

			assertEquals(processor.stats().receivedBlocks, 2);
		});
	}

	await t.step("with a fixed delay, plays the unplayed part of a partially late block", () => {
		const processor = createFixedProcessor();
		processor.append(block(1), 0);

		processor.append(preBaseBlock(), PRE_BASE_TS);

		assertEquals(drain(processor, 1), new Float32Array(QUANTUM).fill(9));
	});

	// A processor playing a long block of 1 when a block of 42, three
	// cushions ahead, makes it resync; then a block of 5 right after it.
	function playResync() {
		const processor = createProcessor();
		processor.append(block(1, 8 * QUANTUM), 0);
		const before = drain(processor, LAG_SAMPLES / QUANTUM + 2);
		const farFrame = 3 * LAG_SAMPLES;
		processor.append(block(42, 4 * QUANTUM), ts(farFrame));
		processor.append(block(5), ts(farFrame + 4 * QUANTUM));
		appendTail(processor, farFrame + 5 * QUANTUM);
		const after = drain(processor, LAG_SAMPLES / QUANTUM + 6);
		return { processor, before, after };
	}

	await t.step("resyncs to the live edge when a block runs a cushion ahead", () => {
		const { processor, after } = playResync();

		// The far block (all but its fade-in) and the one after it play; the
		// rest of the long block does not.
		assertEquals(
			[countOf(after, 1), countOf(after, 42), countOf(after, 5)],
			[0, 4 * QUANTUM - FADE_FRAMES, QUANTUM],
		);
		assertEquals(processor.stats().resyncs, 1);
	});

	await t.step("fades out the audio it was playing when it resyncs", () => {
		const { before, after } = playResync();

		assertEquals(sampleAt(before, before.length - 1), 1);
		assertAlmostEquals(sampleAt(after, 0), FADE_FRAMES / (FADE_FRAMES + 1), 1e-6);
		assertEquals(after.subarray(FADE_FRAMES, 2 * FADE_FRAMES), new Float32Array(FADE_FRAMES));
	});

	await t.step("fades in the block it resyncs to", () => {
		const { after } = playResync();

		// The block's first full-level sample follows its fade-in.
		const blockStart = after.indexOf(42) - FADE_FRAMES;
		assertAlmostEquals(sampleAt(after, blockStart), 42 / (FADE_FRAMES + 1), 1e-4);
	});

	await t.step("resyncs when a block would land beyond the ring", () => {
		// A fixed 80 ms delay (a 160 ms ring) and 100 ms of backlog delivered
		// with the first block, then the stream live: every live block is due
		// beyond the ring.
		const processor = createFixedProcessor();
		const backlog = Math.ceil(SAMPLE_RATE * 0.1 / QUANTUM);
		for (let i = 0; i <= backlog; i++) processor.append(block(1), i * BLOCK_US);
		const out = new Float32Array(SAMPLE_RATE);
		const left = new Float32Array(QUANTUM);
		const buffers = [[left, new Float32Array(QUANTUM)]];
		for (let q = 0; q < out.length / QUANTUM - 1; q++) {
			processor.append(block(1), (backlog + 1 + q) * BLOCK_US);
			processor.process([], buffers);
			out.set(left, q * QUANTUM);
		}

		assertGreater(countOf(out.subarray(out.length / 2), 1), 0);
		assertGreaterOrEqual(processor.stats().resyncs, 1);
	});

	await t.step("drops a late block that arrived after a later one", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		// The block after next arrives early, with the first.
		processor.append(block(2, 4 * QUANTUM), ts(2 * QUANTUM));
		// The reader passes the slot of the missing block...
		drain(processor, (LAG_SAMPLES + 2 * QUANTUM) / QUANTUM);

		// ...which then arrives.
		processor.append(block(9), ts(QUANTUM));
		const out = drain(processor, 20);

		assertEquals(countOf(out, 9), 0);
		assertEquals(
			[processor.stats().lateBlocks, processor.stats().droppedBlocks],
			[0, 1],
		);
	});

	await t.step("waits afresh to lower the delay once the target rose in between", () => {
		// A 2 s maximum makes room for seconds of audio written ahead.
		const processor = createProcessor({ maxLatency: 2000 });
		processor.append(block(1, 480), 0);
		// 2.5 s of sound arriving 10 ms early: the target falls below the
		// delay, and the delay starts waiting to be lowered.
		processor.append(block(1, 120_000), ts(480));
		drain(processor, SAMPLE_RATE / QUANTUM);
		// A block 73 ms late: the target rises above the delay.
		processor.append(block(1), ts(SAMPLE_RATE - 3500));
		drain(processor, 1.2 * SAMPLE_RATE / QUANTUM);

		// More than two seconds after the first wait began, a block 42 ms early
		// makes the target fall again, inside continuous sound.
		processor.append(block(1, 20_000), ts(2.2 * SAMPLE_RATE + 2000));

		assertEquals(processor.stats().accelerates, 0);
	});

	await t.step("does not lower the delay for a block inside the written audio", () => {
		// A 2 s maximum makes room for 1.5 s of audio written ahead.
		const processor = createProcessor({ maxLatency: 2000 });
		processor.append(block(0), 0);
		// 1.5 s of silence due 40 ms earlier than the first block's timing
		// implies: the target falls below the delay.
		processor.append(block(0, 72_000), ts(1920));
		drain(processor, Math.ceil(1.1 * SAMPLE_RATE / QUANTUM));

		// A block whose slot lies inside that written audio, with the delay
		// waiting to be lowered for over a second.
		processor.append(block(0), ts(59_000));

		assertEquals(processor.stats().accelerates, 0);
	});

	// A stream whose clock stopped for two seconds (a sender's suspended
	// AudioContext): its blocks resume where they stopped, two seconds behind
	// the playback clock, beyond what raising the delay can absorb.
	const twoSecondsOfQuanta = (2 * SAMPLE_RATE) / QUANTUM;

	await t.step("starts over from a stream that fell more than the maximum delay behind", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 1);
		drain(processor, twoSecondsOfQuanta);

		// The sender's clock resumes at 1 block in: three blocks in a row arrive
		// two seconds behind.
		for (let i = 1; i <= 3; i++) processor.append(block(7), i * BLOCK_US);
		appendTail(processor, 4 * QUANTUM);

		const out = drain(processor, LAG_SAMPLES / QUANTUM + 1);

		// Played one cushion from now, not dropped.
		assertEquals(out.findIndex((sample) => sample !== 0), LAG_SAMPLES);
		assertEquals(processor.stats().reanchors, 1);
	});

	await t.step("keeps the stream's timing after starting over", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 1 + twoSecondsOfQuanta);
		for (let i = 1; i <= 3; i++) processor.append(block(7), i * BLOCK_US);

		// The next block follows the one that restarted playback directly.
		processor.append(block(9), 4 * BLOCK_US);
		appendTail(processor, 5 * QUANTUM);

		const out = drain(processor, LAG_SAMPLES / QUANTUM + 2);
		assertEquals(
			out.subarray(LAG_SAMPLES + QUANTUM, LAG_SAMPLES + 2 * QUANTUM),
			new Float32Array(QUANTUM).fill(9),
		);
	});

	await t.step("with a fixed delay, starts over from a stream less than a cushion behind", () => {
		const processor = createFixedProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 1);
		// The sender's clock stopped for half a cushion: its next blocks are
		// wholly in the playback past, but by less than one cushion.
		drain(processor, LAG_SAMPLES / 2 / QUANTUM);

		for (let i = 1; i <= 3; i++) processor.append(block(7), i * BLOCK_US);
		appendTail(processor, 4 * QUANTUM);

		const out = drain(processor, LAG_SAMPLES / QUANTUM + 1);

		assertEquals(out.findIndex((sample) => sample !== 0), LAG_SAMPLES);
	});

	// A processor playing a long block of 1 when three blocks of 7 arrive two
	// seconds behind it, so it starts over from the third.
	function playReanchor() {
		const processor = createProcessor();
		processor.append(block(1, 16 * QUANTUM), 0);
		const before = drain(processor, LAG_SAMPLES / QUANTUM + 2);
		const behind = -2 * SAMPLE_RATE;
		for (let i = 0; i < 3; i++) processor.append(block(7), ts(behind + i * QUANTUM));
		appendTail(processor, behind + 3 * QUANTUM);
		const after = drain(processor, LAG_SAMPLES / QUANTUM + 2);
		return { processor, before, after };
	}

	await t.step("fades out the audio it was playing when it starts over", () => {
		const { processor, before, after } = playReanchor();

		assertEquals(processor.stats().reanchors, 1);
		assertEquals(sampleAt(before, before.length - 1), 1);
		assertAlmostEquals(sampleAt(after, 0), FADE_FRAMES / (FADE_FRAMES + 1), 1e-6);
		assertEquals(after.subarray(FADE_FRAMES, 2 * FADE_FRAMES), new Float32Array(FADE_FRAMES));
	});

	await t.step("fades in the block it starts over from", () => {
		const { after } = playReanchor();

		assertAlmostEquals(sampleAt(after, LAG_SAMPLES), 7 / (FADE_FRAMES + 1), 1e-4);
	});

	await t.step("absorbs a stream that fell behind by less than the maximum delay", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 1);
		drain(processor, LAG_SAMPLES / 2 / QUANTUM);

		for (let i = 1; i <= 3; i++) processor.append(block(7), i * BLOCK_US);
		appendTail(processor, 4 * QUANTUM);

		const margin = SAMPLE_RATE * 20 / 1000;
		const out = drain(processor, Math.ceil(margin / QUANTUM) + 4);

		// The first late block plays after the margin the raised delay keeps,
		// fading in over all of its 128 frames, and the two after it follow at
		// full level.
		assertEquals(countOf(out, 7), 2 * QUANTUM);
		const stats = processor.stats();
		assertEquals(
			[stats.lateBlocks, stats.droppedBlocks, stats.reanchors],
			[1, 0, 0],
		);
	});

	await t.step("drops a single block that is far behind without starting over", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 1 + twoSecondsOfQuanta);

		// One straggler from long ago, then the stream on time.
		processor.append(block(42), BLOCK_US);
		const onTime = (LAG_SAMPLES / QUANTUM + 1 + twoSecondsOfQuanta) * BLOCK_US -
			LAG_SAMPLES / QUANTUM * BLOCK_US;
		processor.append(block(8, 4 * QUANTUM), onTime);

		const out = drain(processor, LAG_SAMPLES / QUANTUM + 2);
		assertEquals(countOf(out, 42), 0);
		assertGreater(countOf(out, 8), 0);
		assertEquals(processor.stats().reanchors, 0);
	});

	await t.step("counts only blocks in a row: an on-time block resets the count", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		const played = LAG_SAMPLES / QUANTUM + 1 + twoSecondsOfQuanta;
		drain(processor, played);
		const onTime = (played - LAG_SAMPLES / QUANTUM) * BLOCK_US;

		processor.append(block(42), 1 * BLOCK_US);
		processor.append(block(42), 2 * BLOCK_US);
		processor.append(block(8, 4 * QUANTUM), onTime);
		processor.append(block(42), 3 * BLOCK_US);

		const out = drain(processor, LAG_SAMPLES / QUANTUM + 2);
		assertEquals(countOf(out, 42), 0);
		assertGreater(countOf(out, 8), 0);
		assertEquals(processor.stats().reanchors, 0);
	});

	await t.step("replies to a stats request with the same id", () => {
		const processor = createProcessor();

		post(processor, { type: "stats", id: 7 });

		assertEquals(processor.port.sent, [{ type: "stats", id: 7, stats: processor.stats() }]);
	});

	await t.step("plays a block appended through its port", () => {
		const processor = createProcessor();

		post(processor, { type: "append", channels: block(1), timestamp: 0 });

		assertEquals(processor.stats().receivedBlocks, 1);
	});

	const malformedMessages = [
		{ name: "an unknown type", data: { type: "flush" } },
		{ name: "no type", data: { channels: block(1), timestamp: 0 } },
		{ name: "null", data: null },
		{ name: "a string", data: "stats" },
		{ name: "append without channels", data: { type: "append", timestamp: 0 } },
		{
			name: "append with a non-array channel list",
			data: { type: "append", channels: new Float32Array(QUANTUM), timestamp: 0 },
		},
		{
			name: "append with a NaN timestamp",
			data: { type: "append", channels: block(1), timestamp: NaN },
		},
		{ name: "stats with a fractional id", data: { type: "stats", id: 1.5 } },
		{ name: "stats without an id", data: { type: "stats" } },
	] as const;
	for (const c of malformedMessages) {
		await t.step(`ignores a message with ${c.name}`, () => {
			const processor = createProcessor();

			post(processor, c.data);

			assertEquals(
				{ sent: processor.port.sent, received: processor.stats().receivedBlocks },
				{ sent: [], received: 0 },
			);
		});
	}
});

// Scenario tests: 20 ms Opus-sized blocks at 48 kHz with the node's default
// delay bounds (100 ms minimum, 400 ms maximum), delivered on simulated links.
const OPUS_FRAMES = 960;
const OPUS_US = 20_000;
const SECOND = SAMPLE_RATE;

interface Scenario {
	// Receiver frame at or after which block i is posted.
	readonly arrivals: readonly number[];
	readonly seconds: number;
	// Sample value of block i (default 1).
	readonly value?: (i: number) => number;
	readonly maxLatency?: number;
	// Underruns are also counted from this frame on.
	readonly countUnderrunsFrom?: number;
	// Called with the stats after each quantum's arrivals.
	readonly observe?: (frame: number, stats: AudioPlayoutStats) => void;
}

interface ScenarioResult {
	readonly stats: AudioPlayoutStats;
	// Channel 0 of the output.
	readonly out: Float32Array;
	readonly underrunsAfterMark: number;
}

// Plays blocks through a processor, one render quantum per step. Block i
// holds OPUS_FRAMES samples of value(i), is stamped i * 20 ms, and is posted
// before the first quantum at or after arrivals[i].
function play(scenario: Scenario): ScenarioResult {
	const processor = createProcessor({ latency: 100, maxLatency: scenario.maxLatency });
	const value = scenario.value ?? (() => 1);
	const mark = scenario.countUnderrunsFrom ?? 0;
	const out = new Float32Array(scenario.seconds * SECOND);
	const left = new Float32Array(QUANTUM);
	const buffers = [[left, new Float32Array(QUANTUM)]];
	let underrunsAtMark = 0;
	let next = 0;
	for (let frame = 0; frame + QUANTUM <= out.length; frame += QUANTUM) {
		for (
			let arrival = scenario.arrivals[next];
			arrival !== undefined && arrival <= frame;
			arrival = scenario.arrivals[next]
		) {
			const v = value(next);
			processor.append(
				[new Float32Array(OPUS_FRAMES).fill(v), new Float32Array(OPUS_FRAMES).fill(v)],
				next * OPUS_US,
			);
			next++;
		}
		if (frame === mark) underrunsAtMark = processor.stats().underruns;
		scenario.observe?.(frame, processor.stats());
		processor.process([], buffers);
		out.set(left, frame);
	}
	const stats = processor.stats();
	return { stats, out, underrunsAfterMark: stats.underruns - underrunsAtMark };
}

// Frame at which block i has been captured by the sender.
const captured = (i: number) => (i + 1) * OPUS_FRAMES;

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

// Blocks delivered as they are captured, with up to 2 ms of jitter.
function cleanLink(seconds: number): number[] {
	const next = random(1);
	return Array.from(
		{ length: seconds * SECOND / OPUS_FRAMES },
		(_, i) => captured(i) + Math.floor(next() * 96),
	);
}

// A link that holds blocks and delivers them every 200 ms, after one second
// delivered as they are captured.
function burstyLink(seconds: number): number[] {
	const period = 200 * SECOND / 1000;
	return Array.from(
		{ length: seconds * SECOND / OPUS_FRAMES },
		(_, i) => i < 50 ? captured(i) : Math.ceil(captured(i) / period) * period,
	);
}

// Deliveries 20 to 200 ms apart, each carrying every block captured.
function randomBurstLink(seconds: number): number[] {
	const next = random(7);
	const arrivals: number[] = [];
	let delivery = 0;
	for (let i = 0; i < seconds * SECOND / OPUS_FRAMES; i++) {
		while (delivery < captured(i)) {
			delivery += Math.round((20 + next() * 180) * SECOND / 1000);
		}
		arrivals.push(delivery);
	}
	return arrivals;
}

// Blocks delayed by up to 150 ms each, in order, after one second on time.
function jitteryLink(seconds: number): number[] {
	const next = random(3);
	const arrivals: number[] = [];
	let last = 0;
	for (let i = 0; i < seconds * SECOND / OPUS_FRAMES; i++) {
		const extra = i < 50 ? 0 : Math.round(next() * 150 * SECOND / 1000);
		last = Math.max(last, captured(i) + extra);
		arrivals.push(last);
	}
	return arrivals;
}

// Ten seconds of 200 ms bursts, then on time until `seconds`.
function burstsThenClean(seconds: number): number[] {
	const arrivals = burstyLink(10);
	for (let i = arrivals.length; i < seconds * SECOND / OPUS_FRAMES; i++) {
		arrivals.push(captured(i));
	}
	return arrivals;
}

// Blocks on time by a sender clock running at `rate` times the receiver's.
function driftingLink(seconds: number, rate: number): number[] {
	return Array.from(
		{ length: seconds * SECOND / OPUS_FRAMES },
		(_, i) => Math.round(captured(i) / rate),
	);
}

// A stream joined with a backlog of `ms`: the blocks captured in it arrive
// at once, as the last of them is captured, and each later block as it is
// captured.
function backlogLink(seconds: number, ms: number): number[] {
	const last = ms * SECOND / 1000 / OPUS_FRAMES - 1;
	return Array.from(
		{ length: seconds * SECOND / OPUS_FRAMES },
		(_, i) => Math.max(0, i - last) * OPUS_FRAMES,
	);
}

// Largest step between consecutive output samples after the stream's first
// onset (a stream start is not faded in): for a constant signal, a hard edge
// between audio and silence is a step of the full amplitude.
function largestStep(out: Float32Array): number {
	let previous: number | null = null;
	let max = 0;
	for (const sample of out) {
		if (previous !== null) max = Math.max(max, Math.abs(sample - previous));
		if (previous !== null || sample !== 0) previous = sample;
	}
	return max;
}

// Frames of the quanta at which a lowering step was taken.
function loweringSteps(scenario: Scenario): number[] {
	const steps: number[] = [];
	let accelerates = 0;
	play({
		...scenario,
		observe: (frame, stats) => {
			if (stats.accelerates > accelerates) steps.push(frame);
			accelerates = stats.accelerates;
		},
	});
	return steps;
}

function spacings(frames: readonly number[]): number[] {
	return frames.slice(1).map((frame, i) => frame - (frames[i] ?? frame));
}

// The step of one fade frame: no edge may be steeper.
const FADE_STEP = 1 / FADE_FRAMES + 1e-6;

Deno.test("audio_offload_worklet adaptive delay", async (t) => {
	await t.step("keeps the minimum delay on a clean link", () => {
		const { stats } = play({ arrivals: cleanLink(10), seconds: 11 });

		assertEquals(stats.targetDelayMs, 100);
		assertGreaterOrEqual(stats.delayMs, 100);
		assertLessOrEqual(stats.delayMs, 105);
	});

	await t.step("makes no adjustment on a clean link", () => {
		const { stats } = play({ arrivals: cleanLink(10), seconds: 11 });

		assertEquals(
			[stats.expands, stats.accelerates, stats.lateBlocks, stats.droppedBlocks],
			[0, 0, 0, 0],
		);
	});

	await t.step("plays 200 ms delivery bursts without gaps once adapted", () => {
		const { stats, underrunsAfterMark } = play({
			arrivals: burstyLink(20),
			seconds: 20,
			countUnderrunsFrom: 3 * SECOND,
		});

		assertEquals([stats.droppedBlocks, underrunsAfterMark], [0, 0]);
	});

	await t.step("raises the target to cover 200 ms delivery bursts", () => {
		const { stats } = play({ arrivals: burstyLink(20), seconds: 20 });

		assertGreaterOrEqual(stats.targetDelayMs, 180);
		assertLessOrEqual(stats.targetDelayMs, 230);
	});

	await t.step("fades every edge while adapting to 200 ms delivery bursts", () => {
		const { out } = play({ arrivals: burstyLink(20), seconds: 20 });

		assertLessOrEqual(largestStep(out), FADE_STEP);
	});

	await t.step("plays a link with up to 150 ms of jitter without dropping", () => {
		const { stats, underrunsAfterMark } = play({
			arrivals: jitteryLink(30),
			seconds: 31,
			countUnderrunsFrom: 5 * SECOND,
		});

		// The one underrun is the end of the stream.
		assertEquals([stats.droppedBlocks, underrunsAfterMark], [0, 1]);
	});

	await t.step("with maxLatency equal to latency, drops blocks of a jittery link", () => {
		const { stats } = play({ arrivals: jitteryLink(30), seconds: 31, maxLatency: 100 });

		assertGreater(stats.droppedBlocks, 10);
	});

	await t.step("with maxLatency equal to latency, never adjusts the delay", () => {
		const { stats } = play({ arrivals: burstyLink(20), seconds: 20, maxLatency: 100 });

		assertEquals([stats.targetDelayMs, stats.expands, stats.accelerates], [100, 0, 0]);
	});

	await t.step("with maxLatency equal to latency, keeps the delay at latency", () => {
		const { stats } = play({ arrivals: cleanLink(10), seconds: 11, maxLatency: 100 });

		assertEquals(stats.targetDelayMs, 100);
		assertAlmostEquals(stats.delayMs, 100, 2);
	});

	await t.step("plays random bursts of up to 200 ms without gaps once adapted", () => {
		const { stats, underrunsAfterMark } = play({
			arrivals: randomBurstLink(30),
			seconds: 31,
			countUnderrunsFrom: 5 * SECOND,
		});

		assertEquals(stats.droppedBlocks, 0);
		assertLessOrEqual(underrunsAfterMark, 2);
	});

	await t.step("falls back to the minimum delay when the link turns clean", () => {
		const { stats } = play({ arrivals: burstsThenClean(120), seconds: 121 });

		assertEquals(stats.targetDelayMs, 100);
		assertLessOrEqual(stats.delayMs, 105);
	});

	await t.step("fades every edge while falling back to the minimum delay", () => {
		const { out } = play({ arrivals: burstsThenClean(120), seconds: 121 });

		assertLessOrEqual(largestStep(out), FADE_STEP);
	});

	await t.step("lowers the delay at quiet stretches without cutting audio", () => {
		// Every fifth block is silence, like pauses in speech.
		const value = (i: number) => i % 5 === 4 ? 0 : 1;
		const arrivals = burstsThenClean(120);
		const { stats, out } = play({ arrivals, seconds: 121, value });

		// The audio lost is no more than the fades at each edge (underruns,
		// inserted silence, crossfaded cuts): every cut took silence.
		const loud = arrivals.filter((_, i) => value(i) === 1).length;
		const lost = loud * OPUS_FRAMES - countOf(out, 1);
		const edges = 2 * stats.underruns + 2 * stats.expands + stats.accelerates +
			2 * stats.lateBlocks;
		assertLessOrEqual(lost, edges * (FADE_FRAMES + 1));
	});

	await t.step("lowers by one step per two seconds through continuous sound", () => {
		const steps = loweringSteps({ arrivals: burstsThenClean(120), seconds: 121 });

		const gaps = spacings(steps);
		assertGreaterOrEqual(Math.min(...gaps), 2 * SECOND - QUANTUM);
		assertGreaterOrEqual(gaps.filter((gap) => gap <= 2.1 * SECOND).length, 3);
	});

	await t.step("lowers by one step per second at quiet stretches", () => {
		const steps = loweringSteps({
			arrivals: burstsThenClean(120),
			seconds: 121,
			value: (i) => i % 5 === 4 ? 0 : 1,
		});

		const gaps = spacings(steps);
		assertGreaterOrEqual(Math.min(...gaps), SECOND - QUANTUM);
		assertGreaterOrEqual(gaps.filter((gap) => gap <= 1.1 * SECOND).length, 3);
	});

	await t.step("follows a sender clock running slow without gaps", () => {
		const { stats, underrunsAfterMark } = play({
			arrivals: driftingLink(60, 1 / 1.003),
			seconds: 62,
			countUnderrunsFrom: SECOND,
		});

		// The one underrun is the end of the stream.
		assertEquals(
			[stats.droppedBlocks, stats.lateBlocks, underrunsAfterMark],
			[0, 0, 1],
		);
	});

	await t.step("follows a sender clock running fast without resyncing", () => {
		const { stats, underrunsAfterMark } = play({
			arrivals: driftingLink(60, 1 / 0.997),
			seconds: 61,
			countUnderrunsFrom: SECOND,
		});

		assertEquals([stats.droppedBlocks, stats.resyncs, underrunsAfterMark], [0, 0, 1]);
	});

	const backlogCases = [
		{ name: "joined with a 240 ms backlog", arrivals: () => backlogLink(10, 240) },
		{ name: "joined with a 1 s backlog", arrivals: () => backlogLink(10, 1000) },
	] as const;
	for (const c of backlogCases) {
		await t.step(`${c.name}, plays at the minimum delay`, () => {
			const { stats } = play({ arrivals: c.arrivals(), seconds: 10 });

			assertEquals(stats.targetDelayMs, 100);
			assertGreaterOrEqual(stats.delayMs, 100);
			assertLessOrEqual(stats.delayMs, 105);
		});

		await t.step(`${c.name}, takes no lowering step`, () => {
			const { stats } = play({ arrivals: c.arrivals(), seconds: 10 });

			assertEquals(stats.accelerates, 0);
		});

		await t.step(`${c.name}, fades in the audio it starts from`, () => {
			const { out } = play({ arrivals: c.arrivals(), seconds: 1 });

			const onset = out.findIndex((sample) => sample !== 0);
			assertLessOrEqual(sampleAt(out, onset), FADE_STEP);
		});
	}

	await t.step("joined with a 240 ms backlog, plays its last 100 ms", () => {
		const { out } = play({ arrivals: backlogLink(1, 240), seconds: 1 });

		// The newest backlog block lands one cushion ahead, with the backlog's
		// last 100 ms before it, so playback starts at once.
		const onset = out.findIndex((sample) => sample !== 0);
		assertLessOrEqual(onset, QUANTUM);
	});

	await t.step("keeps the delay near the minimum with a sender clock running fast", () => {
		const { stats } = play({ arrivals: driftingLink(60, 1 / 0.997), seconds: 61 });

		assertLessOrEqual(stats.delayMs, 115);
	});
});

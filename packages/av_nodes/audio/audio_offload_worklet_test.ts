/// <reference path="../../../src/test_globals.d.ts" />
import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { importWorkletUrl } from "./audio_offload_worklet.ts";
import { setupFakeAudioWorkletEnvironment } from "./fake_audio_worklet_environment_test.ts";

type Message = { data: { channels: Float32Array[]; timestamp: number } };

type PlaybackStats = {
	targetDelayMs: number;
	delayMs: number;
	bufferLevelMs: number;
	receivedBlocks: number;
	lateBlocks: number;
	droppedBlocks: number;
	underruns: number;
	expands: number;
	expandedMs: number;
	accelerates: number;
	acceleratedMs: number;
	resyncs: number;
	reanchors: number;
};

type AudioOffloadProcessorInstance = {
	append(channels: Float32Array[], tsUs: number): void;
	stats(): PlaybackStats;
	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
	port: {
		onmessage?: (message: Message | { data: { type: "stats"; id: number } }) => void;
		postMessage?: (message: unknown) => void;
	};
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
	for (let q = 0; q < quanta; q++) {
		const buffers = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];
		processor.process([], buffers);
		out.set(buffers[0]![0]!, q * QUANTUM);
	}
	return out;
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

	// Fades at every edge between audio and silence last this many frames.
	const FADE_FRAMES = 144; // ceil(48000 * 3 / 1000)
	const block = (value: number, frames: number = QUANTUM) => [
		new Float32Array(frames).fill(value),
		new Float32Array(frames).fill(value),
	];
	const ts = (frames: number) => Math.round(frames * 1_000_000 / SAMPLE_RATE);
	// Audio after an asserted region, so the fade-out ahead of the end of the
	// written audio falls outside it.
	const appendTail = (processor: AudioOffloadProcessorInstance, frame: number) =>
		processor.append(block(0.5, 4 * QUANTUM), ts(frame));

	await t.step("rejects an invalid maxLatency", () => {
		assertThrows(() => createProcessor({ maxLatency: -1 }), Error, "invalid maxLatency");
	});

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

	await t.step("fades both edges of a silence gap between two blocks", () => {
		const processor = createProcessor();
		const length = 4 * QUANTUM;
		// Each block arrives when it is captured; the second is due one block
		// length after the first ends.
		processor.append(block(1, length), 0);
		const before = drain(processor, 2 * length / QUANTUM);
		processor.append(block(1, length), ts(2 * length));
		const between = drain(processor, length / QUANTUM);
		appendTail(processor, 3 * length);
		const after = drain(processor, LAG_SAMPLES / QUANTUM);

		const out = new Float32Array(before.length + between.length + after.length);
		out.set(before);
		out.set(between, before.length);
		out.set(after, before.length + between.length);
		const first = out.subarray(LAG_SAMPLES, LAG_SAMPLES + length);
		const gap = out.subarray(LAG_SAMPLES + length, LAG_SAMPLES + 2 * length);
		const second = out.subarray(LAG_SAMPLES + 2 * length, LAG_SAMPLES + 3 * length);

		assertEquals(
			first.subarray(0, length - FADE_FRAMES),
			new Float32Array(length - FADE_FRAMES).fill(1),
		);
		assert(first[length - 1]! > 0 && first[length - 1]! < 0.01);
		assertEquals(gap, new Float32Array(length));
		assert(second[0]! > 0 && second[0]! < 0.01);
		assertEquals(
			second.subarray(FADE_FRAMES),
			new Float32Array(length - FADE_FRAMES).fill(1),
		);
	});

	await t.step(
		"with a fixed delay, drops a stale (late) block without disrupting playback",
		() => {
			const processor = createFixedProcessor();
			processor.append(block(1), 0);
			// Advance two quanta past the first block's scheduled position.
			drain(processor, LAG_SAMPLES / QUANTUM + 2);

			// Stale block: ts 0 maps to a frame now in the playback past → dropped.
			processor.append(block(42), 0);

			// A fresh block scheduled at the current frame still plays, fading in
			// after the underrun.
			processor.append(block(8, 4 * QUANTUM), 2 * BLOCK_US);
			appendTail(processor, 6 * QUANTUM);

			const out = drain(processor, 4);
			assert(!out.includes(42));
			assert(out[0]! < 8);
			assertEquals(out[4 * QUANTUM - 1], 8);
			assertEquals(processor.stats().droppedBlocks, 1);
		},
	);

	await t.step("plays a late block by raising the delay instead of dropping it", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		// The reader plays the block and runs dry.
		drain(processor, LAG_SAMPLES / QUANTUM + 2);

		// The next block arrives one quantum after its playout frame.
		processor.append(block(42, 4 * QUANTUM), ts(QUANTUM));
		appendTail(processor, 5 * QUANTUM);

		const out = drain(processor, 20);
		assert(out.includes(42));
		const stats = processor.stats();
		assertEquals(stats.lateBlocks, 1);
		assertEquals(stats.droppedBlocks, 0);
		// The delay now covers that block's lateness plus a margin.
		assert(stats.delayMs > LATENCY_MS);
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

	await t.step("does not crash on a pre-base (non-monotonic) timestamp", () => {
		// A block whose timestamp maps before the playback origin must be clamped,
		// not index the ring with a negative offset (RangeError → dead onmessage).
		const late = new Float32Array(2400).fill(9);
		for (const processor of [createProcessor(), createFixedProcessor()]) {
			processor.append(block(1), 0);
			processor.append([late, late], -100_000);
		}

		// With a fixed delay the block is partially late: the not-yet-played tail
		// plays at once.
		const fixed = createFixedProcessor();
		fixed.append(block(1), 0);
		fixed.append([late, late], -100_000);
		assertEquals(drain(fixed, 1), new Float32Array(QUANTUM).fill(9));
	});

	await t.step("resyncs to the live edge when a block overflows the buffer", () => {
		// A block whose timestamp jumps more than one cushion ahead of the
		// cushion means playback is behind the media (catch-up burst). Rather
		// than queue the stale backlog, resync: advance the read pointer so the
		// far block plays at the live edge.
		const processor = createProcessor();
		processor.append(block(1), 0);
		// 3*LAG samples ahead → due 4*LAG, beyond twice the cushion.
		const farFrame = 3 * LAG_SAMPLES;
		processor.append(block(42), ts(farFrame));
		// A block contiguous with the far one must play too.
		processor.append(block(5), ts(farFrame + QUANTUM));
		appendTail(processor, farFrame + 2 * QUANTUM);
		const out = drain(processor, LAG_SAMPLES / QUANTUM + 3);
		assert(out.includes(42));
		assert(out.includes(5));
		// The first block (1) is behind the resynced read pointer → abandoned.
		assert(!out.includes(1));
		assertEquals(processor.stats().resyncs, 1);
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

		// Played one cushion from now, not dropped.
		const out = drain(processor, LAG_SAMPLES / QUANTUM + 1);
		assertEquals(
			out.subarray(LAG_SAMPLES, LAG_SAMPLES + QUANTUM),
			new Float32Array(QUANTUM).fill(7),
		);
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
		assertEquals(
			out.subarray(LAG_SAMPLES, LAG_SAMPLES + QUANTUM),
			new Float32Array(QUANTUM).fill(7),
		);
	});

	await t.step("absorbs a stream that fell behind by less than the maximum delay", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 1);
		drain(processor, LAG_SAMPLES / 2 / QUANTUM);

		for (let i = 1; i <= 3; i++) processor.append(block(7), i * BLOCK_US);
		appendTail(processor, 4 * QUANTUM);

		// The first late block fades in after the margin the raised delay keeps,
		// and the two after it follow without a gap.
		const margin = SAMPLE_RATE * 20 / 1000;
		const out = drain(processor, Math.ceil(margin / QUANTUM) + 4);
		assert(out[margin]! < 7);
		assertEquals(
			out.subarray(margin + FADE_FRAMES, margin + 3 * QUANTUM),
			new Float32Array(3 * QUANTUM - FADE_FRAMES).fill(7),
		);
		const stats = processor.stats();
		assertEquals(stats.lateBlocks, 1);
		assertEquals(stats.droppedBlocks, 0);
		assertEquals(stats.reanchors, 0);
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
		assert(!out.includes(42));
		assert(out.includes(8));
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
		assert(!out.includes(42));
		assert(out.includes(8));
		assertEquals(processor.stats().reanchors, 0);
	});

	await t.step("replies to a stats request on its port", () => {
		const processor = createProcessor();
		const replies: unknown[] = [];
		processor.port.postMessage = (message: unknown) => replies.push(message);
		processor.port.onmessage!({ data: { type: "stats", id: 7 } });
		assertEquals(replies.length, 1);
		const reply = replies[0] as { type: string; id: number; stats: PlaybackStats };
		assertEquals(reply.type, "stats");
		assertEquals(reply.id, 7);
		assertEquals(reply.stats.targetDelayMs, LATENCY_MS);
		assertEquals(reply.stats.receivedBlocks, 0);
	});
});

// Scenario tests: 20 ms Opus-sized blocks at 48 kHz with the node's default
// delay bounds (100 ms minimum, 400 ms maximum), delivered on simulated links.
const OPUS_FRAMES = 960;
const OPUS_US = 20_000;
const SECOND = SAMPLE_RATE;
const FADE = 144;

function createDefaultProcessor(maxLatency?: number): AudioOffloadProcessorInstance {
	return createProcessor({ latency: 100, maxLatency });
}

// Plays blocks through the processor, one render quantum per step. Block i
// holds OPUS_FRAMES samples of value(i), is stamped i * 20 ms, and is posted
// before the first quantum at or after arrivals[i]. `at` is called before
// each quantum. Returns channel 0 of the output.
function simulate(
	processor: AudioOffloadProcessorInstance,
	arrivals: number[],
	totalFrames: number,
	value: (i: number) => number = () => 1,
	at: (frame: number) => void = () => {},
): Float32Array {
	const out = new Float32Array(totalFrames);
	const buffers = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];
	let next = 0;
	for (let frame = 0; frame + QUANTUM <= totalFrames; frame += QUANTUM) {
		while (next < arrivals.length && arrivals[next]! <= frame) {
			const v = value(next);
			processor.append(
				[new Float32Array(OPUS_FRAMES).fill(v), new Float32Array(OPUS_FRAMES).fill(v)],
				next * OPUS_US,
			);
			next++;
		}
		at(frame);
		processor.process([], buffers);
		out.set(buffers[0]![0]!, frame);
	}
	return out;
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

// A link that holds blocks and delivers them every `period` frames, after
// `onTimeBlocks` delivered as they are captured.
function bursty(count: number, onTimeBlocks: number, period: number): number[] {
	return Array.from(
		{ length: count },
		(_, i) => i < onTimeBlocks ? captured(i) : Math.ceil(captured(i) / period) * period,
	);
}

// Largest step between consecutive output samples after the stream's first
// onset (a stream start is not faded in): for a constant signal, a hard edge
// between audio and silence is a step of the full amplitude.
function largestStep(out: Float32Array): number {
	let i = out.findIndex((sample) => sample !== 0) + 1;
	let max = 0;
	for (; i > 0 && i < out.length; i++) {
		max = Math.max(max, Math.abs(out[i]! - out[i - 1]!));
	}
	return max;
}

// Underruns counted from `frame` on.
function underrunsFrom(
	processor: AudioOffloadProcessorInstance,
	frame: number,
): { at: (f: number) => void; count: () => number } {
	let before = -1;
	return {
		at: (f) => {
			if (f === frame) before = processor.stats().underruns;
		},
		count: () => processor.stats().underruns - before,
	};
}

Deno.test("audio_offload_worklet adaptive delay", async (t) => {
	await t.step("keeps the minimum delay on a clean link", () => {
		const processor = createDefaultProcessor();
		const next = random(1);
		// Up to 2 ms of jitter, as on a good Wi-Fi link.
		const count = 10 * SECOND / OPUS_FRAMES;
		const arrivals = Array.from(
			{ length: count },
			(_, i) => captured(i) + Math.floor(next() * 96),
		);
		const out = simulate(processor, arrivals, 11 * SECOND);

		const stats = processor.stats();
		assertEquals(stats.targetDelayMs, 100);
		assert(stats.delayMs >= 100 && stats.delayMs <= 105, `delay ${stats.delayMs}`);
		assertEquals(stats.lateBlocks, 0);
		assertEquals(stats.droppedBlocks, 0);
		assertEquals(stats.expands, 0);
		assertEquals(stats.accelerates, 0);
		// The only underrun is the end of the stream.
		assertEquals(stats.underruns, 1);
		assert(largestStep(out) <= 1 / FADE + 1e-6);
	});

	await t.step("absorbs 200 ms delivery bursts without drops once adapted", () => {
		const processor = createDefaultProcessor();
		// One second on time, then 10 blocks at a time every 200 ms.
		const count = 20 * SECOND / OPUS_FRAMES;
		const arrivals = bursty(count, 50, 200 * SECOND / 1000);
		const after = underrunsFrom(processor, 3 * SECOND);
		const out = simulate(processor, arrivals, 20 * SECOND, () => 1, after.at);

		const stats = processor.stats();
		assertEquals(stats.droppedBlocks, 0);
		assertEquals(after.count(), 0);
		assert(
			stats.targetDelayMs >= 180 && stats.targetDelayMs <= 230,
			`target ${stats.targetDelayMs}`,
		);
		// Adapting is silent, not a click: fades on every edge.
		assert(largestStep(out) <= 1 / FADE + 1e-6, `step ${largestStep(out)}`);
	});

	await t.step("with a fixed delay, the same bursts are dropped", () => {
		const processor = createDefaultProcessor(100);
		const count = 20 * SECOND / OPUS_FRAMES;
		simulate(processor, bursty(count, 50, 200 * SECOND / 1000), 20 * SECOND);
		const stats = processor.stats();
		assert(stats.droppedBlocks > 20, `dropped ${stats.droppedBlocks}`);
		assert(stats.underruns > 40, `underruns ${stats.underruns}`);
	});

	await t.step("absorbs random bursts of up to 200 ms without drops", () => {
		const processor = createDefaultProcessor();
		const next = random(7);
		const count = 30 * SECOND / OPUS_FRAMES;
		// Deliveries 20 to 200 ms apart, each carrying every block captured.
		const deliveries: number[] = [];
		for (let t = 0; t < 31 * SECOND;) {
			t += Math.round((20 + next() * 180) * SECOND / 1000);
			deliveries.push(t);
		}
		let d = 0;
		const arrivals = Array.from({ length: count }, (_, i) => {
			while (deliveries[d]! < captured(i)) d++;
			return deliveries[d]!;
		});
		const after = underrunsFrom(processor, 5 * SECOND);
		simulate(processor, arrivals, 31 * SECOND, () => 1, after.at);

		const stats = processor.stats();
		assertEquals(stats.droppedBlocks, 0);
		assert(after.count() <= 2, `underruns ${after.count()}`);
		assert(stats.targetDelayMs <= 260, `target ${stats.targetDelayMs}`);
	});

	await t.step("falls back to the minimum delay when the link turns clean", () => {
		const processor = createDefaultProcessor();
		// Ten seconds of 200 ms bursts, then 110 seconds on time.
		const bursts = 10 * SECOND / OPUS_FRAMES;
		const count = 120 * SECOND / OPUS_FRAMES;
		const arrivals = bursty(bursts, 50, 200 * SECOND / 1000);
		for (let i = bursts; i < count; i++) arrivals.push(captured(i));
		const after = underrunsFrom(processor, 11 * SECOND);
		const out = simulate(processor, arrivals, 121 * SECOND, () => 1, after.at);

		const stats = processor.stats();
		assertEquals(stats.targetDelayMs, 100);
		assert(stats.delayMs <= 105, `delay ${stats.delayMs}`);
		assert(stats.accelerates > 0);
		assertEquals(stats.droppedBlocks, 0);
		// The end of the stream.
		assertEquals(after.count(), 1);
		assert(largestStep(out) <= 1 / FADE + 1e-6, `step ${largestStep(out)}`);
	});

	await t.step("lowers the delay at quiet stretches, keeping the audio", () => {
		const processor = createDefaultProcessor();
		const bursts = 10 * SECOND / OPUS_FRAMES;
		const count = 120 * SECOND / OPUS_FRAMES;
		const arrivals = bursty(bursts, 50, 200 * SECOND / 1000);
		for (let i = bursts; i < count; i++) arrivals.push(captured(i));
		// Every fifth block is silence, like pauses in speech.
		const value = (i: number) => i % 5 === 4 ? 0 : 1;
		const out = simulate(processor, arrivals, 121 * SECOND, value);

		const stats = processor.stats();
		assert(stats.delayMs <= 105, `delay ${stats.delayMs}`);
		// Every lowering step cut silence: the audio lost is no more than the
		// fades at each edge (underruns, inserted silence, crossfaded cuts).
		let loud = 0;
		for (let i = 0; i < count; i++) if (value(i) === 1) loud++;
		let played = 0;
		for (const sample of out) if (sample === 1) played++;
		const edges = 2 * stats.underruns + 2 * stats.expands + stats.accelerates +
			2 * stats.lateBlocks;
		assert(
			loud * OPUS_FRAMES - played <= edges * (FADE + 1),
			`lost ${loud * OPUS_FRAMES - played}, edges ${edges}`,
		);
	});

	await t.step("follows a sender clock running slow", () => {
		const processor = createDefaultProcessor();
		// The sender's clock runs 0.3% slow: blocks arrive ever later.
		const count = 60 * SECOND / OPUS_FRAMES;
		const arrivals = Array.from({ length: count }, (_, i) => Math.round(captured(i) * 1.003));
		const after = underrunsFrom(processor, SECOND);
		simulate(processor, arrivals, 62 * SECOND, () => 1, after.at);

		const stats = processor.stats();
		assertEquals(stats.droppedBlocks, 0);
		assertEquals(stats.lateBlocks, 0);
		assert(stats.expands > 0);
		assert(stats.delayMs <= 115, `delay ${stats.delayMs}`);
		// The end of the stream.
		assertEquals(after.count(), 1);
	});

	await t.step("follows a sender clock running fast", () => {
		const processor = createDefaultProcessor();
		// The sender's clock runs 0.3% fast: blocks arrive ever earlier.
		const count = 60 * SECOND / OPUS_FRAMES;
		const arrivals = Array.from({ length: count }, (_, i) => Math.round(captured(i) * 0.997));
		const after = underrunsFrom(processor, SECOND);
		simulate(processor, arrivals, 61 * SECOND, () => 1, after.at);

		const stats = processor.stats();
		assertEquals(stats.droppedBlocks, 0);
		assertEquals(stats.resyncs, 0);
		assert(stats.accelerates > 0);
		assertEquals(after.count(), 1);
	});
});

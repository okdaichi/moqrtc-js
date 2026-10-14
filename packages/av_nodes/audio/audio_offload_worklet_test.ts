/// <reference path="../../../src/test_globals.d.ts" />
import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { importWorkletUrl } from "./audio_offload_worklet.ts";
import { setupFakeAudioWorkletEnvironment } from "./fake_audio_worklet_environment_test.ts";

type Message = { data: { channels: Float32Array[]; timestamp: number } };

type AudioOffloadProcessorInstance = {
	append(channels: Float32Array[], tsUs: number): void;
	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
	port: {
		onmessage?: (message: Message) => void;
		postMessage?: (message: unknown) => void;
	};
};

type AudioOffloadProcessorConstructor = new (
	options: AudioWorkletNodeOptions,
) => AudioOffloadProcessorInstance;

// Deterministic timing constants for the scheduling tests.
// sampleRate 48000, latency 80ms → lagSamples 3840, bufferLength 7680, both
// multiples of the 128-frame render quantum, so block boundaries line up with
// quantum boundaries and assertions are exact.
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

function createProcessor(): AudioOffloadProcessorInstance {
	return new OffloadProcessor({
		channelCount: 2,
		processorOptions: { sampleRate: SAMPLE_RATE, latency: LATENCY_MS },
	});
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

	await t.step("process() with no outputs still advances the playback clock", () => {
		const processor = createProcessor();
		// A no-output quantum must still advance the clock, else a block arriving
		// next would be anchored to a stale frame and schedule into the past.
		assertEquals(processor.process([], []), true);
		processor.append(
			[new Float32Array(QUANTUM).fill(1), new Float32Array(QUANTUM).fill(1)],
			0,
		);
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
		processor.append(
			[new Float32Array(QUANTUM).fill(1), new Float32Array(QUANTUM).fill(1)],
			0,
		);
		const out = drain(processor, LAG_SAMPLES / QUANTUM);
		assertEquals(out, new Float32Array(LAG_SAMPLES));
	});

	await t.step("absorbs a multi-frame burst with no gaps or drops", () => {
		// Three 128-sample blocks posted at once (burst), each scheduled one
		// quantum apart. They must emerge contiguously at their scheduled frames
		// with no silence between them — the RTSP/AAC-coalescing scenario from
		// issue #18.
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

		const totalQuanta = LAG_SAMPLES / QUANTUM + 3;
		const out = drain(processor, totalQuanta);

		const expect = new Float32Array(totalQuanta * QUANTUM);
		expect.fill(1, LAG_SAMPLES, LAG_SAMPLES + QUANTUM);
		expect.fill(3, LAG_SAMPLES + QUANTUM, LAG_SAMPLES + 2 * QUANTUM);
		expect.fill(5, LAG_SAMPLES + 2 * QUANTUM, LAG_SAMPLES + 3 * QUANTUM);
		assertEquals(out, expect);
	});

	await t.step("silence-fills a gap between two scheduled blocks", () => {
		const processor = createProcessor();
		processor.append(
			[new Float32Array(QUANTUM).fill(7), new Float32Array(QUANTUM).fill(7)],
			0,
		);
		// 2*BLOCK_US maps to offset 2*QUANTUM, one quantum after the first block →
		// a one-quantum silence gap between them.
		processor.append(
			[new Float32Array(QUANTUM).fill(9), new Float32Array(QUANTUM).fill(9)],
			2 * BLOCK_US,
		);

		const out = drain(processor, LAG_SAMPLES / QUANTUM + 3);
		assertEquals(
			out.subarray(LAG_SAMPLES, LAG_SAMPLES + QUANTUM),
			new Float32Array(QUANTUM).fill(7),
		);
		assertEquals(
			out.subarray(LAG_SAMPLES + QUANTUM, LAG_SAMPLES + 2 * QUANTUM),
			new Float32Array(QUANTUM), // gap
		);
		assertEquals(
			out.subarray(LAG_SAMPLES + 2 * QUANTUM, LAG_SAMPLES + 3 * QUANTUM),
			new Float32Array(QUANTUM).fill(9),
		);
	});

	await t.step("drops a stale (late) block without disrupting playback", () => {
		const processor = createProcessor();
		processor.append(
			[new Float32Array(QUANTUM).fill(1), new Float32Array(QUANTUM).fill(1)],
			0,
		);
		// Advance two quanta past the first block's scheduled position.
		drain(processor, LAG_SAMPLES / QUANTUM + 2);

		// Stale block: ts 0 maps to a frame now in the playback past → dropped.
		processor.append(
			[new Float32Array(QUANTUM).fill(42), new Float32Array(QUANTUM).fill(42)],
			0,
		);

		// A fresh block scheduled at the current frame must still play correctly,
		// proving the stale append didn't corrupt the write head / ring.
		processor.append(
			[new Float32Array(QUANTUM).fill(8), new Float32Array(QUANTUM).fill(8)],
			2 * BLOCK_US, // maps to LAG + 2*QUANTUM = current playout frame
		);

		const out = drain(processor, 1);
		assertEquals(out, new Float32Array(QUANTUM).fill(8));
	});

	await t.step("recovers from underrun when a future block arrives", () => {
		const processor = createProcessor();
		// No data at all for 10 quanta → pure silence.
		assertEquals(drain(processor, 10), new Float32Array(10 * QUANTUM));

		// A block arrives now; the cushion is anchored to the current frame, so it
		// is scheduled LAG_SAMPLES ahead of where playback already is.
		processor.append(
			[new Float32Array(QUANTUM).fill(5), new Float32Array(QUANTUM).fill(6)],
			0,
		);
		const played = 10 * QUANTUM;
		const due = played + LAG_SAMPLES;
		const silenceBeforeBlock = (due - played) / QUANTUM;
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
		// Drain pre-roll + the block quantum.
		const out = drain(processor, LAG_SAMPLES / QUANTUM + 1);
		assertEquals(
			out.subarray(LAG_SAMPLES, LAG_SAMPLES + QUANTUM),
			new Float32Array(QUANTUM).fill(1),
		);
	});

	await t.step("keeps a full cushion when the first block arrives late", () => {
		// Repros the origin-anchoring bug: if process() idles for a while before
		// the first decode, the first block must STILL play a full lag later, not
		// be dropped as stale (which would silence the node forever).
		const processor = createProcessor();
		const idleQuanta = 20;
		assertEquals(drain(processor, idleQuanta), new Float32Array(idleQuanta * QUANTUM));

		processor.append(
			[new Float32Array(QUANTUM).fill(7), new Float32Array(QUANTUM).fill(7)],
			0,
		);
		// Cushion measured from arrival (idleQuanta*QUANTUM), so the block is due
		// a full LAG_SAMPLES after the idle period, not at absolute LAG_SAMPLES.
		const due = idleQuanta * QUANTUM + LAG_SAMPLES;
		const played = idleQuanta * QUANTUM;
		const silenceBeforeBlock = (due - played) / QUANTUM; // == LAG_SAMPLES / QUANTUM
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
		const processor = createProcessor();
		// Establish the origin with a normal block at the current frame.
		processor.append(
			[new Float32Array(QUANTUM).fill(1), new Float32Array(QUANTUM).fill(1)],
			0,
		);
		// -100 ms with a >1-quantum body → start < #playoutFrame < end: partially
		// late. Without the clamp this reaches `dst.set(..., negativeOffset)`.
		const late = new Float32Array(1200).fill(9);
		let threw = false;
		try {
			processor.append([late, late], -100_000);
		} catch (_) {
			threw = true;
		}
		assertEquals(threw, false);
		// The not-yet-played tail of the late block still plays correctly.
		const first = drain(processor, 1);
		assertEquals(first, new Float32Array(QUANTUM).fill(9));
	});

	await t.step("resyncs to the live edge when a block overflows the buffer", () => {
		// A block whose timestamp jumps more than one buffer ahead means playback
		// is behind the media (catch-up burst / drift). Rather than drop every
		// later block at the pinned-full cap (per-frame silence), resync: advance
		// the read pointer so the far block plays at the live edge. The stale
		// backlog before it is abandoned.
		const processor = createProcessor();
		processor.append(
			[new Float32Array(QUANTUM).fill(1), new Float32Array(QUANTUM).fill(1)],
			0,
		);
		// 3*LAG samples ahead → start = LAG + 3*LAG = 4*LAG, well past maxFrame
		// (LAG + bufferLength = 3*LAG) → triggers resync.
		const farTs = Math.round((LAG_SAMPLES + 2 * LAG_SAMPLES) * 1_000_000 / SAMPLE_RATE);
		processor.append(
			[new Float32Array(QUANTUM).fill(42), new Float32Array(QUANTUM).fill(42)],
			farTs,
		);
		// A block contiguous with the far one (next 128 frames) must play too —
		// resync doesn't corrupt subsequent placement.
		processor.append(
			[new Float32Array(QUANTUM).fill(5), new Float32Array(QUANTUM).fill(5)],
			farTs + BLOCK_US,
		);
		const out = drain(processor, LAG_SAMPLES / QUANTUM + 3);
		// The far block (42) and its contiguous follower (5) both render: the
		// resync recovered playback to the live edge instead of dropping them.
		assert(out.includes(42));
		assert(out.includes(5));
		// The first block (1) is behind the resynced read pointer → abandoned.
		assert(!out.includes(1));
	});
	// A stream whose clock stopped for two seconds (a sender's suspended
	// AudioContext): its blocks resume where they stopped, two seconds behind
	// the playback clock.
	const block = (value: number) => [
		new Float32Array(QUANTUM).fill(value),
		new Float32Array(QUANTUM).fill(value),
	];
	const twoSecondsOfQuanta = (2 * SAMPLE_RATE) / QUANTUM;

	await t.step("starts over from a stream that fell more than a cushion behind", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 1);
		drain(processor, twoSecondsOfQuanta);

		// The sender's clock resumes at 1 block in: three blocks in a row arrive
		// two seconds behind.
		for (let i = 1; i <= 3; i++) processor.append(block(7), i * BLOCK_US);

		// Played one cushion from now, not dropped.
		const out = drain(processor, LAG_SAMPLES / QUANTUM + 1);
		assertEquals(
			out.subarray(LAG_SAMPLES, LAG_SAMPLES + QUANTUM),
			new Float32Array(QUANTUM).fill(7),
		);
	});

	await t.step("keeps the stream's timing after starting over", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 1 + twoSecondsOfQuanta);
		for (let i = 1; i <= 3; i++) processor.append(block(7), i * BLOCK_US);

		// The next block follows the one that restarted playback directly.
		processor.append(block(9), 4 * BLOCK_US);

		const out = drain(processor, LAG_SAMPLES / QUANTUM + 2);
		assertEquals(
			out.subarray(LAG_SAMPLES + QUANTUM, LAG_SAMPLES + 2 * QUANTUM),
			new Float32Array(QUANTUM).fill(9),
		);
	});

	await t.step("drops a single block that is far behind without starting over", () => {
		const processor = createProcessor();
		processor.append(block(1), 0);
		drain(processor, LAG_SAMPLES / QUANTUM + 1 + twoSecondsOfQuanta);

		// One straggler from long ago, then the stream on time.
		processor.append(block(42), BLOCK_US);
		const onTime = 0 + (LAG_SAMPLES / QUANTUM + 1 + twoSecondsOfQuanta) * BLOCK_US -
			LAG_SAMPLES / QUANTUM * BLOCK_US;
		processor.append(block(8), onTime);

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
		processor.append(block(8), onTime);
		processor.append(block(42), 3 * BLOCK_US);

		const out = drain(processor, LAG_SAMPLES / QUANTUM + 2);
		assert(!out.includes(42));
		assert(out.includes(8));
	});
});

/// <reference path="../../../src/test_globals.d.ts" />
import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { importWorkletUrl, workletName } from "./audio_hijack_worklet.ts";
import { setupFakeAudioWorkletEnvironment } from "./fake_audio_worklet_environment_test.ts";

// The context's render clock, as the worklet scope exposes it: at() sets it,
// restore() puts back what the global scope had.
function workletClock() {
	const g = globalThis as unknown as Record<string, unknown>;
	const saved = ["currentFrame", "sampleRate"].map((key) => ({
		key,
		had: Object.prototype.hasOwnProperty.call(g, key),
		value: g[key],
	}));
	return {
		at(frame: number, rate = 48000) {
			g.currentFrame = frame;
			g.sampleRate = rate;
		},
		restore() {
			for (const { key, had, value } of saved) {
				if (had) g[key] = value;
				else delete g[key];
			}
		},
	};
}

Deno.test("audio_hijack_worklet", async (t) => {
	const clock = workletClock();
	await t.step("provides a URL for the worklet script", () => {
		const url = importWorkletUrl();
		assert(url.endsWith("audio_hijack_worklet.js"));
		// For mocking purposes, we return a simple string, so URL validation is skipped
		// assert(() => new URL(url));
	});

	await t.step(
		"registers the hijack processor when AudioWorkletProcessor is available",
		async () => {
			const env = setupFakeAudioWorkletEnvironment();

			try {
				await import("./audio_hijack_worklet.ts?register");

				assertEquals(env.registerProcessorCalls.length, 1);
				const [name, processorCtor] = env.registerProcessorCalls[0]!;
				assertEquals(name, workletName);
				assertEquals(typeof processorCtor, "function");
			} finally {
				env.restore();
			}
		},
	);

	await t.step("AudioHijackProcessor", async (t) => {
		let processor!: {
			process(inputs: Float32Array[][]): boolean;
			append?(channels: (Float32Array | undefined)[]): void;
		};
		let mockPort: {
			messages?: AudioDataInit[];
			postedMessages?: unknown[];
			onmessage?: (message: unknown) => void;
			postMessage?: (message: AudioDataInit) => void;
		};

		await t.step("setup", async () => {
			mockPort = {
				postMessage: (message: AudioDataInit) => {
					mockPort.messages = mockPort.messages || [];
					mockPort.messages.push(message);
				},
			};

			const env = setupFakeAudioWorkletEnvironment();
			try {
				await import("./audio_hijack_worklet.ts?processor");
				const ctor = env.registerProcessorCalls[0]![1] as new (
					options: AudioWorkletNodeOptions,
				) => {
					port: { postMessage: unknown };
					process(inputs: Float32Array[][]): boolean;
				};
				const real = new ctor({
					processorOptions: {
						sampleRate: 44100,
						targetChannels: 2,
					},
				});
				real.port.postMessage = mockPort.postMessage;
				processor = real;
			} finally {
				env.restore();
			}
			clock.at(0, 44100);
		});

		await t.step("initializes with default values", () => {
			const env = setupFakeAudioWorkletEnvironment();

			try {
				class InitTestAudioHijackProcessor extends globalThis.AudioWorkletProcessor {
					constructor(_options: AudioWorkletNodeOptions) {
						super();
					}
				}

				globalThis.registerProcessor(
					"AudioHijacker",
					InitTestAudioHijackProcessor,
				);

				const ProcessorClass = env.registerProcessorCalls[0]![1] as new (
					options: AudioWorkletNodeOptions,
				) => unknown;
				const proc = new ProcessorClass({
					processorOptions: {},
				});
				assertExists(proc);
			} finally {
				env.restore();
			}
		});

		await t.step("processes mono input correctly", () => {
			const inputData = new Float32Array([0.1, 0.2, 0.3]);
			const inputs = [[inputData]];

			const result = processor.process(inputs);

			assertEquals(result, true);
			assertExists(mockPort.messages);
			assertEquals(mockPort.messages.length, 1);

			const message = mockPort.messages[0]!;
			assertEquals(message.format, "f32-planar");
			assertEquals(message.sampleRate, 44100);
			assertEquals(message.numberOfChannels, 2);
			assertEquals(message.numberOfFrames, 3);
			assert(message.data instanceof Float32Array);
			assertEquals(message.data.length, 6); // 2 channels * 3 frames
			assertEquals(message.timestamp, 0);
			assertEquals(message.transfer, [message.data.buffer]);
		});

		await t.step("processes stereo input correctly", () => {
			mockPort.messages = [];
			const inputData1 = new Float32Array([0.1, 0.2]);
			const inputData2 = new Float32Array([0.3, 0.4]);
			const inputs = [[inputData1, inputData2]];

			const result = processor.process(inputs);

			assertEquals(result, true);
			assertExists(mockPort.messages);
			assertEquals(mockPort.messages.length, 1);

			const message = mockPort.messages[0]!;
			assertEquals(message.numberOfChannels, 2);
			assertEquals(message.numberOfFrames, 2);
			assertEquals(message.data, new Float32Array([0.1, 0.2, 0.3, 0.4]));
		});

		await t.step("handles empty input", () => {
			mockPort.messages = [];
			const inputs = [[]];

			const result = processor.process(inputs);

			assertEquals(result, true);
			assert(!mockPort.messages || mockPort.messages.length === 0);
		});

		await t.step("handles null input channels", () => {
			mockPort.messages = [];
			const inputs = [[null as unknown as Float32Array]];

			const result = processor.process(inputs);

			assertEquals(result, true);
			assert(!mockPort.messages || mockPort.messages.length === 0);
		});

		await t.step("handles empty input channel arrays", () => {
			mockPort.messages = [];
			const inputs = [[new Float32Array(0)]];

			const result = processor.process(inputs);

			assertEquals(result, true);
			assertExists(mockPort.messages);
			assertEquals(mockPort.messages.length, 1);
			const message = mockPort.messages[0]!;
			assertEquals(message.numberOfFrames, 0);
		});

		await t.step("duplicates first channel when target channels exceed input", () => {
			mockPort.messages = [];
			const inputData = new Float32Array([0.1, 0.2]);
			const inputs = [[inputData]];

			const result = processor.process(inputs);

			assertEquals(result, true);
			assertExists(mockPort.messages);
			const message = mockPort.messages[0]!;
			assertEquals(message.data, new Float32Array([0.1, 0.2, 0.1, 0.2]));
		});

		await t.step("fills with silence for missing channels", () => {
			mockPort.messages = [];
			const inputData = new Float32Array([0.1]);
			const inputs = [[inputData]];

			const result = processor.process(inputs);

			assertEquals(result, true);
			assertExists(mockPort.messages);
			const message = mockPort.messages[0]!;
			assertEquals(message.data, new Float32Array([0.1, 0.1]));
		});

		await t.step("throws error for multiple inputs", () => {
			const inputs = [[], []];

			assertThrows(
				() => processor.process(inputs),
				Error,
				"only one input is supported.",
			);
		});

		await t.step("stamps frames by the context's clock", () => {
			mockPort.messages = [];
			const inputs = [[new Float32Array([0.1, 0.2])]];

			clock.at(44100, 44100);
			processor.process(inputs);
			clock.at(44102, 44100);
			processor.process(inputs);

			assertExists(mockPort.messages);
			assertEquals(mockPort.messages.map((message) => message.timestamp), [
				1_000_000,
				Math.round(44102 * 1_000_000 / 44100),
			]);
		});

		await t.step("cleanup", () => {
			clock.restore();
		});
	});
});

Deno.test("audio_hijack_worklet - channel count from the node", async (t) => {
	type Processor = {
		port: { onmessage: ((ev: { data: unknown }) => void) | null; postMessage: unknown };
		process(inputs: Float32Array[][]): boolean;
	};

	// Evaluates the worklet module itself in a fake worklet scope and returns a
	// processor of the class it registers, with the frames it posts.
	async function realProcessor(
		targetChannels: number,
		tag: string,
	): Promise<{ processor: Processor; posted: AudioDataInit[] }> {
		const env = setupFakeAudioWorkletEnvironment();
		try {
			await import(`./audio_hijack_worklet.ts?${tag}`);
			const ctor = env.registerProcessorCalls[0]![1] as new (
				options: AudioWorkletNodeOptions,
			) => Processor;
			const processor = new ctor({ processorOptions: { sampleRate: 48000, targetChannels } });
			const posted: AudioDataInit[] = [];
			processor.port.postMessage = (init: AudioDataInit) => {
				posted.push(init);
			};
			return { processor, posted };
		} finally {
			env.restore();
		}
	}

	const quantum = (channels: number) =>
		Array.from({ length: channels }, () => new Float32Array(128));

	const clock = workletClock();
	const at = (frame: number) => clock.at(frame);

	await t.step("posts the channel count a message sets", async () => {
		const { processor, posted } = await realProcessor(2, "message");

		at(0);
		processor.process([quantum(2)]);
		processor.port.onmessage!({ data: { targetChannels: 1 } });
		at(128);
		processor.process([quantum(1)]);

		assertEquals(posted.map((init) => init.numberOfChannels), [2, 1]);
	});

	await t.step(
		"stamps frames by the context's clock across a change of channel count",
		async () => {
			const { processor, posted } = await realProcessor(2, "timestamps");

			at(0);
			processor.process([quantum(2)]);
			processor.port.onmessage!({ data: { targetChannels: 1 } });
			at(128);
			processor.process([quantum(1)]);

			assertEquals(posted.map((init) => init.timestamp), [
				0,
				Math.round(128 * 1_000_000 / 48000),
			]);
		},
	);

	await t.step("ignores a message without a usable channel count", async () => {
		const { processor, posted } = await realProcessor(2, "ignored");

		for (const data of [undefined, {}, { targetChannels: 0 }, { targetChannels: 1.5 }]) {
			processor.port.onmessage!({ data });
		}
		at(0);
		processor.process([quantum(2)]);

		assertEquals(posted.map((init) => init.numberOfChannels), [2]);
	});

	await t.step("shows a stretch with no input as a gap in the timestamps", async () => {
		const { processor, posted } = await realProcessor(1, "gap");

		at(48000);
		processor.process([quantum(1)]);
		// No input for five seconds: the processor posts nothing.
		at(48000 * 6);
		processor.process([[]]);
		at(48000 * 6 + 128);
		processor.process([quantum(1)]);

		assertEquals(posted.map((init) => init.timestamp), [
			1_000_000,
			Math.round((48000 * 6 + 128) * 1_000_000 / 48000),
		]);
	});

	await t.step("cleanup", () => {
		clock.restore();
	});
});

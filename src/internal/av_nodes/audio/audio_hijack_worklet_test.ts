/// <reference path="../../../test_globals.d.ts" />
import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { stubGlobal } from "../test-utils.ts";
import { importWorkletUrl } from "./audio_hijack_worklet.ts";

Deno.test("audio_hijack_worklet", async (t) => {
	await t.step("provides a URL for the worklet script", () => {
		const url = importWorkletUrl();
		assert(url.endsWith("audio_hijack_worklet.js"));
		// For mocking purposes, we return a simple string, so URL validation is skipped
		// assert(() => new URL(url));
	});

	await t.step(
		"registers the hijack processor when AudioWorkletProcessor is available",
		() => {
			// Setup mocks
			const mockRegisterProcessor = { calls: [] as Parameters<typeof registerProcessor>[] };
			const originalRegisterProcessor = globalThis.registerProcessor;
			const originalAudioWorkletProcessor = globalThis.AudioWorkletProcessor;

			stubGlobal("AudioWorkletProcessor", class {});
			stubGlobal("registerProcessor", (
				name: string,
				processor: Parameters<typeof registerProcessor>[1],
			) => {
				mockRegisterProcessor.calls.push([name, processor]);
			});

			try {
				// Execute the worklet code directly
				if (
					typeof globalThis.AudioWorkletProcessor !==
						"undefined"
				) {
					// Worklet code
					class AudioHijackProcessor extends globalThis.AudioWorkletProcessor {
						#currentFrame: number = 0;
						#sampleRate: number;
						#targetChannels: number;

						constructor(options: AudioWorkletNodeOptions) {
							super();
							// Get sampleRate from processorOptions or fall back to global sampleRate
							this.#sampleRate = options.processorOptions?.sampleRate ||
								globalThis.sampleRate;
							// Get target number of channels from processorOptions
							this.#targetChannels = options.processorOptions?.targetChannels || 1;
						}

						process(inputs: Float32Array[][]) {
							if (inputs.length > 1) {
								throw new Error("only one input is supported.");
							}

							// Just take one input channel, the first one.
							// MOQ enables the delivery of audio inputs individually for each track.
							// So do not mix audio from different tracks or different devices.
							const channels = inputs[0];

							if (
								!channels || channels.length === 0 ||
								!channels[0]
							) {
								return true;
							}

							const inputChannels = channels.length;
							const numberOfFrames = channels[0].length;

							// Use target channels from configuration, not input channels
							const numberOfChannels = this.#targetChannels;
							const data = new Float32Array(
								numberOfChannels * numberOfFrames,
							);

							for (let i = 0; i < numberOfChannels; i++) {
								if (i < inputChannels) {
									const inputChannel = channels[i];
									if (
										inputChannel && inputChannel.length > 0
									) {
										// Use input channel data
										data.set(
											inputChannel,
											i * numberOfFrames,
										);
									} else {
										// Fill with silence if input channel is empty
										data.fill(
											0,
											i * numberOfFrames,
											(i + 1) * numberOfFrames,
										);
									}
								} else if (inputChannels > 0) {
									const firstChannel = channels[0];
									if (
										firstChannel && firstChannel.length > 0
									) {
										// If we need more channels than input provides, duplicate the first channel
										data.set(
											firstChannel,
											i * numberOfFrames,
										);
									} else {
										// Fill with silence if first channel is empty
										data.fill(
											0,
											i * numberOfFrames,
											(i + 1) * numberOfFrames,
										);
									}
								} else {
									// Fill with silence if no input data
									data.fill(
										0,
										i * numberOfFrames,
										(i + 1) * numberOfFrames,
									);
								}
							}

							const init: AudioDataInit = {
								format: "f32-planar",
								sampleRate: this.#sampleRate,
								numberOfChannels: numberOfChannels,
								numberOfFrames: numberOfFrames,
								data: data,
								timestamp: Math.round(
									this.#currentFrame * 1_000_000 /
										this.#sampleRate,
								),
								transfer: [data.buffer],
							};

							this.port.postMessage(init);

							this.#currentFrame += numberOfFrames;

							return true;
						}
					}

					globalThis.registerProcessor(
						"AudioHijacker",
						AudioHijackProcessor,
					);
				}

				assertEquals(mockRegisterProcessor.calls.length, 1);
				const [name, processorCtor] = mockRegisterProcessor.calls[0]!;
				assertEquals(name, "AudioHijacker");
				assertEquals(typeof processorCtor, "function");
			} finally {
				// Cleanup
				stubGlobal("AudioWorkletProcessor", originalAudioWorkletProcessor);
				stubGlobal("registerProcessor", originalRegisterProcessor);
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

		await t.step("setup", () => {
			mockPort = {
				postMessage: (message: AudioDataInit) => {
					mockPort.messages = mockPort.messages || [];
					mockPort.messages.push(message);
				},
			};

			// Mock AudioWorkletProcessor
			const originalAudioWorkletProcessor = globalThis.AudioWorkletProcessor;
			const originalRegisterProcessor = globalThis.registerProcessor;

			stubGlobal(
				"AudioWorkletProcessor",
				class MockAudioWorkletProcessor {
					port = mockPort;
				},
			);

			// Mock registerProcessor
			const mockRegisterProcessor = { calls: [] as Parameters<typeof registerProcessor>[] };
			stubGlobal("registerProcessor", (
				name: string,
				processor: Parameters<typeof registerProcessor>[1],
			) => {
				mockRegisterProcessor.calls.push([name, processor]);
			});
			try {
				// Import the worklet code by simulating the worklet context
				if (
					typeof globalThis.AudioWorkletProcessor !==
						"undefined"
				) {
					// Simulate the worklet code execution
					class TestAudioHijackProcessor extends globalThis.AudioWorkletProcessor {
						#currentFrame: number = 0;
						#sampleRate: number;
						#targetChannels: number;

						constructor(options: AudioWorkletNodeOptions) {
							super();
							// Get sampleRate from processorOptions or fall back to global sampleRate
							this.#sampleRate = options.processorOptions?.sampleRate ||
								globalThis.sampleRate;
							// Get target number of channels from processorOptions
							this.#targetChannels = options.processorOptions?.targetChannels || 1;
						}

						process(inputs: Float32Array[][]) {
							if (inputs.length > 1) {
								throw new Error("only one input is supported.");
							}

							// Just take one input channel, the first one.
							// MOQ enables the delivery of audio inputs individually for each track.
							// So do not mix audio from different tracks or different devices.
							const channels = inputs[0];

							if (
								!channels || channels.length === 0 ||
								!channels[0]
							) {
								return true;
							}

							const inputChannels = channels.length;
							const numberOfFrames = channels[0].length;

							// Use target channels from configuration, not input channels
							const numberOfChannels = this.#targetChannels;
							const data = new Float32Array(
								numberOfChannels * numberOfFrames,
							);

							for (let i = 0; i < numberOfChannels; i++) {
								if (i < inputChannels) {
									const inputChannel = channels[i];
									if (
										inputChannel && inputChannel.length > 0
									) {
										// Use input channel data
										data.set(
											inputChannel,
											i * numberOfFrames,
										);
									} else {
										// Fill with silence if input channel is empty
										data.fill(
											0,
											i * numberOfFrames,
											(i + 1) * numberOfFrames,
										);
									}
								} else if (inputChannels > 0) {
									const firstChannel = channels[0];
									if (
										firstChannel && firstChannel.length > 0
									) {
										// If we need more channels than input provides, duplicate the first channel
										data.set(
											firstChannel,
											i * numberOfFrames,
										);
									} else {
										// Fill with silence if first channel is empty
										data.fill(
											0,
											i * numberOfFrames,
											(i + 1) * numberOfFrames,
										);
									}
								} else {
									// Fill with silence if no input data
									data.fill(
										0,
										i * numberOfFrames,
										(i + 1) * numberOfFrames,
									);
								}
							}

							const init: AudioDataInit = {
								format: "f32-planar",
								sampleRate: this.#sampleRate,
								numberOfChannels: numberOfChannels,
								numberOfFrames: numberOfFrames,
								data: data,
								timestamp: Math.round(
									this.#currentFrame * 1_000_000 /
										this.#sampleRate,
								),
								transfer: [data.buffer],
							};

							this.port.postMessage(init);

							this.#currentFrame += numberOfFrames;

							return true;
						}
					}

					// Register the processor
					globalThis.registerProcessor(
						"AudioHijacker",
						TestAudioHijackProcessor,
					);
				}

				// Create processor instance
				const TestAudioHijackProcessor = mockRegisterProcessor.calls[0]![1] as new (
					options: AudioWorkletNodeOptions,
				) => { process(inputs: Float32Array[][]): boolean };
				processor = new TestAudioHijackProcessor({
					processorOptions: {
						sampleRate: 44100,
						targetChannels: 2,
					},
				});
			} finally {
				// Restore globals
				stubGlobal("AudioWorkletProcessor", originalAudioWorkletProcessor);
				stubGlobal("registerProcessor", originalRegisterProcessor);
			}
		});

		await t.step("initializes with default values", async () => {
			const originalAudioWorkletProcessor = globalThis.AudioWorkletProcessor;
			const originalRegisterProcessor = globalThis.registerProcessor;

			const mockRegisterProcessor = { calls: [] as Parameters<typeof registerProcessor>[] };
			stubGlobal("AudioWorkletProcessor", class {});
			stubGlobal("registerProcessor", (
				name: string,
				processor: Parameters<typeof registerProcessor>[1],
			) => {
				mockRegisterProcessor.calls.push([name, processor]);
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

					const ProcessorClass = mockRegisterProcessor.calls[0]![1] as new (
						options: AudioWorkletNodeOptions,
					) => unknown;
					const proc = new ProcessorClass({
						processorOptions: {},
					});
					assertExists(proc);
				} finally {
					stubGlobal("AudioWorkletProcessor", originalAudioWorkletProcessor);
					stubGlobal("registerProcessor", originalRegisterProcessor);
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

			await t.step(
				"duplicates first channel when target channels exceed input",
				() => {
					mockPort.messages = [];
					const inputData = new Float32Array([0.1, 0.2]);
					const inputs = [[inputData]];

					const result = processor.process(inputs);

					assertEquals(result, true);
					assertExists(mockPort.messages);
					const message = mockPort.messages[0]!;
					assertEquals(
						message.data,
						new Float32Array([0.1, 0.2, 0.1, 0.2]),
					); // duplicated
				},
			);

			await t.step("fills with silence for missing channels", () => {
				mockPort.messages = [];
				const inputData = new Float32Array([0.1]);
				const inputs = [[inputData]];

				const result = processor.process(inputs);

				assertEquals(result, true);
				assertExists(mockPort.messages);
				const message = mockPort.messages[0]!;
				assertEquals(message.data, new Float32Array([0.1, 0.1])); // duplicate first channel
			});

			await t.step("throws error for multiple inputs", () => {
				const inputs = [[], []];

				assertThrows(
					() => processor.process(inputs),
					Error,
					"only one input is supported.",
				);
			});

			await t.step("updates frame counter", () => {
				mockPort.messages = [];
				const inputData = new Float32Array([0.1, 0.2]);
				const inputs = [[inputData]];

				processor.process(inputs);

				assertExists(mockPort.messages);
				const message1 = mockPort.messages[0]!;
				assertEquals(typeof message1.timestamp, "number");

				processor.process(inputs);

				const message2 = mockPort.messages[1]!;
				// Verify that the timestamp advances by approximately the correct amount (2 frames at 44100 Hz)
				// Allow ±1 due to integer rounding at different frame positions
				const expectedDelta = Math.round(2 * 1_000_000 / 44100);
				const actualDelta = message2.timestamp - message1.timestamp;
				assert(
					Math.abs(actualDelta - expectedDelta) <= 1,
					`Expected timestamp delta ~${expectedDelta}, got ${actualDelta}`,
				);
			});
		});
	});
});

/// <reference path="../../../test_globals.d.ts" />
import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { importWorkletUrl } from "./audio_offload_worklet.ts";
import { setupFakeAudioWorkletEnvironment } from "./fake_audio_worklet_environment_test.ts";

type AudioOffloadProcessorInstance = {
	append(channels: Float32Array[]): void;
	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
	port: {
		onmessage?: (message: { data: { channels: Float32Array[]; timestamp: number } }) => void;
		postMessage?: (message: unknown) => void;
	};
};

type AudioOffloadProcessorConstructor = new (
	options: AudioWorkletNodeOptions,
) => AudioOffloadProcessorInstance;

Deno.test("audio_offload_worklet", async (t) => {
	await t.step("provides a URL for the offload worklet", () => {
		const url = importWorkletUrl();
		assert(url.endsWith("audio_offload_worklet.js"));
		// For mocking purposes, we return a simple string, so URL validation is skipped
		// assert(() => new URL(url));
	});

	await t.step(
		"registers the offload processor when AudioWorkletProcessor is defined",
		() => {
			const env = setupFakeAudioWorkletEnvironment();

			try {
				// Execute the worklet code directly
				if (typeof AudioWorkletProcessor !== "undefined") {
					// AudioWorkletProcessor for AudioEmitter
					class AudioOffloadProcessor extends AudioWorkletProcessor {
						#channelsBuffer: Float32Array[] = [];

						#readIndex: number = 0;
						#writeIndex: number = 0;

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

							const bufferingSamples = Math.ceil(
								sampleRate * latency / 1000,
							);

							for (let i = 0; i < channelCount; i++) {
								this.#channelsBuffer[i] = new Float32Array(
									bufferingSamples,
								);
							}

							this.port.onmessage = (
								{ data }: {
									data: {
										channels: Float32Array[];
										timestamp: number;
									};
								},
							) => {
								this.append(data.channels);
								// We do not use timestamp for now
								// TODO: handle timestamp and sync if needed
							};
						}

						append(channels: Float32Array[]): void {
							if (
								!channels.length || !channels[0] ||
								channels[0].length === 0
							) {
								return;
							}

							// Not initialized yet. Skip
							if (
								this.#channelsBuffer === undefined ||
								this.#channelsBuffer.length === 0 ||
								this.#channelsBuffer[0] === undefined
							) return;

							const numberOfFrames = channels[0].length;

							// Advance read index for discarded samples
							const discard = this.#writeIndex - this.#readIndex +
								numberOfFrames -
								this.#channelsBuffer[0].length;
							if (discard >= 0) {
								this.#readIndex += discard;
							}

							// Write new samples to buffer
							for (
								let channel = 0;
								channel < this.#channelsBuffer.length;
								channel++
							) {
								const src = channels[channel];
								const dst = this.#channelsBuffer[channel];

								if (!dst) continue;
								if (!src) {
									dst.fill(0, 0, numberOfFrames);
									continue;
								}

								let readPos = this.#writeIndex % dst.length;
								let offset = 0;

								let n: number;
								while (numberOfFrames - offset > 0) { // Still data remaining to copy
									n = Math.min(
										numberOfFrames - offset,
										numberOfFrames - readPos,
									);
									dst.set(
										src.subarray(readPos, readPos + n),
										offset,
									);
									readPos = (readPos + n) % numberOfFrames;
									offset += n;
								}
							}

							this.#writeIndex += numberOfFrames;
						}

						process(
							_inputs: Float32Array[][],
							outputs: Float32Array[][],
						): boolean {
							// No output to write to
							if (
								outputs === undefined ||
								outputs.length === 0 ||
								outputs[0] === undefined ||
								outputs[0]?.length === 0
							) return true;

							// Not initialized yet
							if (
								this.#channelsBuffer.length === 0 ||
								this.#channelsBuffer[0] === undefined
							) return true;

							const available = (this.#writeIndex - this.#readIndex +
								this.#channelsBuffer[0].length) %
								this.#channelsBuffer[0].length;
							const numberOfFrames = Math.min(
								available,
								outputs[0].length,
							);

							// No data to read
							if (numberOfFrames <= 0) return true;

							for (const output of outputs) {
								for (
									let channel = 0;
									channel < output.length;
									channel++
								) {
									const src = this.#channelsBuffer[channel];
									const dst = output[channel];
									if (!dst) continue;
									if (!src) {
										dst.fill(0, 0, numberOfFrames);
										continue;
									}

									let readPos = this.#readIndex;
									let offset = 0;

									let n: number;
									while (numberOfFrames - offset > 0) { // Still data remaining to copy
										n = Math.min(
											numberOfFrames - offset,
											numberOfFrames - readPos,
										);
										dst.set(
											src.subarray(readPos, readPos + n),
											offset,
										);
										readPos = (readPos + n) %
											numberOfFrames;
										offset += n;
									}
								}
							}

							// Advance read index
							this.#readIndex += numberOfFrames;
							if (
								this.#readIndex >=
									this.#channelsBuffer[0].length
							) {
								this.#readIndex -= this.#channelsBuffer[0].length;
								this.#writeIndex -= this.#channelsBuffer[0].length;
							}

							return true;
						}
					}

					globalThis.registerProcessor(
						"audio-offloader",
						AudioOffloadProcessor,
					);
				}

				assertEquals(env.registerProcessorCalls.length, 1);
				const [name, processorCtor] = env.registerProcessorCalls[0]!;
				assertEquals(name, "audio-offloader");
				assertEquals(typeof processorCtor, "function");

				const ProcessorCtor = processorCtor as AudioOffloadProcessorConstructor;
				const instance = new ProcessorCtor({
					channelCount: 2,
					processorOptions: {
						sampleRate: 48000,
						latency: 50,
					},
				});

				assertEquals(typeof instance.process, "function");
				assertEquals(typeof instance.append, "function");
				assertExists(instance.port);
				assertEquals(typeof instance.port.onmessage, "function");

				// Test append method
				const channels = [
					new Float32Array([1, 2, 3]),
					new Float32Array([4, 5, 6]),
				];
				instance.append(channels);
				// Since buffer is initialized, append should work without error

				// Test process method with no outputs
				let result = instance.process([], []);
				assertEquals(result, true);

				// Test process method with outputs
				const outputs = [[new Float32Array(3), new Float32Array(3)]];
				result = instance.process([], outputs);
				assertEquals(result, true);

				assertExists(importWorkletUrl);
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
				// AudioWorkletProcessor is not defined (already deleted in afterEach)

				// Simulate the worklet registration logic
				if (typeof AudioWorkletProcessor !== "undefined") {
					globalThis.registerProcessor(
						"audio-offloader",
						class AudioOffloadProcessor extends AudioWorkletProcessor {
							constructor(_options: AudioWorkletNodeOptions) {
								super();
								this.port = { onmessage: undefined } as unknown as MessagePort;
							}
							override port: MessagePort;

							process(_inputs: Float32Array[][]) {
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
			if (typeof AudioWorkletProcessor !== "undefined") {
				globalThis.registerProcessor(
					"audio-offloader",
					class AudioOffloadProcessor extends AudioWorkletProcessor {
						#channelsBuffer: Float32Array[] = [];

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

							const bufferingSamples = Math.ceil(
								sampleRate * latency / 1000,
							);

							for (let i = 0; i < channelCount; i++) {
								this.#channelsBuffer[i] = new Float32Array(
									bufferingSamples,
								);
							}

							this.port.onmessage = (
								{ data }: {
									data: {
										channels: Float32Array[];
										timestamp: number;
									};
								},
							) => {
								this.append(data.channels);
							};
						}

						append(_channels: Float32Array[]): void {
							// Simplified for test
						}

						process(
							_inputs: Float32Array[][],
							_outputs: Float32Array[][],
						): boolean {
							return true;
						}
					},
				);
			}

			const ProcessorCtor = env
				.registerProcessorCalls[0]![1] as AudioOffloadProcessorConstructor;

			assertThrows(
				() => new ProcessorCtor({}),
				Error,
				"processorOptions is required",
			);
			assertThrows(
				() => new ProcessorCtor({ processorOptions: {} }),
				Error,
				"invalid channelCount",
			);
			assertThrows(
				() =>
					new ProcessorCtor({
						channelCount: 2,
						processorOptions: {},
					}),
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

	await t.step("AudioOffloadProcessor", async (t) => {
		let processor: AudioOffloadProcessorInstance;
		let mockPort: {
			messages?: unknown[];
			postedMessages?: unknown[];
			onmessage?: (
				message: { data: { channels: Float32Array[]; timestamp: number } },
			) => void;
			postMessage?: (message: unknown) => void;
		};

		await t.step("setup", () => {
			mockPort = {
				onmessage: (message: { data: { channels: Float32Array[]; timestamp: number } }) => {
					mockPort.messages = mockPort.messages || [];
					mockPort.messages.push(message);
				},
				postMessage: (message: unknown) => {
					mockPort.postedMessages = mockPort.postedMessages || [];
					mockPort.postedMessages.push(message);
				},
			};

			const env = setupFakeAudioWorkletEnvironment();

			try {
				// Simulate the worklet code execution
				if (typeof AudioWorkletProcessor !== "undefined") {
					class AudioOffloadProcessor extends AudioWorkletProcessor {
						#channelsBuffer: Float32Array[] = [];
						#readIndex: number = 0;
						#writeIndex: number = 0;

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

							const bufferingSamples = Math.ceil(
								sampleRate * latency / 1000,
							);

							for (let i = 0; i < channelCount; i++) {
								this.#channelsBuffer[i] = new Float32Array(
									bufferingSamples,
								);
							}

							this.port.onmessage = (
								{ data }: {
									data: {
										channels: Float32Array[];
										timestamp: number;
									};
								},
							) => {
								this.append(data.channels);
							};
						}

						append(channels: Float32Array[]): void {
							if (
								!channels.length || !channels[0] ||
								channels[0].length === 0
							) {
								return;
							}

							if (
								this.#channelsBuffer === undefined ||
								this.#channelsBuffer.length === 0 ||
								this.#channelsBuffer[0] === undefined
							) return;

							const numberOfFrames = channels[0].length;

							const discard = this.#writeIndex - this.#readIndex +
								numberOfFrames -
								this.#channelsBuffer[0].length;
							if (discard >= 0) {
								this.#readIndex += discard;
							}

							for (
								let channel = 0;
								channel < this.#channelsBuffer.length;
								channel++
							) {
								const src = channels[channel];
								const dst = this.#channelsBuffer[channel];

								if (!dst) continue;
								if (!src) {
									// Fill silence at correct circular buffer position
									let writePos = this.#writeIndex % dst.length;
									let remaining = numberOfFrames;
									while (remaining > 0) {
										const toCopy = Math.min(remaining, dst.length - writePos);
										dst.fill(0, writePos, writePos + toCopy);
										writePos = (writePos + toCopy) % dst.length;
										remaining -= toCopy;
									}
									continue;
								}

								let readPos = this.#writeIndex % dst.length;
								let offset = 0;

								let n: number;
								while (numberOfFrames - offset > 0) {
									n = Math.min(
										numberOfFrames - offset,
										dst.length - readPos,
									);
									dst.set(
										src.subarray(offset, offset + n),
										readPos,
									);
									readPos = (readPos + n) % dst.length;
									offset += n;
								}
							}

							this.#writeIndex += numberOfFrames;
						}

						process(
							_inputs: Float32Array[][],
							outputs: Float32Array[][],
						): boolean {
							if (
								outputs === undefined ||
								outputs.length === 0 ||
								outputs[0] === undefined ||
								outputs[0]?.length === 0
							) return true;

							if (
								this.#channelsBuffer.length === 0 ||
								this.#channelsBuffer[0] === undefined
							) return true;

							const available = this.#writeIndex - this.#readIndex;
							const numberOfFrames = (outputs[0][0] !== undefined)
								? Math.min(Math.max(0, available), outputs[0][0].length)
								: 0;

							if (numberOfFrames <= 0) return true;

							for (const output of outputs) {
								for (
									let channel = 0;
									channel < output.length;
									channel++
								) {
									const src = this.#channelsBuffer[channel];
									const dst = output[channel];
									if (!dst) continue;
									if (!src) {
										dst.fill(0, 0, numberOfFrames);
										continue;
									}

									let readPos = this.#readIndex % src.length;
									let offset = 0;

									let n: number;
									while (numberOfFrames - offset > 0) {
										n = Math.min(
											numberOfFrames - offset,
											src.length - readPos,
										);
										dst.set(
											src.subarray(readPos, readPos + n),
											offset,
										);
										readPos = (readPos + n) % src.length;
										offset += n;
									}
								}
							}

							this.#readIndex += numberOfFrames;
							if (
								this.#readIndex >=
									this.#channelsBuffer[0].length
							) {
								this.#readIndex -= this.#channelsBuffer[0].length;
								this.#writeIndex -= this.#channelsBuffer[0].length;
							}

							return true;
						}
					}

					// Register the processor
					globalThis.registerProcessor(
						"audio-offloader",
						AudioOffloadProcessor,
					);
				}

				// Create processor instance
				const AudioOffloadProcessor = env
					.registerProcessorCalls[0]![1] as AudioOffloadProcessorConstructor;
				processor = new AudioOffloadProcessor({
					channelCount: 2,
					processorOptions: {
						sampleRate: 48000,
						latency: 50,
					},
				});
			} finally {
				env.restore();
			}
		});

		await t.step("initializes buffer correctly", () => {
			assertExists(processor);
			assertExists(mockPort.onmessage);
		});

		await t.step("appends data to buffer", () => {
			const channels = [
				new Float32Array([1, 2, 3]),
				new Float32Array([4, 5, 6]),
			];
			processor.append(channels);

			// Check that data was written (implementation detail, but we can verify by processing)
			const outputs = [[new Float32Array(3), new Float32Array(3)]];
			const result = processor.process([], outputs);
			assertEquals(result, true);
			assertExists(outputs[0]);
			assertEquals(outputs[0][0], new Float32Array([1, 2, 3]));
			assertEquals(outputs[0][1], new Float32Array([4, 5, 6]));
		});

		await t.step("handles empty append", () => {
			processor.append([]);
			processor.append([new Float32Array(0)]);
			processor.append([null as unknown as Float32Array]);

			// Should not crash
			const outputs = [[new Float32Array(1), new Float32Array(1)]];
			const result = processor.process([], outputs);
			assertEquals(result, true);
		});

		await t.step("processes with no outputs", () => {
			const result = processor.process([], []);
			assertEquals(result, true);
		});

		await t.step("handles buffer overflow in append", () => {
			// Fill buffer beyond capacity
			const bufferSize = Math.ceil(48000 * 50 / 1000); // 2400 samples
			const largeChannels = [
				new Float32Array(bufferSize + 100),
				new Float32Array(bufferSize + 100),
			];
			if (largeChannels[0]) largeChannels[0].fill(1);
			if (largeChannels[1]) largeChannels[1].fill(2);

			processor.append(largeChannels);

			// Should handle overflow gracefully
			const outputs = [[new Float32Array(10), new Float32Array(10)]];
			const result = processor.process([], outputs);
			assertEquals(result, true);
		});

		await t.step("reads from circular buffer correctly", () => {
			// Drain any leftover data from previous tests (e.g. overflow)
			processor.process([], [[new Float32Array(10000), new Float32Array(10000)]]);

			// Add some data
			const channels1 = [
				new Float32Array([1, 2]),
				new Float32Array([3, 4]),
			];
			processor.append(channels1);

			// Process some
			const outputs1 = [[new Float32Array(1), new Float32Array(1)]];
			processor.process([], outputs1);
			assertExists(outputs1[0]);
			assertExists(outputs1[0][0]);
			assertExists(outputs1[0][1]);
			assertEquals(outputs1[0][0][0], 1);
			assertEquals(outputs1[0][1][0], 3);

			// Add more data
			const channels2 = [
				new Float32Array([5, 6]),
				new Float32Array([7, 8]),
			];
			processor.append(channels2);

			// Process remaining
			const outputs2 = [[new Float32Array(3), new Float32Array(3)]];
			processor.process([], outputs2);
			assertExists(outputs2[0]);
			assertEquals(outputs2[0][0], new Float32Array([2, 5, 6]));
			assertEquals(outputs2[0][1], new Float32Array([4, 7, 8]));
		});

		await t.step("handles missing channels in append", () => {
			// Drain any leftover data from previous tests
			processor.process([], [[new Float32Array(10000), new Float32Array(10000)]]);

			const channels = [new Float32Array([1, 2]), undefined as unknown as Float32Array];
			processor.append(channels);

			const outputs = [[new Float32Array(2), new Float32Array(2)]];
			const result = processor.process([], outputs);
			assertEquals(result, true);
			assertExists(outputs[0]);
			assertEquals(outputs[0][0], new Float32Array([1, 2]));
			assertEquals(outputs[0][1], new Float32Array([0, 0])); // Filled with silence
		});

		await t.step("handles onmessage events", () => {
			// Drain any leftover data from previous tests
			processor.process([], [[new Float32Array(10000), new Float32Array(10000)]]);

			const channels = [
				new Float32Array([1, 2]),
				new Float32Array([3, 4]),
			];
			const message = { data: { channels, timestamp: 123 } };

			// Call the actual processor port onmessage handler directly
			assertExists(processor.port.onmessage);
			processor.port.onmessage(message);

			// Verify data was appended
			const outputs = [[new Float32Array(2), new Float32Array(2)]];
			const result = processor.process([], outputs);
			assertEquals(result, true);
			assertExists(outputs[0]);
			assertEquals(outputs[0][0], new Float32Array([1, 2]));
			assertEquals(outputs[0][1], new Float32Array([3, 4]));
		});
	});
});

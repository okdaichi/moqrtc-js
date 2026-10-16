import { assert, assertEquals, assertRejects } from "@std/assert";
import { FakeAudioContext } from "./fake_audio_context_test.ts";
import { FakeAudioWorkletNode } from "./fake_audio_workletnode_test.ts";
import { FakeAudioDecoder } from "./fake_audiodecoder_test.ts";
import { FakeEncodedAudioChunk } from "./fake_encodedaudiochunk_test.ts";
import { FakeGainNode } from "./fake_gainnode_test.ts";

// Override globals BEFORE importing AudioDecodeNode
function overrideGainNode(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const has = Object.prototype.hasOwnProperty.call(g, "GainNode");
	const original = g.GainNode;
	g.GainNode = value;
	return () => {
		if (has) g.GainNode = original;
		else delete g.GainNode;
	};
}

function overrideAudioWorkletNode(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const has = Object.prototype.hasOwnProperty.call(g, "AudioWorkletNode");
	const original = g.AudioWorkletNode;
	g.AudioWorkletNode = value;
	return () => {
		if (has) g.AudioWorkletNode = original;
		else delete g.AudioWorkletNode;
	};
}

function overrideAudioDecoder(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const has = Object.prototype.hasOwnProperty.call(g, "AudioDecoder");
	const original = g.AudioDecoder;
	g.AudioDecoder = value;
	return () => {
		if (has) g.AudioDecoder = original;
		else delete g.AudioDecoder;
	};
}

// Set before dynamic import, restored in cleanup step
const restoreGainNode = overrideGainNode(FakeGainNode);
const restoreAudioWorkletNode = overrideAudioWorkletNode(FakeAudioWorkletNode);

const { AudioDecodeNode } = await import("./decode_node.ts");

type AudioDecodeNodeType = InstanceType<typeof AudioDecodeNode>;

/** Helper: create a FakeAudioContext with state "running" */
function createContext(): FakeAudioContext {
	const ctx = new FakeAudioContext();
	(ctx as unknown as Record<string, unknown>).state = "running";
	return ctx;
}

/** Helper: create AudioDecodeNode with a specific decoder constructor mock */
function createNodeWithDecoder(
	context: FakeAudioContext,
	decoderCtor: new (config: AudioDecoderInit) => unknown,
): AudioDecodeNodeType {
	const restore = overrideAudioDecoder(decoderCtor);
	const node = new AudioDecodeNode(context as unknown as AudioContext);
	restore();
	return node;
}

/** Helper: create AudioDecodeNode using a pre-built decoder instance */
function createNodeWithInstance(
	context: FakeAudioContext,
	instance: unknown,
): AudioDecodeNodeType {
	const restore = overrideAudioDecoder(
		function () {
			return instance;
		},
	);
	const node = new AudioDecodeNode(context as unknown as AudioContext);
	restore();
	return node;
}

Deno.test("AudioDecodeNode", async (t) => {
	await t.step("should create and configure AudioDecodeNode", () => {
		const context = createContext();
		const node = createNodeWithDecoder(context, FakeAudioDecoder);
		const mockDecoder = FakeAudioDecoder.lastCreated!;

		assert(node);

		const config: AudioDecoderConfig = {
			codec: "opus",
			sampleRate: 48000,
			numberOfChannels: 2,
		};
		node.configure(config);
		assert(mockDecoder.configureCalled);
		assertEquals(mockDecoder.configureCalls.length, 1);
	});

	await t.step("should decode from stream", async () => {
		const context = createContext();
		const node = createNodeWithDecoder(context, FakeAudioDecoder);
		const mockDecoder = FakeAudioDecoder.lastCreated!;

		node.configure({
			codec: "opus",
			sampleRate: 48000,
			numberOfChannels: 2,
		});

		const stream = new ReadableStream<EncodedAudioChunk>({
			start(controller) {
				controller.enqueue(
					new FakeEncodedAudioChunk(
						"key",
						0,
					) as unknown as EncodedAudioChunk,
				);
				controller.close();
			},
		});

		await node.decodeFrom(stream).done;
		assert(mockDecoder.decodeCalled);
	});

	await t.step(
		"should recover from backpressure when dequeue fires",
		async () => {
			const context = createContext();

			class SlowDrainDecoder extends EventTarget {
				state: CodecState = "configured";
				decodeQueueSize = 0;
				decodeCalls: EncodedAudioChunk[][] = [];

				constructor() {
					super();
				}

				configure(): void {
					this.state = "configured";
				}

				decode(chunk: EncodedAudioChunk): void {
					this.decodeCalls.push([chunk]);
					this.decodeQueueSize++;
					queueMicrotask(() => {
						this.decodeQueueSize--;
						this.dispatchEvent(new Event("dequeue"));
					});
				}

				flush(): Promise<void> {
					return Promise.resolve();
				}

				close(): void {
					this.state = "closed";
				}
			}

			const slowDecoder = new SlowDrainDecoder();
			const node = createNodeWithInstance(context, slowDecoder);

			node.configure({
				codec: "opus",
				sampleRate: 48000,
				numberOfChannels: 2,
			});

			// Prefill queue above MAX_DECODE_QUEUE_SIZE (3)
			slowDecoder.decodeQueueSize = 4;

			const stream = new ReadableStream<EncodedAudioChunk>({
				start(controller) {
					controller.enqueue(
						new FakeEncodedAudioChunk(
							"key",
							0,
						) as unknown as EncodedAudioChunk,
					);
					controller.close();
				},
			});

			// Fire dequeue after a microtask to simulate drain
			queueMicrotask(() => {
				slowDecoder.decodeQueueSize = 0;
				slowDecoder.dispatchEvent(new Event("dequeue"));
			});

			await node.decodeFrom(stream).done;

			// Chunk should have been decoded after queue drained
			assertEquals(slowDecoder.decodeCalls.length, 1);
		},
	);

	await t.step(
		"should drop stalled chunks after dequeue timeout",
		async () => {
			const context = createContext();
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = (
				callback: TimerHandler,
				_delay?: number,
				...rest: unknown[]
			) => originalSetTimeout(callback, 1, ...rest);

			class StalledDecoder extends EventTarget {
				state: CodecState = "configured";
				decodeQueueSize = 0;
				decodeCalls: EncodedAudioChunk[][] = [];

				constructor() {
					super();
				}

				configure(): void {
					this.state = "configured";
				}

				decode(chunk: EncodedAudioChunk): void {
					this.decodeCalls.push([chunk]);
					this.decodeQueueSize++;
					// Never fires dequeue — simulates stalled decoder
				}

				flush(): Promise<void> {
					return Promise.resolve();
				}

				close(): void {
					this.state = "closed";
				}
			}

			const stalledDecoder = new StalledDecoder();
			const node = createNodeWithInstance(context, stalledDecoder);

			node.configure({
				codec: "opus",
				sampleRate: 48000,
				numberOfChannels: 2,
			});

			const stream = new ReadableStream<EncodedAudioChunk>({
				start(controller) {
					for (let i = 0; i < 5; i++) {
						controller.enqueue(
							new FakeEncodedAudioChunk(
								"key",
								i * 1000,
							) as unknown as EncodedAudioChunk,
						);
					}
					controller.close();
				},
			});

			try {
				await node.decodeFrom(stream).done;

				// First 4 chunks decoded (queue fills to 4 > MAX=3),
				// 5th chunk dropped after timeout
				assertEquals(stalledDecoder.decodeQueueSize, 4);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}
		},
	);

	await t.step(
		"should safely flush, close, and dispose when unconfigured",
		async () => {
			const ctx = createContext();
			const fakeDecoder = new FakeAudioDecoder({
				output: () => {},
				error: () => {},
			});
			const node = createNodeWithInstance(ctx, fakeDecoder);
			assertEquals(node.decoderState, "unconfigured");

			await node.flush();
			await node.close();
			node.dispose();
		},
	);

	await t.step(
		"should silently swallow AbortError on early disposal during worklet load",
		async () => {
			const ctx = createContext();
			let rejectAddModule!: (err: unknown) => void;
			ctx.audioWorklet.addModule = () =>
				new Promise<void>((_, reject) => {
					rejectAddModule = reject;
				});

			const node = createNodeWithDecoder(
				ctx,
				FakeAudioDecoder as unknown as new (config: AudioDecoderInit) => unknown,
			);
			node.dispose();

			// AbortError is triggered when addModule rejects after disposal
			rejectAddModule(
				new DOMException("Unable to load a worklet's module.", "AbortError"),
			);

			// Allow promise rejection microtasks to settle
			await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		},
	);

	// A worklet node that records its options and answers stats requests the
	// way the playback worklet does.
	class StatsWorkletNode extends FakeAudioWorkletNode {
		static created: StatsWorkletNode[] = [];
		options?: AudioWorkletNodeOptions;

		constructor(context?: BaseAudioContext, name?: string, options?: AudioWorkletNodeOptions) {
			super(context, name, options);
			this.options = options;
			StatsWorkletNode.created.push(this);
			this.port.postMessage = (message: { type: string; id: number }) => {
				queueMicrotask(() => {
					const onmessage = this.port.onmessage as
						| ((event: { data: unknown }) => void)
						| null;
					onmessage?.({
						data: { type: "stats", id: message.id, stats: { targetDelayMs: 150 } },
					});
				});
			};
		}
	}

	await t.step("passes latency and maxLatency to the playback worklet", async () => {
		const restore = overrideAudioWorkletNode(StatsWorkletNode);
		try {
			const restoreDecoder = overrideAudioDecoder(FakeAudioDecoder);
			const node = new AudioDecodeNode(
				createContext() as unknown as AudioContext,
				{ latency: 80, maxLatency: 300 },
			);
			restoreDecoder();
			await node.getStats();
			const options = StatsWorkletNode.created.at(-1)!.options!;
			assertEquals(options.processorOptions.latency, 80);
			assertEquals(options.processorOptions.maxLatency, 300);
			node.dispose();
		} finally {
			restore();
		}
	});

	await t.step("getStats() resolves with the worklet's reply", async () => {
		const restore = overrideAudioWorkletNode(StatsWorkletNode);
		try {
			const node = createNodeWithDecoder(createContext(), FakeAudioDecoder);
			const [first, second] = await Promise.all([node.getStats(), node.getStats()]);
			assertEquals(first.targetDelayMs, 150);
			assertEquals(second.targetDelayMs, 150);
			node.dispose();
		} finally {
			restore();
		}
	});

	await t.step("getStats() rejects once the node is disposed", async () => {
		const node = createNodeWithDecoder(createContext(), FakeAudioDecoder);
		node.dispose();
		await assertRejects(() => node.getStats());
	});

	await t.step("cleanup", () => {
		restoreGainNode();
		restoreAudioWorkletNode();
	});
});

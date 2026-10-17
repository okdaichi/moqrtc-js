import { assert, assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import type { AudioPlayoutStats } from "./audio_playback_stats.ts";
import { isStopMessage, OFFLOAD_PROCESSOR_NAME } from "./audio_worklet_protocol.ts";
import type { AudioDecodeNodeInit } from "./decode_node.ts";
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

const {
	AudioDecodeNode,
	AudioDecodeNodeDisposedError,
	AudioDecodeNodeOptionError,
	AudioPlaybackStatsTimeoutError,
	AudioPlaybackUnavailableError,
} = await import("./decode_node.ts");

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
	init?: AudioDecodeNodeInit,
): AudioDecodeNodeType {
	const restore = overrideAudioDecoder(decoderCtor);
	try {
		return new AudioDecodeNode(context as unknown as AudioContext, init);
	} finally {
		restore();
	}
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

	const statsWith = (targetDelayMs: number): AudioPlayoutStats => ({
		targetDelayMs,
		delayMs: 0,
		bufferLevelMs: 0,
		receivedBlocks: 0,
		lateBlocks: 0,
		droppedBlocks: 0,
		underruns: 0,
		expands: 0,
		expandedMs: 0,
		accelerates: 0,
		acceleratedMs: 0,
		resyncs: 0,
		reanchors: 0,
	});

	// The id of a stats request the node posted.
	const requestId = (message: unknown): number => {
		if (
			typeof message === "object" && message !== null && "id" in message &&
			typeof message.id === "number"
		) {
			return message.id;
		}
		throw new TypeError("not a stats request");
	};

	// Replies with a snapshot whose targetDelayMs is the request id.
	const echo = (message: unknown): readonly unknown[] => {
		const id = requestId(message);
		return [{ type: "stats", id, stats: statsWith(id) }];
	};

	// The playback worklet's port: records what the node posts, answers each
	// message but a stop with `respond(message)`, and throws `postError` when set.
	class FakePlaybackPort {
		readonly sent: unknown[] = [];
		onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
		respond: (message: unknown) => readonly unknown[] = () => [];
		postError: Error | null = null;
		closed = false;

		constructor(private readonly onPost: () => void) {}

		postMessage(message: unknown): void {
			if (this.postError !== null) throw this.postError;
			this.sent.push(message);
			this.onPost();
			if (isStopMessage(message)) return;
			for (const data of this.respond(message)) {
				queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data })));
			}
		}

		close(): void {
			this.closed = true;
		}
	}

	// Installs a fake AudioWorkletNode for one test. `configure` sets up each
	// node's port; `posted` resolves when the node first posts to a worklet.
	function installPlaybackWorklet(configure: (port: FakePlaybackPort) => void = () => {}) {
		const created: FakePlaybackWorkletNode[] = [];
		const posted = Promise.withResolvers<void>();
		class FakePlaybackWorkletNode {
			readonly port = new FakePlaybackPort(() => posted.resolve());
			onprocessorerror: ((event: Event) => void) | null = null;
			readonly name: string;
			readonly options: AudioWorkletNodeOptions | undefined;

			constructor(_context: unknown, name: string, options?: AudioWorkletNodeOptions) {
				this.name = name;
				this.options = options;
				configure(this.port);
				created.push(this);
			}

			connect(): void {}
			disconnect(): void {}
		}
		const restore = overrideAudioWorkletNode(FakePlaybackWorkletNode);
		return { created, posted: posted.promise, restore };
	}

	const createNode = (init?: AudioDecodeNodeInit, context = createContext()) =>
		createNodeWithDecoder(context, FakeAudioDecoder, init);

	const workletOptions = [
		{
			name: "latency and maxLatency",
			init: { latency: 80, maxLatency: 300 },
			expected: { latency: 80, maxLatency: 300 },
		},
		{ name: "the defaults", init: {}, expected: { latency: 100, maxLatency: 400 } },
		{
			name: "a latency above the default maxLatency",
			init: { latency: 500 },
			expected: { latency: 500, maxLatency: 500 },
		},
		{
			name: "maxLatency equal to latency",
			init: { latency: 80, maxLatency: 80 },
			expected: { latency: 80, maxLatency: 80 },
		},
	] as const;
	for (const c of workletOptions) {
		await t.step(`passes ${c.name} to the playback worklet`, async () => {
			const worklet = installPlaybackWorklet((port) => (port.respond = echo));
			try {
				const node = createNode(c.init);

				await node.getStats();

				const [created] = worklet.created;
				assertExists(created);
				assertEquals(created.options?.processorOptions, {
					sampleRate: 44100,
					...c.expected,
				});
				node.dispose();
			} finally {
				worklet.restore();
			}
		});
	}

	const invalidInits = [
		{ name: "latency 0", init: { latency: 0 }, option: "latency" },
		{ name: "latency -1", init: { latency: -1 }, option: "latency" },
		{ name: "latency NaN", init: { latency: NaN }, option: "latency" },
		{ name: "latency Infinity", init: { latency: Infinity }, option: "latency" },
		{ name: "maxLatency 0", init: { maxLatency: 0 }, option: "maxLatency" },
		{ name: "maxLatency NaN", init: { maxLatency: NaN }, option: "maxLatency" },
		{ name: "maxLatency Infinity", init: { maxLatency: Infinity }, option: "maxLatency" },
		{
			name: "maxLatency below latency",
			init: { latency: 100, maxLatency: 99 },
			option: "maxLatency",
		},
	] as const;
	for (const c of invalidInits) {
		await t.step(`rejects ${c.name}`, () => {
			const error = assertThrows(() => createNode(c.init), AudioDecodeNodeOptionError);

			assertEquals(error.option, c.option);
		});
	}

	await t.step("getStats() resolves each request with its own reply", async () => {
		const worklet = installPlaybackWorklet((port) => (port.respond = echo));
		try {
			const node = createNode();

			const replies = await Promise.all([node.getStats(), node.getStats()]);

			assertEquals(replies.map((stats) => stats.targetDelayMs), [0, 1]);
			node.dispose();
		} finally {
			worklet.restore();
		}
	});

	await t.step("getStats() ignores malformed replies and replies to other requests", async () => {
		const worklet = installPlaybackWorklet((port) => {
			port.respond = (message) => {
				const id = requestId(message);
				return [
					{ type: "stats", id: id + 100, stats: statsWith(1) },
					{ type: "stats", id, stats: { targetDelayMs: 2 } },
					{ type: "flush", id },
					null,
					{ type: "stats", id, stats: statsWith(3) },
				];
			};
		});
		try {
			const node = createNode();

			const stats = await node.getStats();

			assertEquals(stats.targetDelayMs, 3);
			node.dispose();
		} finally {
			worklet.restore();
		}
	});

	await t.step("getStats() rejects once the node is disposed", async () => {
		const worklet = installPlaybackWorklet();
		try {
			const node = createNode();

			node.dispose();

			await assertRejects(() => node.getStats(), AudioDecodeNodeDisposedError);
		} finally {
			worklet.restore();
		}
	});

	await t.step("getStats() rejects when the node is disposed while waiting", async () => {
		const worklet = installPlaybackWorklet();
		try {
			const node = createNode();
			const pending = node.getStats();
			await worklet.posted;

			node.dispose();

			await assertRejects(() => pending, AudioDecodeNodeDisposedError);
		} finally {
			worklet.restore();
		}
	});

	await t.step("getStats() rejects when posting to the worklet fails", async () => {
		const postError = new DOMException("port closed", "InvalidStateError");
		const worklet = installPlaybackWorklet((port) => (port.postError = postError));
		try {
			const node = createNode();

			const error = await assertRejects(() => node.getStats(), AudioPlaybackUnavailableError);

			assertEquals(error.cause, postError);
			node.dispose();
		} finally {
			worklet.restore();
		}
	});

	await t.step("getStats() rejects when the worklet's processor fails", async () => {
		const worklet = installPlaybackWorklet();
		try {
			const node = createNode();
			const pending = node.getStats();
			await worklet.posted;
			const [created] = worklet.created;
			assertExists(created);

			created.onprocessorerror?.(new Event("processorerror"));

			await assertRejects(() => pending, AudioPlaybackUnavailableError);
			node.dispose();
		} finally {
			worklet.restore();
		}
	});

	await t.step("getStats() rejects when the worklet fails to load", async () => {
		const loadError = new Error("module failed to load");
		const context = createContext();
		context.audioWorklet.addModule = () => Promise.reject(loadError);
		const node = createNode({}, context);

		const error = await assertRejects(() => node.getStats(), AudioPlaybackUnavailableError);

		assertEquals(error.cause, loadError);
		node.dispose();
	});

	await t.step("getStats() rejects when the worklet does not reply in time", async () => {
		const worklet = installPlaybackWorklet();
		try {
			const node = createNode();

			const error = await assertRejects(
				() => node.getStats({ timeoutMs: 1 }),
				AudioPlaybackStatsTimeoutError,
			);

			assertEquals(error.timeoutMs, 1);
			node.dispose();
		} finally {
			worklet.restore();
		}
	});

	await t.step("getStats() rejects a timeout that is not positive", async () => {
		const node = createNode();

		await assertRejects(() => node.getStats({ timeoutMs: 0 }), RangeError);

		node.dispose();
	});

	await t.step("getStats() rejects waiting requests when the context closes", async () => {
		const worklet = installPlaybackWorklet();
		try {
			const context = createContext();
			const node = createNode({}, context);
			const pending = node.getStats();
			await worklet.posted;

			context.state = "closed";
			context.dispatchEvent(new Event("statechange"));

			await assertRejects(() => pending, AudioPlaybackUnavailableError);
			node.dispose();
		} finally {
			worklet.restore();
		}
	});

	await t.step("getStats() rejects at once on a closed context", async () => {
		const worklet = installPlaybackWorklet((port) => (port.respond = echo));
		try {
			const context = createContext();
			const node = createNode({}, context);
			context.state = "closed";

			await assertRejects(() => node.getStats(), AudioPlaybackUnavailableError);

			assertEquals(worklet.created.flatMap((created) => created.port.sent), []);
			node.dispose();
		} finally {
			worklet.restore();
		}
	});

	await t.step("adds its worklet module to a context once for many nodes", async () => {
		const worklet = installPlaybackWorklet((port) => (port.respond = echo));
		try {
			const context = createContext();
			const modules: string[] = [];
			context.audioWorklet.addModule = async (moduleUrl: string) => {
				modules.push(moduleUrl);
			};

			const nodes = Array.from({ length: 5 }, () => createNode({}, context));
			await Promise.all(nodes.map((node) => node.getStats()));

			assertEquals(
				{ modules: modules.length, worklets: worklet.created.length },
				{ modules: 1, worklets: 5 },
			);
			for (const node of nodes) node.dispose();
		} finally {
			worklet.restore();
		}
	});

	await t.step("dispose() tells the playback worklet's processor to stop", async () => {
		const worklet = installPlaybackWorklet((port) => (port.respond = echo));
		try {
			const node = createNode();
			await node.getStats();
			const [created] = worklet.created;
			assertExists(created);

			node.dispose();

			assertEquals(
				{ last: created.port.sent.at(-1), closed: created.port.closed },
				{ last: { type: "stop" }, closed: true },
			);
		} finally {
			worklet.restore();
		}
	});

	// A chunk of a scripted stream, and the context's state when it is read.
	interface ScriptedRead {
		readonly state: AudioContextState;
		readonly timestamp: number;
	}

	// A stream that, as each chunk is read, first sets the context to that
	// chunk's state; it closes after the last chunk. `cancelled` tells whether
	// the stream was cancelled.
	function scriptedStream(context: FakeAudioContext, reads: readonly ScriptedRead[]) {
		const pending = [...reads];
		const source = {
			cancelled: false,
			stream: new ReadableStream<EncodedAudioChunk>({
				pull(controller) {
					const next = pending.shift();
					if (next === undefined) {
						controller.close();
						return;
					}
					context.state = next.state;
					controller.enqueue(new FakeEncodedAudioChunk("key", next.timestamp));
				},
				cancel() {
					source.cancelled = true;
				},
			}, { highWaterMark: 0 }),
		};
		return source;
	}

	const contextStates: readonly {
		readonly name: string;
		readonly reads: readonly ScriptedRead[];
		readonly expected: { readonly decoded: readonly number[]; readonly cancelled: boolean };
	}[] = [
		{
			name: "decodes every chunk read while the context runs",
			reads: [{ state: "running", timestamp: 0 }, { state: "running", timestamp: 1 }],
			expected: { decoded: [0, 1], cancelled: false },
		},
		{
			name: "drops the chunks read before the context first runs",
			reads: [
				{ state: "suspended", timestamp: 0 },
				{ state: "suspended", timestamp: 1 },
				{ state: "running", timestamp: 2 },
			],
			expected: { decoded: [2], cancelled: false },
		},
		{
			name: "decodes again once a suspended context runs again",
			reads: [
				{ state: "running", timestamp: 0 },
				{ state: "suspended", timestamp: 1 },
				{ state: "running", timestamp: 2 },
			],
			expected: { decoded: [0, 2], cancelled: false },
		},
		{
			name: "stops reading and cancels the stream when the context closes",
			reads: [
				{ state: "running", timestamp: 0 },
				{ state: "closed", timestamp: 1 },
				{ state: "running", timestamp: 2 },
			],
			expected: { decoded: [0], cancelled: true },
		},
	];
	for (const c of contextStates) {
		await t.step(`decodeFrom() ${c.name}`, async () => {
			const context = createContext();
			const node = createNode({}, context);
			const decoder = FakeAudioDecoder.lastCreated;
			assertExists(decoder);
			node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
			const source = scriptedStream(context, c.reads);

			await node.decodeFrom(source.stream).done;

			assertEquals(
				{
					decoded: decoder.decodeCalls.flat().map((chunk) => chunk.timestamp),
					cancelled: source.cancelled,
				},
				c.expected,
			);
			node.dispose();
		});
	}

	await t.step("creates the playback worklet under the processor's versioned name", async () => {
		const worklet = installPlaybackWorklet((port) => (port.respond = echo));
		try {
			const node = createNode();

			await node.getStats();

			assertEquals(worklet.created.map((created) => created.name), [OFFLOAD_PROCESSOR_NAME]);
			node.dispose();
		} finally {
			worklet.restore();
		}
	});

	await t.step("a failed worklet load leaves no unhandled rejection", async () => {
		const rejections: unknown[] = [];
		const onRejection = (event: PromiseRejectionEvent) => {
			event.preventDefault();
			rejections.push(event.reason);
		};
		globalThis.addEventListener("unhandledrejection", onRejection);
		try {
			const context = createContext();
			context.audioWorklet.addModule = () =>
				Promise.reject(new Error("module failed to load"));

			const node = createNode({}, context);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));

			assertEquals(rejections, []);
			node.dispose();
		} finally {
			globalThis.removeEventListener("unhandledrejection", onRejection);
		}
	});

	await t.step(
		"getStats() counts the chunks dropped while the context was not running",
		async () => {
			const worklet = installPlaybackWorklet((port) => (port.respond = echo));
			try {
				const context = createContext();
				const node = createNode({}, context);
				node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
				const source = scriptedStream(context, [
					{ state: "suspended", timestamp: 0 },
					{ state: "suspended", timestamp: 1 },
					{ state: "running", timestamp: 2 },
				]);
				await node.decodeFrom(source.stream).done;

				const stats = await node.getStats();

				assertEquals(stats.droppedWhileSuspended, 2);
				node.dispose();
			} finally {
				worklet.restore();
			}
		},
	);

	await t.step("decodeFrom() cancels a pending read when the context closes", async () => {
		const context = createContext();
		const node = createNode({}, context);
		let cancelled = false;
		// A stream that never yields a chunk: reading waits on it.
		const { done } = node.decodeFrom(
			new ReadableStream<EncodedAudioChunk>({
				cancel() {
					cancelled = true;
				},
			}),
		);

		context.state = "closed";
		context.dispatchEvent(new Event("statechange"));

		assertEquals(cancelled, true);
		await done;
		node.dispose();
	});

	await t.step(
		"dispose() cancels the latest decodeFrom stream after an earlier one ended",
		async () => {
			const node = createNode();
			let endFirst = (): void => {};
			const first = node.decodeFrom(
				new ReadableStream<EncodedAudioChunk>({
					start(controller) {
						endFirst = () => controller.close();
					},
				}),
			);
			let cancelled = false;
			const second = node.decodeFrom(
				new ReadableStream<EncodedAudioChunk>({
					cancel() {
						cancelled = true;
					},
				}),
			);
			endFirst();
			await first.done;

			node.dispose();

			assertEquals(cancelled, true);
			await second.done;
		},
	);

	await t.step("decodeFrom() cancels the stream when the node is disposed", async () => {
		const node = createNode();
		let cancelled = false;
		// A stream that never yields a chunk: reading waits on it.
		const stream = new ReadableStream<EncodedAudioChunk>({
			cancel() {
				cancelled = true;
			},
		});
		const { done } = node.decodeFrom(stream);

		node.dispose();
		await done;

		assertEquals(cancelled, true);
	});

	await t.step("cleanup", () => {
		restoreGainNode();
		restoreAudioWorkletNode();
	});
});

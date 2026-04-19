import { assert, assertEquals } from "@std/assert";
import { VideoContext } from "./context.ts";
import { VideoDecodeNode } from "./decode_node.ts";
import { FakeHTMLCanvasElement } from "./fake_htmlcanvaselement_test.ts";
import { FakeVideoNode } from "./fake_video_node_test.ts";
import { FakeVideoDecoder } from "./fake_videodecoder_test.ts";
import { FakeVideoFrame } from "./fake_videoframe_test.ts";

function overrideVideoDecoder(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasVideoDecoder = Object.prototype.hasOwnProperty.call(g, "VideoDecoder");
	const originalVideoDecoder = g.VideoDecoder;
	g.VideoDecoder = value;
	return () => {
		if (hasVideoDecoder) {
			g.VideoDecoder = originalVideoDecoder;
		} else {
			delete g.VideoDecoder;
		}
	};
}

Deno.test("VideoDecodeNode", async (t) => {
	let context: VideoContext;
	let decoderNode: VideoDecodeNode;
	let mockDecoder: FakeVideoDecoder;
	let onFrame: (frame: VideoFrame) => void;
	let restoreVideoDecoder: () => void;

	await t.step("setup", () => {
		// Mock the global VideoDecoder, capturing the config so we can trigger callbacks
		mockDecoder = new FakeVideoDecoder({ output: () => {}, error: () => {} });
		let capturedOutput: ((frame: VideoFrame) => void) | undefined;
		restoreVideoDecoder = overrideVideoDecoder(function (config: VideoDecoderInit) {
			capturedOutput = config.output;
			return mockDecoder;
		});

		const mockCanvas = new FakeHTMLCanvasElement();
		context = new VideoContext({ canvas: mockCanvas });
		// onFrame triggers the VideoDecodeNode's decoder output callback
		onFrame = (frame: VideoFrame) => capturedOutput?.(frame);
		decoderNode = new VideoDecodeNode(context);
	});

	await t.step("teardown", () => {
		// Restore global VideoDecoder
		restoreVideoDecoder();
	});

	await t.step("should create VideoDecodeNode", () => {
		assert(decoderNode instanceof VideoDecodeNode);
		assertEquals(decoderNode.numberOfInputs, 1);
		assertEquals(decoderNode.numberOfOutputs, 1);
	});

	await t.step("should configure decoder", () => {
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};

		decoderNode.configure(config);

		assert(mockDecoder.configureCalled);
		assertEquals(mockDecoder.configureCalls.length, 1);
		const configureCall = mockDecoder.configureCalls[0];
		assert(configureCall);
		assertEquals(configureCall[0], config);
	});

	await t.step("should decode encoded container", () => {
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		decoderNode.configure(config);

		// VideoDecodeNode decodes in decodeFrom method, not in process
		// process method passes decoded frames to next nodes
		const frame = new FakeVideoFrame();
		const outputNode = new FakeVideoNode();
		decoderNode.connect(outputNode);
		let processCalled = false;
		let processFrame: VideoFrame | undefined;
		outputNode.process = (f: VideoFrame) => {
			processCalled = true;
			processFrame = f;
		};

		decoderNode.process(frame);

		assert(processCalled);
		assertEquals(processFrame, frame);
	});

	await t.step("should handle frame close errors gracefully", () => {
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		decoderNode.configure(config);

		// Mock VideoFrame.close to throw an error
		const frame = new FakeVideoFrame();
		let closeCalled = false;
		frame.close = () => {
			closeCalled = true;
			throw new Error("Close error");
		};

		// Trigger the decoder output callback which calls process() then frame.close()
		// Should not throw despite the error (close errors are caught internally)
		onFrame(frame);
		assert(closeCalled);
	});

	await t.step(
		"should pass decoded frames to outputs when decoder outputs frame",
		() => {
			const config: VideoDecoderConfig = {
				codec: "vp8",
				codedWidth: 640,
				codedHeight: 480,
			};
			decoderNode.configure(config);

			// Connect an output node
			const outputNode = new FakeVideoNode();
			decoderNode.connect(outputNode);
			let processCalled = false;
			let processFrame: VideoFrame | undefined;
			outputNode.process = (f: VideoFrame) => {
				processCalled = true;
				processFrame = f;
			};

			// Simulate decoder output
			const mockFrame = new FakeVideoFrame();
			if (onFrame) onFrame(mockFrame);

			assert(processCalled);
			assertEquals(processFrame, mockFrame);
		},
	);

	await t.step(
		"should handle output processing errors gracefully in process",
		() => {
			const config: VideoDecoderConfig = {
				codec: "vp8",
				codedWidth: 640,
				codedHeight: 480,
			};
			decoderNode.configure(config);

			// Connect an output node that throws an error
			const outputNode = new FakeVideoNode();
			decoderNode.connect(outputNode);
			let processCalled = false;
			let processFrame: VideoFrame | undefined;
			outputNode.process = (f: VideoFrame) => {
				processCalled = true;
				processFrame = f;
				throw new Error("Output processing error");
			};

			const frame = new FakeVideoFrame();
			// Should not throw despite the error
			decoderNode.process(frame);
			assert(processCalled);
			assertEquals(processFrame, frame);
		},
	);

	await t.step("should close decoder", async () => {
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		decoderNode.configure(config);

		await decoderNode.dispose();
		assert(mockDecoder.closeCalled);
	});

	await t.step("should handle close errors gracefully", async () => {
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		decoderNode.configure(config);

		// Mock decoder.close to throw an error
		const originalClose = mockDecoder.close;
		mockDecoder.close = () => {
			throw new Error("Close error");
		};

		// dispose() catches errors internally, so just verify it completes
		await decoderNode.dispose();

		// Restore original
		mockDecoder.close = originalClose;
	});

	await t.step("should flush decoder", async () => {
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		decoderNode.configure(config);

		await decoderNode.flush();
		assert(mockDecoder.flushCalled);
	});

	await t.step("should handle flush errors gracefully", async () => {
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		decoderNode.configure(config);

		// Mock decoder.flush to throw an error
		const originalFlush = mockDecoder.flush;
		mockDecoder.flush = () => {
			throw new Error("Flush error");
		};

		// Should not throw despite the error (flush errors are caught internally)
		await decoderNode.flush();
		assert(mockDecoder.flushCalled);

		// Restore original
		mockDecoder.flush = originalFlush;
	});

	await t.step("should dispose decoder node", () => {
		decoderNode.dispose();
		// dispose should disconnect and unregister from context
		assertEquals(decoderNode.outputs.size, 0);
		assertEquals(decoderNode.inputs.size, 0);
	});

	await t.step("should decode from track reader", async () => {
		// Create a fresh decoder node (previous node was disposed)
		const freshMockDecoder = new FakeVideoDecoder(
			{ output: () => {}, error: () => {} },
		);
		const restoreFreshVideoDecoder = overrideVideoDecoder(
			function (_config: VideoDecoderInit) {
				return freshMockDecoder;
			},
		);
		const freshNode = new VideoDecodeNode(context);
		restoreFreshVideoDecoder();

		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		freshNode.configure(config);

		// Mock TrackReader - simplified for Deno test
		const mockReader = new ReadableStream({
			start(controller) {
				controller.enqueue({
						timestamp: 0,
					} as EncodedVideoChunk);
				controller.close();
			},
		});

		await freshNode.decodeFrom(mockReader).done;

		assert(freshMockDecoder.decodeCalled);
	});

	await t.step(
		"should recover from backpressure when dequeue fires",
		async () => {
			// Decoder that fills the queue, then drains via dequeue event
			class SlowDrainVideoDecoder extends EventTarget {
				state: CodecState = "configured";
				decodeQueueSize = 0;
				decodeCalls: EncodedVideoChunk[][] = [];

				constructor() {
					super();
				}

				configure(): void {
					this.state = "configured";
				}

				decode(chunk: EncodedVideoChunk): void {
					this.decodeCalls.push([chunk]);
					this.decodeQueueSize++;
					// Drain after a microtask (simulates real decoder)
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

			const slowDecoder = new SlowDrainVideoDecoder();
			const restoreSlowDecoder = overrideVideoDecoder(
				function (_config: VideoDecoderInit) {
					return slowDecoder;
				},
			);

			const slowNode = new VideoDecodeNode(context);
			restoreSlowDecoder();

			slowNode.configure({
				codec: "vp8",
				codedWidth: 640,
				codedHeight: 480,
			});

			// Prefill queue above MAX_QUEUE_SIZE (3)
			slowDecoder.decodeQueueSize = 4;

			const stream = new ReadableStream<EncodedVideoChunk>({
				start(controller) {
					controller.enqueue({ timestamp: 0 } as EncodedVideoChunk);
					controller.close();
				},
			});

			// Fire dequeue after a microtask to simulate drain
			queueMicrotask(() => {
				slowDecoder.decodeQueueSize = 0;
				slowDecoder.dispatchEvent(new Event("dequeue"));
			});

			await slowNode.decodeFrom(stream).done;

			// Chunk should have been decoded after queue drained
			assertEquals(slowDecoder.decodeCalls.length, 1);
		},
	);

	await t.step(
		"should drop stalled chunks after dequeue timeout",
		async () => {
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = (callback: TimerHandler, ...args: unknown[]) =>
				originalSetTimeout(callback, 1, ...args);

			class StalledVideoDecoder extends EventTarget {
				state: CodecState = "configured";
				decodeQueueSize = 0;
				decodeCalls: EncodedVideoChunk[][] = [];

				constructor() {
					super();
				}

				configure(): void {
					this.state = "configured";
				}

				decode(chunk: EncodedVideoChunk): void {
					this.decodeCalls.push([chunk]);
					this.decodeQueueSize++;
				}

				flush(): Promise<void> {
					return Promise.resolve();
				}

				close(): void {
					this.state = "closed";
				}
			}

			const restoreStalledVideoDecoder = overrideVideoDecoder(
				function (_config: VideoDecoderInit) {
					return new StalledVideoDecoder();
				},
			);

			const stalledNode = new VideoDecodeNode(context);
			restoreStalledVideoDecoder();

			const config: VideoDecoderConfig = {
				codec: "vp8",
				codedWidth: 640,
				codedHeight: 480,
			};
			stalledNode.configure(config);

			const stream = new ReadableStream<EncodedVideoChunk>({
				start(controller) {
					for (let i = 0; i < 5; i++) {
						controller.enqueue({
							timestamp: i * 1000,
						} as EncodedVideoChunk);
					}
					controller.close();
				},
			});

			try {
				await stalledNode.decodeFrom(stream).done;

				assertEquals(stalledNode.decodeQueueSize, 4);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}
		},
	);
});

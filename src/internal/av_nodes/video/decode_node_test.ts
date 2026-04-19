import { assert, assertEquals } from "@std/assert";
import { stubGlobal } from "../test-utils.ts";
import { VideoContext } from "./context.ts";
import { VideoDecodeNode } from "./decode_node.ts";
import { FakeHTMLCanvasElement } from "./fake_htmlcanvaselement_test.ts";
import { FakeVideoNode } from "./fake_video_node_test.ts";
import { FakeVideoDecoder } from "./fake_videodecoder_test.ts";
import { FakeVideoFrame } from "./fake_videoframe_test.ts";

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
		restoreVideoDecoder = stubGlobal("VideoDecoder", function (config: VideoDecoderInit) {
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
		const restoreFreshVideoDecoder = stubGlobal("VideoDecoder", function (_config: VideoDecoderInit) {
			return freshMockDecoder;
		});
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
					bytes: new Uint8Array([0, 0, 0, 0, 1, 2, 3]),
				});
				controller.close();
			},
		});

		await freshNode.decodeFrom(mockReader).done;

		assert(freshMockDecoder.decodeCalled);
	});
});

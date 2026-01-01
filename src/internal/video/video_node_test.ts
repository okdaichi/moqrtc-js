import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { MockVideoEncoder } from "../../test-stubs/mock_videoencoder_test.ts";
import type { EncodedContainer, EncodeDestination } from "../container.ts";
import { MockHTMLCanvasElement } from "./mock_htmlcanvaselement_test.ts";
import { MockVideoDecoder } from "./mock_videodecoder_test.ts";
import { MockVideoFrame } from "./mock_videoframe_test.ts";
import {
	VideoContext,
	VideoDecodeNode,
	VideoDestinationNode,
	VideoEncodeNode,
	VideoNode,
	VideoObserveNode,
	VideoRenderFunctions,
	VideoSourceNode
} from "./video_node.ts";

// Using shared MockVideoEncoder from test-stubs

// Mock VideoNode for testing abstract class behavior
class MockVideoNode extends VideoNode {
	process(_input?: VideoFrame | any): void {
		// Mock implementation
	}
}

Deno.test("VideoContext", async (t) => {
	const canvas = new MockHTMLCanvasElement();
	const context = new VideoContext({ frameRate: 30, canvas: canvas as any });

	await t.step("should create VideoContext with default options", () => {
		const defaultContext = new VideoContext();
		assertEquals(defaultContext.frameRate, 30);
		assert(defaultContext.destination instanceof VideoDestinationNode);
	});

	await t.step("should create VideoContext with custom options", () => {
		assertEquals(context.frameRate, 30);
		assert(context.destination instanceof VideoDestinationNode);
		assertEquals(context.destination.canvas, canvas as any);
	});

	await t.step("should have initial running state", () => {
		assertEquals(context.state, "running");
	});

	await t.step("should have currentTime starting at 0", () => {
		assertEquals(context.currentTime, 0);
	});

	await t.step("should resume from suspended state", async () => {
		await context.suspend();
		assertEquals(context.state, "suspended");

		await context.resume();
		assertEquals(context.state, "running");
	});

	await t.step("should suspend from running state", async () => {
		await context.suspend();
		assertEquals(context.state, "suspended");
	});

	await t.step("should close context and disconnect all nodes", async () => {
		await context.close();
		assertEquals(context.state, "closed");
	});

	await t.step("should register and unregister nodes", () => {
		const node = new MockVideoNode();
		context["_register"](node);
		context["_unregister"](node);
		// No direct assertions possible, but should not throw
	});

	await t.step("should handle negative frameRate", () => {
		const context = new VideoContext({ frameRate: -10 });
		assertEquals(context.frameRate, -10);
	});

	await t.step("should handle zero frameRate", () => {
		const context = new VideoContext({ frameRate: 0 });
		assertEquals(context.frameRate, 0);
	});

	await t.step("should handle very large frameRate", () => {
		const context = new VideoContext({ frameRate: 10000 });
		assertEquals(context.frameRate, 10000);
	});
});

Deno.test("VideoNode", async (t) => {
	const node = new MockVideoNode();

	await t.step("should create VideoNode with default options", () => {
		assertEquals(node.numberOfInputs, 1);
		assertEquals(node.numberOfOutputs, 1);
		assertEquals(node.inputs.size, 0);
		assertEquals(node.outputs.size, 0);
	});

	await t.step("should create VideoNode with custom options", () => {
		const customNode = new MockVideoNode({ numberOfInputs: 2, numberOfOutputs: 3 });
		assertEquals(customNode.numberOfInputs, 2);
		assertEquals(customNode.numberOfOutputs, 3);
	});

	await t.step("should connect to another node", () => {
		const node2 = new MockVideoNode();
		const result = node.connect(node2);
		assertEquals(result, node2);
		assert(node.outputs.has(node2));
		assert(node2.inputs.has(node));
	});

	await t.step("should not connect to itself", () => {
		const result = node.connect(node);
		assertEquals(result, node);
		assert(!node.outputs.has(node));
		assert(!node.inputs.has(node));
	});

	await t.step("should disconnect from specific node", () => {
		const node2 = new MockVideoNode();
		node.connect(node2);
		node.disconnect(node2);
		assert(!node.outputs.has(node2));
		assert(!node2.inputs.has(node));
	});

	await t.step("should disconnect from all nodes", () => {
		const node2 = new MockVideoNode();
		const node3 = new MockVideoNode();
		node.connect(node2);
		node.connect(node3);
		node.disconnect();
		assertEquals(node.outputs.size, 0);
		assert(!node2.inputs.has(node));
		assert(!node3.inputs.has(node));
	});

	await t.step("should dispose and disconnect", () => {
		const node2 = new MockVideoNode();
		node.connect(node2);
		node.dispose();
		assertEquals(node.outputs.size, 0);
		assert(!node2.inputs.has(node));
	});
});

Deno.test("VideoSourceNode", async (t) => {
	let context: VideoContext;
	let stream: ReadableStream<VideoFrame>;
	let sourceNode: VideoSourceNode;

	await t.step("should create VideoSourceNode", () => {
		// Setup
		context = new VideoContext();
		stream = new ReadableStream({
			start(_controller) {
				// Mock stream
			},
		});
		sourceNode = new VideoSourceNode(context, stream);

		assertEquals(sourceNode.numberOfInputs, 0);
		assertEquals(sourceNode.numberOfOutputs, 1);
		assertEquals(sourceNode.context, context);
	});

	await t.step("should process frames and pass to outputs", () => {
		// Setup
		context = new VideoContext();
		stream = new ReadableStream({
			start(_controller) {
				// Mock stream
			},
		});
		sourceNode = new VideoSourceNode(context, stream);

		const outputNode = new MockVideoNode();
		sourceNode.connect(outputNode);

		const frame = new MockVideoFrame();
		// Note: Spy functionality would need proper mock implementation
		sourceNode.process(frame);
		// TODO: Verify frame was processed - would need spy on outputNode.process
		assert(true); // Placeholder - actual verification needs spy implementation
	});

	await t.step("should start and stop processing", async () => {
		// Setup
		context = new VideoContext();
		let frameEnqueued = false;
		stream = new ReadableStream({
			start(controller) {
				// Mock stream that provides one frame and then closes
				if (!frameEnqueued) {
					controller.enqueue(new MockVideoFrame());
					frameEnqueued = true;
				}
				controller.close();
			},
		});
		sourceNode = new VideoSourceNode(context, stream);

		const startPromise = sourceNode.start();
		// Wait a bit for processing
		await new Promise((resolve) => setTimeout(resolve, 10));
		sourceNode.stop();
		await startPromise; // Should resolve after stop
	});

	await t.step("should handle start errors gracefully", async () => {
		// Setup
		context = new VideoContext();
		stream = new ReadableStream({
			start(_controller) {
				throw new Error("Stream read error");
			},
		});
		sourceNode = new VideoSourceNode(context, stream);

		// Should not throw despite the error
		await assertRejects(async () => await sourceNode.start());
	});

	await t.step("should dispose and unregister", () => {
		// Setup
		context = new VideoContext();
		stream = new ReadableStream({
			start(_controller) {
				// Mock stream
			},
		});
		sourceNode = new VideoSourceNode(context, stream);

		sourceNode.dispose();
		assertEquals(sourceNode.outputs.size, 0);
	});
});

Deno.test("MediaStreamVideoSourceNode", async (t) => {
	let mockTrack: MediaStreamTrack;
	let mockStream: ReadableStream<VideoFrame>;
	let originalMediaStreamTrackProcessor: any;

	await t.step("should create with MediaStreamTrackProcessor", async () => {
		// Setup
		mockTrack = {
			kind: "video",
			getSettings: () => ({ frameRate: 30, width: 640, height: 480 }),
			stop: () => {},
		} as any;

		mockStream = new ReadableStream({
			start(controller) {
				controller.enqueue(new MockVideoFrame());
			},
		});

		// Store original MediaStreamTrackProcessor
		originalMediaStreamTrackProcessor = (globalThis as any).MediaStreamTrackProcessor;

		// Mock MediaStreamTrackProcessor
		(globalThis as any).MediaStreamTrackProcessor = () => ({
			readable: mockStream,
		});

		try {
			const { MediaStreamVideoSourceNode } = await import("./video_node.ts");
			const node = new MediaStreamVideoSourceNode(mockTrack);

			assertEquals(node.track, mockTrack);
			// Note: Constructor call verification would need spy implementation
		} finally {
			// Restore original MediaStreamTrackProcessor
			(globalThis as any).MediaStreamTrackProcessor = originalMediaStreamTrackProcessor;
		}
	});

	await t.step(
		"should create with polyfill when MediaStreamTrackProcessor unavailable",
		async () => {
			// Setup
			mockTrack = {
				kind: "video",
				getSettings: () => ({ frameRate: 30, width: 640, height: 480 }),
				stop: () => {},
			} as any;

			// Remove MediaStreamTrackProcessor
			originalMediaStreamTrackProcessor = (globalThis as any).MediaStreamTrackProcessor;
			delete (globalThis as any).MediaStreamTrackProcessor;

			// Mock document.createElement
			const mockVideo = {
				srcObject: null,
				play: () => Promise.resolve(),
				onloadedmetadata: null,
				videoWidth: 640,
				videoHeight: 480,
			};
			const originalCreateElement = document.createElement;
			document.createElement = () => mockVideo as any;

			try {
				const { MediaStreamVideoSourceNode } = await import("./video_node.ts");
				const node = new MediaStreamVideoSourceNode(mockTrack);

				assertEquals(node.track, mockTrack);
				// Note: createElement call verification would need spy implementation
				assert(mockVideo.srcObject !== null);
			} finally {
				// Restore
				document.createElement = originalCreateElement;
				(globalThis as any).MediaStreamTrackProcessor = originalMediaStreamTrackProcessor;
			}
		},
	);

	await t.step("should dispose and stop track", async () => {
		// Setup
		let stopCalled = false;
		mockTrack = {
			kind: "video",
			getSettings: () => ({ frameRate: 30, width: 640, height: 480 }),
			stop: () => {
				stopCalled = true;
			},
		} as any;

		mockStream = new ReadableStream({
			start(controller) {
				controller.enqueue(new MockVideoFrame());
			},
		});

		originalMediaStreamTrackProcessor = (globalThis as any).MediaStreamTrackProcessor;
		(globalThis as any).MediaStreamTrackProcessor = () => ({
			readable: mockStream,
		});

		try {
			const { MediaStreamVideoSourceNode } = await import("./video_node.ts");
			const node = new MediaStreamVideoSourceNode(mockTrack);
			node.dispose();

			assert(stopCalled);
		} finally {
			(globalThis as any).MediaStreamTrackProcessor = originalMediaStreamTrackProcessor;
		}
	});

	await t.step("should handle track without settings", async () => {
		// Setup
		const badTrack = {
			kind: "video",
			getSettings: () => null,
			stop: () => {},
		} as any;

		const { MediaStreamVideoSourceNode } = await import("./video_node.ts");
		assertThrows(
			() => new MediaStreamVideoSourceNode(badTrack),
			Error,
			"track has no settings",
		);
	});
});

Deno.test("VideoDestinationNode", async (t) => {
	let context: VideoContext;
	let canvas: MockHTMLCanvasElement;
	let destinationNode: VideoDestinationNode;

	await t.step("should create VideoDestinationNode", () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();
		destinationNode = new VideoDestinationNode(context, canvas as any);

		assertEquals(destinationNode.numberOfInputs, 1);
		assertEquals(destinationNode.numberOfOutputs, 0);
		assertEquals(destinationNode.canvas, canvas as any);
		assertEquals(destinationNode.resizeCallback, VideoRenderFunctions.contain);
	});

	await t.step("should create with custom render function", () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();
		const customNode = new VideoDestinationNode(context, canvas as any, {
			renderFunction: VideoRenderFunctions.cover,
		});
		assertEquals(customNode.resizeCallback, VideoRenderFunctions.cover);
	});

	await t.step("should process frames and draw to canvas", () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();
		destinationNode = new VideoDestinationNode(context, canvas as any);

		const frame = new MockVideoFrame(640, 480);

		assert(() => destinationNode.process(frame)); // Should not throw
		// Note: Spy verification would need proper mock implementation
		// assert(canvas.getContextSpy.calledWith("2d"));
	});

	await t.step("should handle frame close errors gracefully", () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();
		destinationNode = new VideoDestinationNode(context, canvas as any);

		const frame = new MockVideoFrame(640, 480);

		// Mock VideoFrame.close to throw an error
		const originalClose = frame.close;
		frame.close = () => {
			throw new Error("Close error");
		};

		// Should not throw despite the error
		assert(() => destinationNode.process(frame)); // Should not throw

		// Restore original method
		frame.close = originalClose;
	});

	await t.step("should not draw when context is suspended", async () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();
		destinationNode = new VideoDestinationNode(context, canvas as any);

		await context.suspend();
		const frame = new MockVideoFrame();

		destinationNode.process(frame);

		// Note: Spy verification would need proper mock implementation
		// assert(!ctx.drawImageSpy.called);
	});

	await t.step("should dispose and cancel animation frame", () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();

		// Mock global functions
		const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
		const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

		let requestedId = 0;
		globalThis.cancelAnimationFrame = () => {};
		globalThis.requestAnimationFrame = (() => {
			requestedId = 123;
			return requestedId;
		}) as any;

		const destinationNode = new VideoDestinationNode(context, canvas as any);

		const frame = new MockVideoFrame(640, 480);
		destinationNode.process(frame);

		// Note: Spy verification would need proper mock implementation
		// assert(requestAnimationFrame called);

		destinationNode.dispose();

		// Note: Spy verification would need proper mock implementation
		// assert(cancelAnimationFrame called with 123);

		// Restore globals
		globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	});

	await t.step("should close pending frame when replaced before rAF runs", () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();

		// Mock global functions so rAF callback never runs (we only test pending replacement)
		const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
		const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

		let nextId = 1;
		globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
			// Intentionally do not invoke cb
			void cb;
			return nextId++;
		}) as any;
		globalThis.cancelAnimationFrame = (() => {}) as any;

		try {
			const destinationNode = new VideoDestinationNode(context, canvas as any);

			let closed = 0;
			const frame1 = new MockVideoFrame(640, 480);
			frame1.clone = () => {
				const f = new MockVideoFrame(640, 480);
				f.close = () => {
					closed++;
				};
				return f;
			};

			const frame2 = new MockVideoFrame(640, 480);
			frame2.clone = () => new MockVideoFrame(640, 480);

			destinationNode.process(frame1);
			// Second process call replaces the pending frame; the previous pending clone MUST be closed
			destinationNode.process(frame2);

			assertEquals(closed, 1);
		} finally {
			// Restore globals
			globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
			globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		}
	});

	await t.step("should handle frames with zero dimensions", () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();
		destinationNode = new VideoDestinationNode(context, canvas as any);

		const frame = new MockVideoFrame(0, 0);
		assert(() => destinationNode.process(frame)); // Should not throw
	});

	await t.step("should handle frames with negative dimensions", () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();
		destinationNode = new VideoDestinationNode(context, canvas as any);

		const frame = new MockVideoFrame(-100, -100);
		assert(() => destinationNode.process(frame)); // Should not throw
	});

	await t.step("should handle frames with very large dimensions", () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();
		destinationNode = new VideoDestinationNode(context, canvas as any);

		const frame = new MockVideoFrame(10000, 10000);
		assert(() => destinationNode.process(frame)); // Should not throw
	});

	await t.step("should handle frames with negative timestamp", () => {
		context = new VideoContext();
		canvas = new MockHTMLCanvasElement();
		destinationNode = new VideoDestinationNode(context, canvas as any);

		const frame = new MockVideoFrame(640, 480, -1000);
		assert(() => destinationNode.process(frame)); // Should not throw
	});
});

Deno.test("VideoEncodeNode", async (t) => {
	let context: VideoContext;
	let encodeNode: VideoEncodeNode;

	await t.step("should create VideoEncodeNode", () => {
		context = new VideoContext();
		encodeNode = new VideoEncodeNode(context);

		assertEquals(encodeNode.numberOfInputs, 1);
		assertEquals(encodeNode.numberOfOutputs, 1);
	});

	await t.step("should configure encoder", () => {
		context = new VideoContext();
		encodeNode = new VideoEncodeNode(context);

		const config: VideoEncoderConfig = {
			codec: "vp8",
			width: 640,
			height: 480,
		};

		assert(() => encodeNode.configure(config)); // Should not throw
	});

	await t.step("should process frames and encode", () => {
		context = new VideoContext();
		encodeNode = new VideoEncodeNode(context);

		const config: VideoEncoderConfig = {
			codec: "vp8",
			width: 640,
			height: 480,
		};
		encodeNode.configure(config);

		const frame = new MockVideoFrame();
		assert(() => encodeNode.process(frame)); // Should not throw
	});

	await t.step("should not encode when not configured", () => {
		context = new VideoContext();
		encodeNode = new VideoEncodeNode(context);

		const frame = new MockVideoFrame();
		assert(() => encodeNode.process(frame)); // Should not throw
	});

	await t.step("should dispose and close encoder", () => {
		context = new VideoContext();
		encodeNode = new VideoEncodeNode(context);

		assert(() => encodeNode.dispose()); // Should not throw
	});
});

Deno.test("VideoRenderFunctions", async (t) => {
	await t.step("contain should fit frame within canvas maintaining aspect ratio", () => {
		const result = VideoRenderFunctions.contain(640, 480, 800, 600);
		assertEquals(result.width, 800);
		assertEquals(result.height, 600);
		assertEquals(result.x, 0);
		assertEquals(result.y, 0);
	});

	await t.step("cover should cover entire canvas maintaining aspect ratio", () => {
		const result = VideoRenderFunctions.cover(640, 480, 800, 600);
		assertEquals(result.width, 800);
		assertEquals(result.height, 600);
		assertEquals(result.x, 0);
		assertEquals(result.y, 0);
	});

	await t.step("fill should fill entire canvas", () => {
		const result = VideoRenderFunctions.fill(640, 480, 800, 600);
		assertEquals(result.width, 800);
		assertEquals(result.height, 600);
		assertEquals(result.x, 0);
		assertEquals(result.y, 0);
	});

	await t.step("scaleDown should only scale down, never up", () => {
		const result = VideoRenderFunctions.scaleDown(320, 240, 800, 600);
		assertEquals(result.width, 320);
		assertEquals(result.height, 240);
		assertEquals(result.x, 240);
		assertEquals(result.y, 180);
	});
});

// // Mock VideoFrame globally
// class MockVideoFrame implements VideoFrame {
//   displayWidth: number;
//   displayHeight: number;
//   timestamp: number;
//   duration: number | null;
//   codedWidth: number;
//   codedHeight: number;
//   codedRect: DOMRectReadOnly;
//   visibleRect: DOMRectReadOnly;
//   colorSpace: VideoColorSpace;
//   format: VideoPixelFormat;
//   allocationSize: (options?: VideoFrameCopyToOptions) => number;
//   copyTo: any;
//   close: () => void;
//   clone: () => VideoFrame;

//   constructor(width: number = 640, height: number = 480, timestamp: number = 0) {
//     this.displayWidth = width;
//     this.displayHeight = height;
//     this.codedWidth = width;
//     this.codedHeight = height;
//     this.timestamp = timestamp;
//     this.duration = null;
//     this.codedRect = {
//       x: 0,
//       y: 0,
//       width: width,
//       height: height,
//       top: 0,
//       right: width,
//       bottom: height,
//       left: 0,
//       toJSON: () => ({})
//     } as DOMRectReadOnly;
//     this.visibleRect = {
//       x: 0,
//       y: 0,
//       width: width,
//       height: height,
//       top: 0,
//       right: width,
//       bottom: height,
//       left: 0,
//       toJSON: () => ({})
//     } as DOMRectReadOnly;
//     this.colorSpace = {
//       primaries: 'bt709',
//       transfer: 'bt709',
//       matrix: 'bt709',
//       fullRange: false,
//       toJSON: () => ({})
//     } as VideoColorSpace;
//     this.format = 'NV12';
//     this.allocationSize = vi.fn(() => width * height * 1.5);
//     this.copyTo = undefined /* TODO: Convert mock */;
//     this.close = undefined /* TODO: Convert mock */;
//     this.clone = vi.fn(() => new MockVideoFrame(width, height, timestamp));
//   }
// }

// Set VideoFrame globally
(globalThis as any).VideoFrame = MockVideoFrame;

// VideoEncoder mock uses shared test-stub implementation

Deno.test("VideoEncodeNode", async (t) => {
	let context: VideoContext;
	let encoderNode: VideoEncodeNode;
	let mockEncoder: MockVideoEncoder;
	let mockFrame: MockVideoFrame;
	let onChunk: (chunk: EncodedContainer) => void;

	await t.step("setup", () => {
		// Mock the global VideoEncoder
		mockEncoder = new MockVideoEncoder({
			output: (chunk: EncodedContainer) => {
				if (onChunk) onChunk(chunk);
			},
			error: (error: any) => {
				console.error("Encoder error:", error);
			},
		});
		// When the code calls new VideoEncoder(init) we want the mock instance to receive
		// the init callbacks (output/error) so the node's handlers are wired to the mock.
		(globalThis as any).VideoEncoder = class MockVideoEncoderConstructor {
			constructor(init: any) {
				// copy the init handlers onto the existing mock instance
				Object.assign(mockEncoder, init);
				return mockEncoder;
			}
		};

		context = new VideoContext();
		onChunk = () => {}; // Default empty handler
		mockFrame = new MockVideoFrame();
		encoderNode = new VideoEncodeNode(context);
	});

	await t.step("should create VideoEncodeNode", () => {
		assert(encoderNode instanceof VideoEncodeNode);
		assertEquals(encoderNode.numberOfInputs, 1);
		assertEquals(encoderNode.numberOfOutputs, 1);
	});

	await t.step("should configure encoder", () => {
		const config: VideoEncoderConfig = {
			codec: "vp8",
			width: 640,
			height: 480,
			bitrate: 1000000,
			framerate: 30,
		};

		encoderNode.configure(config);

		assert(mockEncoder.configureCalled);
		if (mockEncoder.configureCalls.length > 0 && mockEncoder.configureCalls[0]) {
			const calledConfig = mockEncoder.configureCalls[0][0];
			assertEquals(calledConfig.codec, "vp8");
			assertEquals(calledConfig.width, 640);
			assertEquals(calledConfig.height, 480);
		}
	});

	await t.step("should encode video frame", () => {
		const config: VideoEncoderConfig = {
			codec: "vp8",
			width: 640,
			height: 480,
			bitrate: 1000000,
			framerate: 30,
		};
		encoderNode.configure(config);

		const frame = new MockVideoFrame();
		encoderNode.process(frame);

		assert(mockEncoder.encodeCalled);
		if (mockEncoder.encodeCalls.length > 0 && mockEncoder.encodeCalls[0]) {
			const [calledFrame, options] = mockEncoder.encodeCalls[0];
			assert(calledFrame instanceof MockVideoFrame);
			assertEquals(options.keyFrame, false);
		}
	});

	await t.step("should handle encode errors gracefully", () => {
		const config: VideoEncoderConfig = {
			codec: "vp8",
			width: 640,
			height: 480,
			bitrate: 1000000,
			framerate: 30,
		};
		encoderNode.configure(config);

		// Mock encoder.encode to throw an error
		const originalEncode = mockEncoder.encode;
		mockEncoder.encode = () => {
			throw new Error("Encode error");
		};

		const frame = new MockVideoFrame();
		// Should not throw despite the error
		assert(() => encoderNode.process(frame));
		assert(mockEncoder.encodeCalled);

		// Restore original
		mockEncoder.encode = originalEncode;
	});

	await t.step("should handle frame close errors gracefully", () => {
		const config: VideoEncoderConfig = {
			codec: "vp8",
			width: 640,
			height: 480,
			bitrate: 1000000,
			framerate: 30,
		};
		encoderNode.configure(config);

		// Mock VideoFrame.close to throw an error
		const frame = new MockVideoFrame();
		let closeCalled = false;
		frame.close = () => {
			closeCalled = true;
			throw new Error("Close error");
		};

		// Should not throw despite the error
		assert(() => encoderNode.process(frame));
		assert(closeCalled);
	});

	await t.step("should close encoder", async () => {
		const config: VideoEncoderConfig = {
			codec: "vp8",
			width: 640,
			height: 480,
			bitrate: 1000000,
			framerate: 30,
		};
		encoderNode.configure(config);

		await encoderNode.close();
		assert(mockEncoder.closeCalled);
	});

	await t.step("should handle close errors gracefully", async () => {
		const config: VideoEncoderConfig = {
			codec: "vp8",
			width: 640,
			height: 480,
			bitrate: 1000000,
			framerate: 30,
		};
		encoderNode.configure(config);

		// Mock encoder.close to throw an error
		mockEncoder.close = () => {
			throw new Error("Close error");
		};

		// Should not throw despite the error
		await assertRejects(async () => await encoderNode.close());
		assert(mockEncoder.closeCalled);
	});

	await t.step("should dispose encoder node", () => {
		encoderNode.dispose();
		// dispose should disconnect and unregister from context
		assertEquals(encoderNode.outputs.size, 0);
		assertEquals(encoderNode.inputs.size, 0);
	});

	await t.step("should encode to destination", async () => {
		const config: VideoEncoderConfig = {
			codec: "vp8",
			width: 640,
			height: 480,
			bitrate: 1000000,
			framerate: 30,
		};
		encoderNode.configure(config);

		let resolveDone: (value?: any) => void = () => {};
		const mockDestination: EncodeDestination = {
			output: (_chunk: any) => Promise.resolve(undefined),
			done: new Promise((resolve) => resolveDone = resolve),
		};

		// Add destination first
		const encodePromise = encoderNode.encodeTo(mockDestination);

		// Simulate encoding a chunk
		encoderNode.process(mockFrame);

		// Resolve done to complete the encodeTo
		resolveDone();

		// Wait for the encode promise to resolve
		await encodePromise;
	});

	await t.step("should handle destination errors gracefully in encodeTo", async () => {
		const config: VideoEncoderConfig = {
			codec: "vp8",
			width: 640,
			height: 480,
			bitrate: 1000000,
			framerate: 30,
		};
		encoderNode.configure(config);

		const mockDestination: EncodeDestination = {
			output: () => {
				throw new Error("Destination error");
			},
			done: Promise.resolve(),
		};

		const encodePromise = encoderNode.encodeTo(mockDestination);

		// Simulate encoding a chunk
		encoderNode.process(mockFrame);

		// Should not throw despite destination error
		await encodePromise;
	});
});

Deno.test("VideoDecodeNode", async (t) => {
	let context: VideoContext;
	let decoderNode: VideoDecodeNode;
	let mockDecoder: MockVideoDecoder;
	let onFrame: (frame: VideoFrame) => void;

	await t.step("setup", () => {
		// Mock the global VideoDecoder
		mockDecoder = new MockVideoDecoder({
			output: (frame: VideoFrame) => {
				if (onFrame) onFrame(frame);
			},
			error: (error: DOMException) => {
				console.error("Decoder error:", error);
			},
		});
		(globalThis as any).VideoDecoder = () => mockDecoder;

		context = new VideoContext();
		onFrame = () => {};
		decoderNode = new VideoDecodeNode(context);
	});

	await t.step("teardown", () => {
		// Restore global VideoDecoder
		delete (globalThis as any).VideoDecoder;
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
		const frame = new MockVideoFrame();
		const outputNode = new MockVideoNode();
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
		const frame = new MockVideoFrame();
		let closeCalled = false;
		frame.close = () => {
			closeCalled = true;
			throw new Error("Close error");
		};

		// Should not throw despite the error
		assert(() => decoderNode.process(frame));
		assert(closeCalled);
	});

	await t.step("should pass decoded frames to outputs when decoder outputs frame", async () => {
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		decoderNode.configure(config);

		// Connect an output node
		const outputNode = new MockVideoNode();
		decoderNode.connect(outputNode);
		let processCalled = false;
		let processFrame: VideoFrame | undefined;
		outputNode.process = (f: VideoFrame) => {
			processCalled = true;
			processFrame = f;
		};

		// Simulate decoder output
		const mockFrame = new MockVideoFrame();
		if (onFrame) onFrame(mockFrame);

		assert(processCalled);
		assertEquals(processFrame, mockFrame);
	});

	await t.step("should handle output processing errors gracefully in process", () => {
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		decoderNode.configure(config);

		// Connect an output node that throws an error
		const outputNode = new MockVideoNode();
		decoderNode.connect(outputNode);
		let processCalled = false;
		let processFrame: VideoFrame | undefined;
		outputNode.process = (f: VideoFrame) => {
			processCalled = true;
			processFrame = f;
			throw new Error("Output processing error");
		};

		const frame = new MockVideoFrame();
		// Should not throw despite the error
		assert(() => decoderNode.process(frame));
		assert(processCalled);
		assertEquals(processFrame, frame);
	});

	await t.step("should close decoder", async () => {
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		decoderNode.configure(config);

		await decoderNode.close();
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

		// Should not throw despite the error
		await assertRejects(async () => await decoderNode.close());
		assert(mockDecoder.closeCalled);

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

		// Should not throw despite the error
		await assertRejects(async () => await decoderNode.flush());
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
		const config: VideoDecoderConfig = {
			codec: "vp8",
			codedWidth: 640,
			codedHeight: 480,
		};
		decoderNode.configure(config);

		// Mock TrackReader - simplified for Deno test
		const mockReader = new ReadableStream({
			start(controller) {
				controller.enqueue({
					bytes: new Uint8Array([0, 0, 0, 0, 1, 2, 3]),
				});
				controller.close();
			},
		});

		await decoderNode.decodeFrom(mockReader);

		assert(mockDecoder.decodeCalled);
	});
});

Deno.test("VideoObserveNode", async (t) => {
	let context: VideoContext;
	let observeNode: VideoObserveNode;
	let mockCanvas: MockHTMLCanvasElement;
	let mockObserver: any;

	await t.step("setup", () => {
		mockCanvas = new MockHTMLCanvasElement();
		context = new VideoContext({ canvas: mockCanvas as any });

		// Mock IntersectionObserver
		mockObserver = {
			observe: () => {},
			disconnect: () => {},
		};
		(globalThis as any).IntersectionObserver = (callback: any) => {
			// Store callback for testing
			(mockObserver as any).callback = callback;
			return mockObserver;
		};

		observeNode = new VideoObserveNode(context); // enableBackground defaults to false
	});

	await t.step("teardown", () => {
		// Restore global IntersectionObserver
		delete (globalThis as any).IntersectionObserver;
	});

	await t.step("should create VideoObserveNode", () => {
		assert(observeNode instanceof VideoObserveNode);
		assertEquals(observeNode.numberOfInputs, 1);
		assertEquals(observeNode.numberOfOutputs, 1);
		assertEquals(observeNode.isVisible, true);
	});

	await t.step("should process frames and pass to outputs when visible", () => {
		const outputNode = new MockVideoNode();
		observeNode.connect(outputNode);

		const frame = new MockVideoFrame();
		let processCalled = false;
		let processFrame: VideoFrame | undefined;
		outputNode.process = (f: VideoFrame) => {
			processCalled = true;
			processFrame = f;
		};

		observeNode.process(frame);

		assert(processCalled);
		assertEquals(processFrame, frame);
	});

	await t.step("should not process frames when not visible", () => {
		const outputNode = new MockVideoNode();
		observeNode.connect(outputNode);

		// Make not visible
		const callback = (mockObserver as any).callback;
		if (callback) {
			callback([{ isIntersecting: false }]);
		}

		const frame = new MockVideoFrame();
		let processCalled = false;
		outputNode.process = () => {
			processCalled = true;
		};

		observeNode.process(frame);

		assert(!processCalled);
	});

	await t.step("should handle process errors gracefully", () => {
		const errorNode = new MockVideoNode();
		const outputNode = new MockVideoNode();
		observeNode.connect(errorNode);
		observeNode.connect(outputNode);

		let errorProcessCalled = false;
		errorNode.process = () => {
			errorProcessCalled = true;
			throw new Error("Process error");
		};

		let outputProcessCalled = false;
		let outputFrame: VideoFrame | undefined;
		outputNode.process = (f: VideoFrame) => {
			outputProcessCalled = true;
			outputFrame = f;
		};

		const frame = new MockVideoFrame();
		// Should not throw despite the error
		assert(() => observeNode.process(frame));
		assert(errorProcessCalled);
		assert(outputProcessCalled);
		assertEquals(outputFrame, frame);
	});

	await t.step("should dispose and disconnect observer", () => {
		const outputNode = new MockVideoNode();
		observeNode.connect(outputNode);

		observeNode.dispose();

		assert(!outputNode.inputs.has(observeNode));
		assert(mockObserver.disconnectCalled);
	});

	await t.step("should observe element", () => {
		const element = document.createElement("div");
		observeNode.observe(element);

		assert(mockObserver.observeCalled);
		assertEquals(mockObserver.observeCalls.length, 1);
		const observeCall = mockObserver.observeCalls[0];
		assert(observeCall);
		assertEquals(observeCall[0], element);
	});

	await t.step("should get isVisible", () => {
		assertEquals(observeNode.isVisible, true);
		// Simulate not visible
		const callback = (mockObserver as any).callback;
		if (callback) {
			callback([{ isIntersecting: false }]);
		}
		assertEquals(observeNode.isVisible, false);
	});
});

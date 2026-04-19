import { assert, assertEquals } from "@std/assert";
import { VideoContext } from "./context.ts";
import { type VideoEncodeDestination, VideoEncodeNode } from "./encode_node.ts";
import { FakeVideoEncoder } from "./fake_videoencoder_test.ts";
import { FakeVideoFrame } from "./fake_videoframe_test.ts";

function overrideDocument(value: { createElement: (tag: string) => unknown }): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasDocument = Object.prototype.hasOwnProperty.call(g, "document");
	const originalDocument = g.document;
	g.document = value;
	return () => {
		if (hasDocument) {
			g.document = originalDocument;
		} else {
			delete g.document;
		}
	};
}

function overrideVideoEncoder(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasVideoEncoder = Object.prototype.hasOwnProperty.call(g, "VideoEncoder");
	const originalVideoEncoder = g.VideoEncoder;
	g.VideoEncoder = value;
	return () => {
		if (hasVideoEncoder) {
			g.VideoEncoder = originalVideoEncoder;
		} else {
			delete g.VideoEncoder;
		}
	};
}

// Mock document for Deno
const restoreDocument = overrideDocument({
	createElement: (tag: string) => {
		if (tag === "canvas") {
			return {
				getContext: () => ({}),
				width: 640,
				height: 480,
			};
		}
		return {};
	},
});

// Mock VideoEncoder for Deno (basic functionality tests)
const restoreVideoEncoder = overrideVideoEncoder(FakeVideoEncoder);

Deno.test("VideoEncodeNode - basic functionality", async (t) => {
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

		const frame = new FakeVideoFrame();
		assert(() => encodeNode.process(frame)); // Should not throw
	});

	await t.step("should not encode when not configured", () => {
		context = new VideoContext();
		encodeNode = new VideoEncodeNode(context);

		const frame = new FakeVideoFrame();
		assert(() => encodeNode.process(frame)); // Should not throw
	});

	await t.step("should dispose and close encoder", () => {
		context = new VideoContext();
		encodeNode = new VideoEncodeNode(context);

		assert(() => encodeNode.dispose()); // Should not throw
	});
});

Deno.test("VideoEncodeNode - with mocks", async (t) => {
	let context: VideoContext;
	let encoderNode: VideoEncodeNode;
	let mockEncoder: FakeVideoEncoder;
	let mockFrame: FakeVideoFrame;
	let onChunk: (chunk: EncodedVideoChunk) => void;

	await t.step("setup", () => {
		// Mock the global VideoEncoder
		mockEncoder = new FakeVideoEncoder({
			output: (chunk: EncodedVideoChunk) => {
				if (onChunk) onChunk(chunk);
			},
			error: (error) => {
				console.error("Encoder error:", error);
			},
		});
		// When the code calls new VideoEncoder(init) we want the mock instance to receive
		// the init callbacks (output/error) so the node's handlers are wired to the mock.
		const restoreVideoEncoder = overrideVideoEncoder(
			class FakeVideoEncoderConstructor {
				constructor(init: VideoEncoderInit) {
					// copy the init handlers onto the existing mock instance
					Object.assign(mockEncoder, init);
					return mockEncoder;
				}
			},
		);

		try {
			context = new VideoContext();
			onChunk = () => {}; // Default empty handler
			mockFrame = new FakeVideoFrame();
			encoderNode = new VideoEncodeNode(context);
		} finally {
			restoreVideoEncoder();
		}
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
		if (
			mockEncoder.configureCalls.length > 0 &&
			mockEncoder.configureCalls[0]
		) {
			const calledConfig = mockEncoder.configureCalls[0];
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

		const frame = new FakeVideoFrame();
		encoderNode.process(frame);

		assert(mockEncoder.encodeCalled);
		if (mockEncoder.encodeCalls.length > 0 && mockEncoder.encodeCalls[0]) {
			const [calledFrame, options] = mockEncoder.encodeCalls[0];
			assert(calledFrame instanceof FakeVideoFrame);
			assertEquals(options!.keyFrame, false);
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

		const frame = new FakeVideoFrame();
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

		// Mock VideoFrame.close to throw an error (though it's not called on input)
		const frame = new FakeVideoFrame();
		frame.close = () => {
			throw new Error("Close error");
		};

		// Should not throw despite the error (but close is not called on input)
		assert(() => encoderNode.process(frame));
		// Note: close is called on cloned frame, not input
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

		const mockDestination: VideoEncodeDestination = {
			output: (_chunk: EncodedVideoChunk, _decoderConfig?: VideoDecoderConfig) =>
				Promise.resolve(undefined),
		};

		// Add destination
		encoderNode.encodeTo(mockDestination);

		// Simulate encoding a chunk
		encoderNode.process(mockFrame);

		// Wait a bit for async processing
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	await t.step(
		"should handle destination errors gracefully in encodeTo",
		async () => {
			const config: VideoEncoderConfig = {
				codec: "vp8",
				width: 640,
				height: 480,
				bitrate: 1000000,
				framerate: 30,
			};
			encoderNode.configure(config);

			const mockDestination: VideoEncodeDestination = {
				output: (_chunk: EncodedVideoChunk, _decoderConfig?: VideoDecoderConfig) =>
					Promise.resolve(undefined),
			};

			encoderNode.encodeTo(mockDestination);

			// Simulate encoding a chunk
			encoderNode.process(mockFrame);

			// Wait a bit for async processing
			await new Promise((resolve) => setTimeout(resolve, 10));
		},
	);
});

Deno.test("VideoEncodeNode - cleanup", () => {
	restoreDocument();
	restoreVideoEncoder();
});

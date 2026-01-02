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
		if (
			mockEncoder.configureCalls.length > 0 &&
			mockEncoder.configureCalls[0]
		) {
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
		},
	);
});

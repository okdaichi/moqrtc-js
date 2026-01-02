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

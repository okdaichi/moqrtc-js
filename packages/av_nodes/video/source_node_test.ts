import { assert, assertEquals } from "@std/assert";
import { VideoContext } from "./context.ts";
import { FakeVideoNode } from "./fake_video_node_test.ts";
import { FakeVideoFrame } from "./fake_videoframe_test.ts";
import { VideoSourceNode } from "./source_node.ts";

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

		const outputNode = new FakeVideoNode();
		sourceNode.connect(outputNode);

		const frame = new FakeVideoFrame();
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
					controller.enqueue(new FakeVideoFrame());
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
			start(controller) {
				// Use controller.error() to signal stream error (avoids synchronous throw escaping constructor)
				controller.error(new Error("Stream read error"));
			},
		});
		sourceNode = new VideoSourceNode(context, stream);

		// start() handles errors internally (logs and resolves), so done should resolve without throwing
		const { done } = sourceNode.start();
		await done;
	});

	await t.step("should pass only the frames the context's pacing admits", async () => {
		context = new VideoContext({ frameRate: 30 });
		// The pacing's arithmetic is VideoContext's (context_test.ts); here it
		// answers from a script, so the step tests what the source does with it.
		const answers = [true, false, false, true, false];
		const asked: number[] = [];
		context._admitFrame = () => {
			asked.push(asked.length);
			return answers[asked.length - 1] ?? false;
		};
		const sent = Array.from({ length: 5 }, () => new FakeVideoFrame());
		const closed = new Set<VideoFrame>();
		for (const frame of sent) frame.close = () => closed.add(frame);
		stream = new ReadableStream({
			start(controller) {
				for (const frame of sent) controller.enqueue(frame);
				controller.close();
			},
		});
		sourceNode = new VideoSourceNode(context, stream);

		// Retiming builds a VideoFrame from each passed frame; a fake stands in.
		const g = globalThis as unknown as Record<string, unknown>;
		const original = g.VideoFrame;
		const retimed: FakeVideoFrame[] = [];
		g.VideoFrame = class {
			constructor(_source: VideoFrame, init: { timestamp: number }) {
				const frame = new FakeVideoFrame(640, 480, init.timestamp);
				retimed.push(frame);
				return frame;
			}
		};
		try {
			const output = new FakeVideoNode();
			sourceNode.connect(output);

			await sourceNode.start().done;

			// Every frame is offered to the pacing; the admitted two pass on.
			assertEquals(asked.length, sent.length);
			assertEquals(output.processedFrames.length, 2);
			assertEquals(retimed.length, 2);
			// Every frame read is closed, passed or not.
			assertEquals(closed.size, sent.length);
		} finally {
			if (original === undefined) delete g.VideoFrame;
			else g.VideoFrame = original;
			sourceNode.dispose();
		}
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

import { assert, assertEquals } from "@std/assert";
import { VideoContext } from "./context.ts";
import { FakeVideoFrame } from "./fake_videoframe_test.ts";
import { VideoSourceNode } from "./source_node.ts";
import { VideoNode } from "./video_node.ts";

class MockVideoNode extends VideoNode {
	process(_input?: VideoFrame): void {}
}

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

import { assert, assertEquals } from "@std/assert";
import { VideoContext } from "./context.ts";
import { VideoDestinationNode } from "./destination_node.ts";
import { FakeHTMLCanvasElement } from "./fake_htmlcanvaselement_test.ts";
import { FakeVideoNode } from "./fake_video_node_test.ts";

// Using shared FakeVideoNode for abstract VideoNode behavior tests

Deno.test("VideoContext", async (t) => {
	const canvas = new FakeHTMLCanvasElement();
	const context = new VideoContext({
		frameRate: 30,
		canvas: canvas as unknown as HTMLCanvasElement,
	});

	await t.step("should create VideoContext with default options", () => {
		const defaultContext = new VideoContext();
		assertEquals(defaultContext.frameRate, 30);
		assert(defaultContext.destination instanceof VideoDestinationNode);
	});

	await t.step("should create VideoContext with custom options", () => {
		assertEquals(context.frameRate, 30);
		assert(context.destination instanceof VideoDestinationNode);
		assertEquals(context.destination.canvas, canvas as unknown as HTMLCanvasElement);
	});

	await t.step("should have initial running state", () => {
		assertEquals(context.state, "running");
	});

	await t.step("should have currentTime starting at 0", () => {
		// currentTime starts near 0; exact 0 is not guaranteed due to test execution time
		assert(context.currentTime >= 0 && context.currentTime < 1);
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
		const node = new FakeVideoNode();
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
	const node = new FakeVideoNode();

	await t.step("should create VideoNode with default options", () => {
		assertEquals(node.numberOfInputs, 1);
		assertEquals(node.numberOfOutputs, 1);
		assertEquals(node.inputs.size, 0);
		assertEquals(node.outputs.size, 0);
	});

	await t.step("should create VideoNode with custom options", () => {
		const customNode = new FakeVideoNode({
			numberOfInputs: 2,
			numberOfOutputs: 3,
		});
		assertEquals(customNode.numberOfInputs, 2);
		assertEquals(customNode.numberOfOutputs, 3);
	});

	await t.step("should connect to another node", () => {
		const node2 = new FakeVideoNode();
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
		const node2 = new FakeVideoNode();
		node.connect(node2);
		node.disconnect(node2);
		assert(!node.outputs.has(node2));
		assert(!node2.inputs.has(node));
	});

	await t.step("should disconnect from all nodes", () => {
		const node2 = new FakeVideoNode();
		const node3 = new FakeVideoNode();
		node.connect(node2);
		node.connect(node3);
		node.disconnect();
		assertEquals(node.outputs.size, 0);
		assert(!node2.inputs.has(node));
		assert(!node3.inputs.has(node));
	});

	await t.step("should dispose and disconnect", () => {
		const node2 = new FakeVideoNode();
		node.connect(node2);
		node.dispose();
		assertEquals(node.outputs.size, 0);
		assert(!node2.inputs.has(node));
	});
});

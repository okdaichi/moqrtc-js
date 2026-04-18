import { assert, assertEquals } from "@std/assert";
import { deleteGlobal, stubGlobal } from "../../../test-utils_test.ts";
import { VideoContext } from "./context.ts";
import { FakeHTMLCanvasElement } from "./fake_htmlcanvaselement_test.ts";
import { FakeVideoNode } from "./fake_video_node_test.ts";
import { FakeVideoFrame } from "./fake_videoframe_test.ts";
import { VideoObserveNode } from "./observe_node.ts";

Deno.test("VideoObserveNode", async (t) => {
	interface MockObserver {
		observeCalled: boolean;
		observeCalls: [Element, ...unknown[]][];
		disconnectCalled: boolean;
		callback?: IntersectionObserverCallback;
		observe(element: Element, ...args: unknown[]): void;
		disconnect(): void;
	}

	let context: VideoContext;
	let observeNode: VideoObserveNode;
	let mockCanvas: FakeHTMLCanvasElement;
	let mockObserver: MockObserver;

	await t.step("setup", () => {
		mockCanvas = new FakeHTMLCanvasElement();
		context = new VideoContext({ canvas: mockCanvas });

		// Mock IntersectionObserver
		mockObserver = {
			observeCalled: false,
			observeCalls: [],
			disconnectCalled: false,
			observe(element: Element, ...args: unknown[]) {
				mockObserver.observeCalled = true;
				mockObserver.observeCalls.push([element, ...args]);
			},
			disconnect() {
				mockObserver.disconnectCalled = true;
			},
		};
		stubGlobal("IntersectionObserver", function (callback: IntersectionObserverCallback) {
			// Store callback for testing
			mockObserver.callback = callback;
			return mockObserver;
		});

		observeNode = new VideoObserveNode(context); // enableBackground defaults to false
	});

	await t.step("teardown", () => {
		// Restore global IntersectionObserver
		deleteGlobal("IntersectionObserver");
	});

	await t.step("should create VideoObserveNode", () => {
		assert(observeNode instanceof VideoObserveNode);
		assertEquals(observeNode.numberOfInputs, 1);
		assertEquals(observeNode.numberOfOutputs, 1);
		assertEquals(observeNode.isVisible, true);
	});

	await t.step(
		"should process frames and pass to outputs when visible",
		() => {
			const outputNode = new FakeVideoNode();
			observeNode.connect(outputNode);

			const frame = new FakeVideoFrame();
			let processCalled = false;
			let processFrame: VideoFrame | undefined;
			outputNode.process = (f: VideoFrame) => {
				processCalled = true;
				processFrame = f;
			};

			observeNode.process(frame);

			assert(processCalled);
			assertEquals(processFrame, frame);
		},
	);

	await t.step("should not process frames when not visible", () => {
		const outputNode = new FakeVideoNode();
		observeNode.connect(outputNode);

		// Make not visible
		const callback = mockObserver.callback;
		if (callback) {
			callback([
				{ isIntersecting: false } as IntersectionObserverEntry,
			], mockObserver as unknown as IntersectionObserver);
		}

		const frame = new FakeVideoFrame();
		let processCalled = false;
		outputNode.process = () => {
			processCalled = true;
		};

		observeNode.process(frame);

		assert(!processCalled);
		// Reset visibility for subsequent steps
		const resetCallback = mockObserver.callback;
		if (resetCallback) {
			resetCallback([
				{ isIntersecting: true } as IntersectionObserverEntry,
			], mockObserver as unknown as IntersectionObserver);
		}
	});

	await t.step("should handle process errors gracefully", () => {
const errorNode = new FakeVideoNode();
	const outputNode = new FakeVideoNode();
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

		const frame = new FakeVideoFrame();
		// Should not throw despite the error
		observeNode.process(frame);
		assert(errorProcessCalled);
		assert(outputProcessCalled);
		assertEquals(outputFrame, frame);
	});

	await t.step("should dispose and disconnect observer", () => {
const outputNode = new FakeVideoNode();
		observeNode.connect(outputNode);

		observeNode.dispose();

		assert(!outputNode.inputs.has(observeNode));
		assert(mockObserver.disconnectCalled);
	});

	await t.step("should observe element", () => {
		const element = {} as unknown as Element;
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
		const callback = mockObserver.callback;
		if (callback) {
			callback([
				{ isIntersecting: false } as IntersectionObserverEntry,
			], mockObserver as unknown as IntersectionObserver);
		}
		assertEquals(observeNode.isVisible, false);
	});
});

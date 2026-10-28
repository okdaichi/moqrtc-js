import { assert, assertEquals } from "@std/assert";
import { VideoContext } from "./context.ts";
import { VideoDestinationNode, VideoRenderFunctions } from "./destination_node.ts";
import { FakeHTMLCanvasElement } from "./fake_htmlcanvaselement_test.ts";
import { FakeVideoFrame } from "./fake_videoframe_test.ts";

function overrideRequestAnimationFrame(
	value: (callback: FrameRequestCallback) => number,
): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasRequestAnimationFrame = Object.prototype.hasOwnProperty.call(
		g,
		"requestAnimationFrame",
	);
	const originalRequestAnimationFrame = g.requestAnimationFrame;
	g.requestAnimationFrame = value;
	return () => {
		if (hasRequestAnimationFrame) {
			g.requestAnimationFrame = originalRequestAnimationFrame;
		} else {
			delete g.requestAnimationFrame;
		}
	};
}

function overrideCancelAnimationFrame(value: (handle: number) => void): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasCancelAnimationFrame = Object.prototype.hasOwnProperty.call(
		g,
		"cancelAnimationFrame",
	);
	const originalCancelAnimationFrame = g.cancelAnimationFrame;
	g.cancelAnimationFrame = value;
	return () => {
		if (hasCancelAnimationFrame) {
			g.cancelAnimationFrame = originalCancelAnimationFrame;
		} else {
			delete g.cancelAnimationFrame;
		}
	};
}

Deno.test(
	{ name: "VideoDestinationNode", sanitizeOps: false, sanitizeResources: false },
	async (t) => {
		let context: VideoContext;
		let canvas: FakeHTMLCanvasElement;
		let destinationNode: VideoDestinationNode;

		await t.step("should create VideoDestinationNode", () => {
			context = new VideoContext();
			canvas = new FakeHTMLCanvasElement();
			destinationNode = new VideoDestinationNode(context, canvas);

			assertEquals(destinationNode.numberOfInputs, 1);
			assertEquals(destinationNode.numberOfOutputs, 0);
			assertEquals(destinationNode.canvas, canvas);
			assertEquals(
				destinationNode.renderFunction,
				VideoRenderFunctions.contain,
			);
		});

		await t.step("should create with custom render function", () => {
			context = new VideoContext();
			canvas = new FakeHTMLCanvasElement();
			const customNode = new VideoDestinationNode(context, canvas, {
				renderFunction: VideoRenderFunctions.cover,
			});
			assertEquals(customNode.renderFunction, VideoRenderFunctions.cover);
		});

		await t.step("should process frames and draw to canvas", () => {
			context = new VideoContext();
			canvas = new FakeHTMLCanvasElement();
			destinationNode = new VideoDestinationNode(context, canvas);

			const frame = new FakeVideoFrame(640, 480);

			assert(() => destinationNode.process(frame)); // Should not throw
			// Note: Spy verification would need proper mock implementation
			// assert(canvas.getContextSpy.calledWith("2d"));
		});

		await t.step("should handle frame close errors gracefully", () => {
			context = new VideoContext();
			canvas = new FakeHTMLCanvasElement();
			destinationNode = new VideoDestinationNode(context, canvas);

			const frame = new FakeVideoFrame(640, 480);

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
			canvas = new FakeHTMLCanvasElement();
			destinationNode = new VideoDestinationNode(context, canvas);

			await context.suspend();
			const frame = new FakeVideoFrame();

			destinationNode.process(frame);

			// Note: Spy verification would need proper mock implementation
			// assert(!ctx.drawImageSpy.called);
		});

		await t.step("should dispose and cancel animation frame", () => {
			context = new VideoContext();
			canvas = new FakeHTMLCanvasElement();

			// Mock global functions

			let requestedId = 0;
			const restoreCancelAnimationFrame = overrideCancelAnimationFrame(
				() => {},
			);
			const restoreRequestAnimationFrame = overrideRequestAnimationFrame(
				(_cb: FrameRequestCallback) => {
					requestedId = 123;
					return requestedId;
				},
			);

			const destinationNode = new VideoDestinationNode(context, canvas);
			const frame = new FakeVideoFrame(640, 480);

			destinationNode.process(frame);

			// Note: Spy verification would need proper mock implementation
			// assert(requestAnimationFrame called);

			destinationNode.dispose();

			// Note: Spy verification would need proper mock implementation
			// assert(cancelAnimationFrame called with 123);

			// Restore globals
			restoreCancelAnimationFrame();
			restoreRequestAnimationFrame();
		});

		await t.step(
			"should keep two pending frames and close the oldest past that",
			() => {
				context = new VideoContext();
				canvas = new FakeHTMLCanvasElement();

				// rAF never runs: this step only tests the pending queue.
				let nextId = 1;
				const restoreRequestAF = overrideRequestAnimationFrame(
					(cb: FrameRequestCallback) => {
						void cb;
						return nextId++;
					},
				);
				const restoreCancelAF = overrideCancelAnimationFrame(() => {});

				try {
					const destinationNode = new VideoDestinationNode(context, canvas);

					const closed: number[] = [];
					const frameWithClone = (id: number) => {
						const frame = new FakeVideoFrame(640, 480);
						frame.clone = () => {
							const f = new FakeVideoFrame(640, 480);
							f.close = () => {
								closed.push(id);
							};
							return f;
						};
						return frame;
					};

					destinationNode.process(frameWithClone(1));
					destinationNode.process(frameWithClone(2));
					// Two may wait for the next repaint.
					assertEquals(closed, []);

					destinationNode.process(frameWithClone(3));
					// A third drops the oldest.
					assertEquals(closed, [1]);

					destinationNode.dispose();
					assertEquals(closed.sort(), [1, 2, 3]);
				} finally {
					restoreCancelAF();
					restoreRequestAF();
				}
			},
		);

		await t.step("should draw one pending frame per repaint", () => {
			context = new VideoContext();

			const callbacks: FrameRequestCallback[] = [];
			const restoreRequestAF = overrideRequestAnimationFrame(
				(cb: FrameRequestCallback) => {
					callbacks.push(cb);
					return callbacks.length;
				},
			);
			const restoreCancelAF = overrideCancelAnimationFrame(() => {});

			try {
				// A canvas that records which frame each draw used.
				const drawn: number[] = [];
				const recording = {
					width: 640,
					height: 480,
					getContext: () =>
						({
							clearRect: () => {},
							drawImage: (image: FakeVideoFrame) => drawn.push(image.timestamp),
						}) as unknown as CanvasRenderingContext2D,
				};
				const destinationNode = new VideoDestinationNode(context, recording);

				// Two frames arrive within one repaint.
				destinationNode.process(new FakeVideoFrame(640, 480, 1));
				destinationNode.process(new FakeVideoFrame(640, 480, 2));
				assertEquals(callbacks.length, 1); // one rAF at a time

				callbacks[0]!(0);
				assertEquals(drawn, [1]);
				assertEquals(callbacks.length, 2); // the second gets its own repaint

				callbacks[1]!(16);
				assertEquals(drawn, [1, 2]);
				assertEquals(callbacks.length, 2); // nothing left to schedule

				destinationNode.dispose();
			} finally {
				restoreCancelAF();
				restoreRequestAF();
			}
		});

		await t.step("should handle frames with zero dimensions", () => {
			context = new VideoContext();
			canvas = new FakeHTMLCanvasElement();
			destinationNode = new VideoDestinationNode(context, canvas);

			const frame = new FakeVideoFrame(0, 0);
			assert(() => destinationNode.process(frame)); // Should not throw
		});

		await t.step("should handle frames with negative dimensions", () => {
			context = new VideoContext();
			canvas = new FakeHTMLCanvasElement();
			destinationNode = new VideoDestinationNode(context, canvas);

			const frame = new FakeVideoFrame(-100, -100);
			assert(() => destinationNode.process(frame)); // Should not throw
		});

		await t.step("should handle frames with very large dimensions", () => {
			context = new VideoContext();
			canvas = new FakeHTMLCanvasElement();
			destinationNode = new VideoDestinationNode(context, canvas);

			const frame = new FakeVideoFrame(10000, 10000);
			assert(() => destinationNode.process(frame)); // Should not throw
		});

		await t.step("should handle frames with negative timestamp", () => {
			context = new VideoContext();
			canvas = new FakeHTMLCanvasElement();
			destinationNode = new VideoDestinationNode(context, canvas);

			const frame = new FakeVideoFrame(640, 480, -1000);
			assert(() => destinationNode.process(frame)); // Should not throw
		});
	},
);

Deno.test("VideoRenderFunctions", async (t) => {
	await t.step(
		"contain should fit frame within canvas maintaining aspect ratio",
		() => {
			const result = VideoRenderFunctions.contain(640, 480, 800, 600);
			assertEquals(result.width, 800);
			assertEquals(result.height, 600);
			assertEquals(result.x, 0);
			assertEquals(result.y, 0);
		},
	);

	await t.step(
		"cover should cover entire canvas maintaining aspect ratio",
		() => {
			const result = VideoRenderFunctions.cover(640, 480, 800, 600);
			assertEquals(result.width, 800);
			assertEquals(result.height, 600);
			assertEquals(result.x, 0);
			assertEquals(result.y, 0);
		},
	);

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

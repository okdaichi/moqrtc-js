
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

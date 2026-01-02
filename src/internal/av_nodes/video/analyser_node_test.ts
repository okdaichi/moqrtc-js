import { assert, assertEquals, assertExists } from "@std/assert";
import type { VideoFrameAnalysis } from "./analyse_node.ts";
import { VideoAnalyserNode } from "./analyse_node.ts";
import { VideoContext } from "./context.ts";
import { MockVideoFrame } from "./mock_videoframe_test.ts";
import { VideoNode } from "./video_node.ts";

// Mock globals for Deno environment
if (typeof OffscreenCanvas === "undefined") {
	(globalThis as any).OffscreenCanvas = class {
		width: number;
		height: number;
		constructor(width: number, height: number) {
			this.width = width;
			this.height = height;
		}
		getContext() {
			return {
				drawImage: () => {},
				getImageData: (x: number, y: number, w: number, h: number) => ({
					data: new Uint8ClampedArray(w * h * 4).fill(128), // Gray pixels
				}),
			};
		}
	};
}

if (typeof requestIdleCallback === "undefined") {
	(globalThis as any).requestIdleCallback = (callback: () => void) => {
		return setTimeout(callback, 1);
	};
	(globalThis as any).cancelIdleCallback = (id: number) => {
		clearTimeout(id);
	};
}

// Mock canvas for Deno environment
const canvas = {
	getContext: () => ({
		drawImage: () => {},
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
	}),
} as any;

class MockVideoNode extends VideoNode {
	processedFrames: VideoFrame[] = [];

	constructor() {
		super({ numberOfInputs: 1, numberOfOutputs: 1 });
	}

	process(input: VideoFrame): void {
		this.processedFrames.push(input);
	}
}

Deno.test("VideoAnalyserNode", async (t) => {
	let context: VideoContext;
	let analyserNode: VideoAnalyserNode;

	await t.step("should create VideoAnalyserNode", () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		assertEquals(analyserNode.numberOfInputs, 1);
		assertEquals(analyserNode.numberOfOutputs, 1);
	});

	await t.step("should have correct initial configuration", () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		// Default configuration
		assertEquals(analyserNode.analysisSize.width, 160);
		assertEquals(analyserNode.analysisSize.height, 120);
		assertEquals(analyserNode.smoothingTimeConstant, 0.8);
		assertEquals(analyserNode.historySize, 256);

		// Initial analysis should be null
		assertEquals(analyserNode.getFrameAnalysis(), null);
	});

	await t.step("should accept custom configuration", () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context, {
			analysisSize: { width: 320, height: 240 },
			smoothingTimeConstant: 0.5,
			historySize: 128,
			analysisInterval: 2,
		});

		assertEquals(analyserNode.analysisSize.width, 320);
		assertEquals(analyserNode.analysisSize.height, 240);
		assertEquals(analyserNode.smoothingTimeConstant, 0.5);
		assertEquals(analyserNode.historySize, 128);
	});

	await t.step("should update smoothingTimeConstant", () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		analyserNode.smoothingTimeConstant = 0.3;
		assertEquals(analyserNode.smoothingTimeConstant, 0.3);

		// Should clamp to 0-1 range
		analyserNode.smoothingTimeConstant = 1.5;
		assertEquals(analyserNode.smoothingTimeConstant, 1.0);

		analyserNode.smoothingTimeConstant = -0.5;
		assertEquals(analyserNode.smoothingTimeConstant, 0.0);
	});

	await t.step("should process frames and generate analysis", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		const frame = new MockVideoFrame(320, 240);
		analyserNode.process(frame);

		// Wait for deferred analysis (using small delay)
		await new Promise((resolve) => setTimeout(resolve, 150));

		const analysis = analyserNode.getFrameAnalysis();
		assertExists(analysis);

		// Check that all metrics exist and are in 0-1 range
		assert(analysis.lumaAverage >= 0 && analysis.lumaAverage <= 1);
		assert(analysis.lumaVariance >= 0 && analysis.lumaVariance <= 1);
		assert(analysis.chromaVariance >= 0 && analysis.chromaVariance <= 1);
		assert(analysis.frameEnergy >= 0 && analysis.frameEnergy <= 1);
		assert(analysis.frameDelta >= 0 && analysis.frameDelta <= 1);
		assert(analysis.motionEnergy >= 0 && analysis.motionEnergy <= 1);
		assert(analysis.activityLevel >= 0 && analysis.activityLevel <= 1);
		assert(analysis.edgeDensity >= 0 && analysis.edgeDensity <= 1);
		assert(
			analysis.highFrequencyRatio >= 0 &&
				analysis.highFrequencyRatio <= 1,
		);
		assert(
			analysis.spatialComplexity >= 0 && analysis.spatialComplexity <= 1,
		);

		// Check timestamp fields
		assert(analysis.timestamp > 0);
		assertEquals(analysis.frameIndex, 0);
	});

	await t.step("should trigger onanalysis callback", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		let callbackTriggered = false;
		let receivedAnalysis: VideoFrameAnalysis | null = null;

		analyserNode.onanalysis = (analysis) => {
			callbackTriggered = true;
			receivedAnalysis = analysis;
		};

		const frame = new MockVideoFrame(320, 240);
		analyserNode.process(frame);

		await new Promise((resolve) => setTimeout(resolve, 150));

		assert(callbackTriggered);
		assertExists(receivedAnalysis);
		if (receivedAnalysis) {
			assertEquals(receivedAnalysis.frameIndex, 0);
		}
	});

	await t.step("should handle callback errors gracefully", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		analyserNode.onanalysis = () => {
			throw new Error("Callback error");
		};

		const frame = new MockVideoFrame(320, 240);
		// Should not throw
		analyserNode.process(frame);

		await new Promise((resolve) => setTimeout(resolve, 150));
	});

	await t.step("should copy analysis data to array", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		const frame = new MockVideoFrame(320, 240);
		analyserNode.process(frame);

		await new Promise((resolve) => setTimeout(resolve, 150));

		const array = new Float32Array(1);
		analyserNode.getAnalysisData(array, "lumaAverage");

		assert(array[0]! >= 0 && array[0]! <= 1);
	});

	await t.step("should build history buffer", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context, {
			historySize: 10,
		});

		// Process multiple frames
		for (let i = 0; i < 5; i++) {
			const frame = new MockVideoFrame(320, 240);
			analyserNode.process(frame);
			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		const recent = analyserNode.getRecentAnalysis(5);
		assertEquals(recent.length, 5);

		// Check frame indices are sequential
		for (let i = 0; i < recent.length; i++) {
			assertEquals(recent[i]!.frameIndex, i);
		}
	});

	await t.step("should retrieve history data", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context, {
			historySize: 10,
		});

		// Process frames
		for (let i = 0; i < 3; i++) {
			const frame = new MockVideoFrame(320, 240);
			analyserNode.process(frame);
			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		const historyArray = new Float32Array(3);
		analyserNode.getAnalysisHistory(historyArray, "lumaAverage");

		// All values should be in valid range
		for (let i = 0; i < historyArray.length; i++) {
			assert(historyArray[i]! >= 0 && historyArray[i]! <= 1);
		}
	});

	await t.step("should calculate average value", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		// Process multiple frames
		for (let i = 0; i < 3; i++) {
			const frame = new MockVideoFrame(320, 240);
			analyserNode.process(frame);
			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		const avgLuma = analyserNode.getAverageValue("lumaAverage");
		assert(avgLuma >= 0 && avgLuma <= 1);
	});

	await t.step("should calculate peak value", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		// Process multiple frames
		for (let i = 0; i < 3; i++) {
			const frame = new MockVideoFrame(320, 240);
			analyserNode.process(frame);
			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		const peakMotion = analyserNode.getPeakValue("motionEnergy");
		assert(peakMotion >= 0 && peakMotion <= 1);
	});

	await t.step("should respect analysisInterval throttling", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context, {
			analysisInterval: 3, // Analyze every 3rd frame
		});

		let callbackCount = 0;
		analyserNode.onanalysis = () => {
			callbackCount++;
		};

		// Process 9 frames
		for (let i = 0; i < 9; i++) {
			const frame = new MockVideoFrame(320, 240);
			analyserNode.process(frame);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		await new Promise((resolve) => setTimeout(resolve, 200));

		// Should analyze only 3 frames (0, 3, 6)
		assertEquals(callbackCount, 3);
	});

	await t.step("should disable specific features", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context, {
			features: {
				intraFrame: true,
				interFrame: false,
				density: false,
			},
		});

		const frame = new MockVideoFrame(320, 240);
		analyserNode.process(frame);

		await new Promise((resolve) => setTimeout(resolve, 150));

		const analysis = analyserNode.getFrameAnalysis();
		assertExists(analysis);

		// Intra-frame should have values
		assert(analysis.lumaAverage >= 0);

		// Inter-frame should be zero (disabled)
		assertEquals(analysis.frameDelta, 0);
		assertEquals(analysis.motionEnergy, 0);

		// Density should be zero (disabled)
		assertEquals(analysis.edgeDensity, 0);
		assertEquals(analysis.spatialComplexity, 0);
	});

	await t.step("should pass frames to outputs", () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		const outputNode = new MockVideoNode();
		analyserNode.connect(outputNode);

		const frame = new MockVideoFrame(320, 240);
		analyserNode.process(frame);

		// Frame should be passed to output
		assertEquals(outputNode.processedFrames.length, 1);
	});

	await t.step("should handle output processing errors gracefully", () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		const errorNode = new MockVideoNode();
		errorNode.process = () => {
			throw new Error("Processing error");
		};
		analyserNode.connect(errorNode);

		const frame = new MockVideoFrame(320, 240);
		// Should not throw
		analyserNode.process(frame);
	});

	await t.step("should cleanup on dispose", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		const frame = new MockVideoFrame(320, 240);
		analyserNode.process(frame);

		analyserNode.dispose();

		// Should not process after dispose
		assertEquals(analyserNode.disposed, true);

		// Analysis should be cleared
		assertEquals(analyserNode.getFrameAnalysis(), null);
		assertEquals(analyserNode.getRecentAnalysis(10).length, 0);
	});

	await t.step("should detect motion between frames", async () => {
		context = new VideoContext({ canvas });
		analyserNode = new VideoAnalyserNode(context);

		// First frame
		const frame1 = new MockVideoFrame(320, 240);
		analyserNode.process(frame1);
		await new Promise((resolve) => setTimeout(resolve, 150));

		const analysis1 = analyserNode.getFrameAnalysis();
		assertExists(analysis1);
		// First frame will detect difference from zero-initialized buffer
		// So frameDelta/motionEnergy will be non-zero
		assert(analysis1.frameDelta >= 0 && analysis1.frameDelta <= 1);
		assert(analysis1.motionEnergy >= 0 && analysis1.motionEnergy <= 1);

		// Second frame (identical pixels, should have minimal motion)
		const frame2 = new MockVideoFrame(320, 240);
		analyserNode.process(frame2);
		await new Promise((resolve) => setTimeout(resolve, 150));

		const analysis2 = analyserNode.getFrameAnalysis();
		assertExists(analysis2);
		// Second frame should have near-zero motion (same pixels)
		assert(analysis2.frameDelta < 0.01); // Very small difference
		assert(analysis2.motionEnergy < 0.01);
	});
});

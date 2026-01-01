import type { VideoContext } from "./context.ts";
import { VideoNode } from "./video_node.ts";

/**
 * Frame analysis result
 * Equivalent to AudioAnalyserNode's getFloatTimeDomainData/getFloatFrequencyData
 */
export interface VideoFrameAnalysis {
	// Timestamps
	readonly timestamp: number; // DOMHighResTimeStamp (ms)
	readonly frameIndex: number; // Cumulative frame number
	readonly presentationTime: number; // VideoFrame.timestamp (μs)

	// Intra-Frame Statistics
	readonly lumaAverage: number; // 0.0–1.0
	readonly lumaVariance: number; // 0.0–1.0
	readonly chromaVariance: number; // 0.0–1.0
	readonly frameEnergy: number; // 0.0–1.0

	// Inter-Frame Dynamics
	readonly frameDelta: number; // 0.0–1.0
	readonly motionEnergy: number; // 0.0–1.0
	readonly activityLevel: number; // 0.0–1.0 (smoothed)

	// Information Density
	readonly edgeDensity: number; // 0.0–1.0
	readonly highFrequencyRatio: number; // 0.0–1.0
	readonly spatialComplexity: number; // 0.0–1.0
}

/**
 * Initialization options
 */
export interface VideoAnalyserNodeInit {
	/**
	 * Analysis downsampling size (default: 160x120)
	 * Smaller = faster, larger = more accurate
	 */
	analysisSize?: { width: number; height: number };

	/**
	 * Smoothing coefficient (default: 0.8)
	 * Equivalent to AudioAnalyserNode.smoothingTimeConstant
	 * 0.0 = no smoothing, 1.0 = maximum smoothing
	 */
	smoothingTimeConstant?: number;

	/**
	 * History buffer size (default: 256)
	 * Number of frames retrievable via getAnalysisHistory()
	 */
	historySize?: number;

	/**
	 * Analysis skip interval (default: 1 = analyze every frame)
	 * 2 = analyze every 2nd frame
	 */
	analysisInterval?: number;

	/**
	 * Enable analysis features (default: all enabled)
	 */
	features?: {
		intraFrame?: boolean; // lumaAverage, lumaVariance, chromaVariance, frameEnergy
		interFrame?: boolean; // frameDelta, motionEnergy, activityLevel
		density?: boolean; // edgeDensity, highFrequencyRatio, spatialComplexity
	};
}

export class VideoAnalyserNode extends VideoNode {
	readonly context: VideoContext;

	// Configuration
	#analysisSize: { width: number; height: number };
	#smoothingTimeConstant: number;
	#historySize: number;
	#analysisInterval: number;
	#enabledFeatures: {
		intraFrame: boolean;
		interFrame: boolean;
		density: boolean;
	};

	// Current analysis state
	#currentAnalysis: VideoFrameAnalysis | null = null;
	#frameIndex = 0;

	// History buffer (ring buffer)
	#historyBuffer: VideoFrameAnalysis[] = [];
	#historyWriteIndex = 0;

	// Reusable buffers for memory efficiency
	#pixelBuffer?: Uint8Array;
	#grayscaleBuffer?: Uint8Array;
	#previousFrameBuffer?: Uint8Array;

	// Performance optimization
	#canvas?: OffscreenCanvas;
	#ctx?: OffscreenCanvasRenderingContext2D | null;
	#frameCount = 0;

	// Event callback
	onanalysis: ((analysis: VideoFrameAnalysis) => void) | null = null;

	// Pending analysis data
	#pendingPixelData: Uint8Array | null = null;
	#pendingWidth = 0;
	#pendingHeight = 0;
	#pendingTimestamp = 0;
	#pendingPresentationTime = 0;
	#idleCallbackId?: number;

	constructor(context: VideoContext, options?: VideoAnalyserNodeInit) {
		super({ numberOfInputs: 1, numberOfOutputs: 1 });
		this.context = context;
		this.context._register(this);

		this.#analysisSize = options?.analysisSize ?? { width: 160, height: 120 };
		this.#smoothingTimeConstant = options?.smoothingTimeConstant ?? 0.8;
		this.#historySize = options?.historySize ?? 256;
		this.#analysisInterval = options?.analysisInterval ?? 1;
		this.#enabledFeatures = {
			intraFrame: options?.features?.intraFrame ?? true,
			interFrame: options?.features?.interFrame ?? true,
			density: options?.features?.density ?? true,
		};

		// Pre-allocate buffers
		const bufferSize = this.#analysisSize.width * this.#analysisSize.height;
		this.#pixelBuffer = new Uint8Array(bufferSize * 4);
		this.#grayscaleBuffer = new Uint8Array(bufferSize);
		if (this.#enabledFeatures.interFrame) {
			this.#previousFrameBuffer = new Uint8Array(bufferSize * 4);
		}
	}

	// AudioAnalyserNode-compatible properties
	get smoothingTimeConstant(): number {
		return this.#smoothingTimeConstant;
	}

	set smoothingTimeConstant(value: number) {
		this.#smoothingTimeConstant = Math.max(0, Math.min(1, value));
	}

	get analysisSize(): { readonly width: number; readonly height: number } {
		return { ...this.#analysisSize };
	}

	get historySize(): number {
		return this.#historySize;
	}

	// Current value retrieval (AudioAnalyserNode.getFloatTimeDomainData equivalent)
	getFrameAnalysis(): VideoFrameAnalysis | null {
		return this.#currentAnalysis;
	}

	getAnalysisData(array: Float32Array, metric: keyof VideoFrameAnalysis): void {
		if (!this.#currentAnalysis) return;
		const value = this.#currentAnalysis[metric];
		if (typeof value === "number" && array.length > 0) {
			array[0] = value;
		}
	}

	// History retrieval (AudioAnalyserNode.getFloatFrequencyData equivalent)
	getAnalysisHistory(array: Float32Array, metric: keyof VideoFrameAnalysis): void {
		const length = Math.min(array.length, this.#historyBuffer.length);
		for (let i = 0; i < length; i++) {
			const idx = (this.#historyWriteIndex - length + i + this.#historySize) %
				this.#historySize;
			const analysis = this.#historyBuffer[idx];
			if (analysis) {
				const value = analysis[metric];
				array[i] = typeof value === "number" ? value : 0;
			}
		}
	}

	getRecentAnalysis(count: number): ReadonlyArray<VideoFrameAnalysis> {
		const result: VideoFrameAnalysis[] = [];
		const length = Math.min(count, this.#historyBuffer.length);
		for (let i = 0; i < length; i++) {
			const idx = (this.#historyWriteIndex - length + i + this.#historySize) %
				this.#historySize;
			const analysis = this.#historyBuffer[idx];
			if (analysis) {
				result.push(analysis);
			}
		}
		return result;
	}

	// Aggregate value retrieval
	getAverageValue(metric: keyof VideoFrameAnalysis): number {
		if (this.#historyBuffer.length === 0) return 0;
		let sum = 0;
		for (const analysis of this.#historyBuffer) {
			const value = analysis[metric];
			if (typeof value === "number") {
				sum += value;
			}
		}
		return sum / this.#historyBuffer.length;
	}

	getPeakValue(metric: keyof VideoFrameAnalysis): number {
		if (this.#historyBuffer.length === 0) return 0;
		let max = 0;
		for (const analysis of this.#historyBuffer) {
			const value = analysis[metric];
			if (typeof value === "number" && value > max) {
				max = value;
			}
		}
		return max;
	}

	process(input: VideoFrame): void {
		if (this.disposed) {
			return;
		}

		const clonedFrame = input.clone();

		// Throttle analysis: only analyze every Nth frame
		this.#frameCount++;
		if (this.#frameCount % this.#analysisInterval === 0) {
			// Extract pixel data synchronously (fast), defer heavy analysis to idle time
			this.#scheduleAnalysis(clonedFrame);
		}

		// Pass frame to outputs
		for (const output of Array.from(this.outputs)) {
			try {
				void output.process(clonedFrame);
			} catch (e) {
				console.error("[VideoAnalyserNode] process error:", e);
			}
		}

		// Close the cloned frame (we own it)
		clonedFrame.close();
	}

	#scheduleAnalysis(frame: VideoFrame): void {
		// Extract pixel data synchronously (this is fast)
		const _width = frame.displayWidth;
		const _height = frame.displayHeight;
		const sampleWidth = this.#analysisSize.width;
		const sampleHeight = this.#analysisSize.height;

		if (!this.#pixelBuffer) return;

		try {
			// Reuse OffscreenCanvas for performance
			if (
				!this.#canvas || this.#canvas.width !== sampleWidth ||
				this.#canvas.height !== sampleHeight
			) {
				this.#canvas = new OffscreenCanvas(sampleWidth, sampleHeight);
				this.#ctx = this.#canvas.getContext("2d", { willReadFrequently: true });
			}
			if (!this.#ctx) return;

			// Draw frame to canvas (fast)
			this.#ctx.drawImage(frame, 0, 0, sampleWidth, sampleHeight);

			// Get image data (this is the main sync cost, but unavoidable)
			const imageData = this.#ctx.getImageData(0, 0, sampleWidth, sampleHeight);
			this.#pixelBuffer.set(imageData.data);
		} catch (_e) {
			return; // Skip analysis on error
		}

		// Store for deferred processing
		this.#pendingPixelData = this.#pixelBuffer;
		this.#pendingWidth = sampleWidth;
		this.#pendingHeight = sampleHeight;
		this.#pendingTimestamp = performance.now();
		this.#pendingPresentationTime = frame.timestamp ?? 0;

		// Cancel any pending analysis and schedule new one
		if (this.#idleCallbackId !== undefined) {
			cancelIdleCallback(this.#idleCallbackId);
		}

		// Schedule heavy analysis for idle time
		this.#idleCallbackId = requestIdleCallback(
			() => this.#runDeferredAnalysis(),
			{ timeout: 100 }, // Max 100ms delay
		);
	}

	#runDeferredAnalysis(): void {
		this.#idleCallbackId = undefined;
		if (!this.#pendingPixelData || !this.#grayscaleBuffer) return;

		const pixelData = this.#pendingPixelData;
		const width = this.#pendingWidth;
		const height = this.#pendingHeight;
		const timestamp = this.#pendingTimestamp;
		const presentationTime = this.#pendingPresentationTime;
		this.#pendingPixelData = null;

		// Convert to grayscale once (reuse for multiple calculations)
		this.#convertToGrayscale(pixelData, this.#grayscaleBuffer, width, height);

		// Calculate all metrics
		const intraFrame = this.#enabledFeatures.intraFrame
			? this.#calculateIntraFrame(pixelData, this.#grayscaleBuffer, width, height)
			: { lumaAverage: 0, lumaVariance: 0, chromaVariance: 0, frameEnergy: 0 };

		const interFrame = this.#enabledFeatures.interFrame
			? this.#calculateInterFrame(
				pixelData,
				this.#previousFrameBuffer,
				width,
				height,
			)
			: { frameDelta: 0, motionEnergy: 0, activityLevel: 0 };

		const density = this.#enabledFeatures.density
			? this.#calculateDensity(this.#grayscaleBuffer, width, height)
			: { edgeDensity: 0, highFrequencyRatio: 0, spatialComplexity: 0 };

		// Apply smoothing to activityLevel
		if (this.#currentAnalysis && this.#smoothingTimeConstant > 0) {
			const k = this.#smoothingTimeConstant;
			interFrame.activityLevel = k * this.#currentAnalysis.activityLevel +
				(1 - k) * interFrame.activityLevel;
		}

		// Create analysis result
		const analysis: VideoFrameAnalysis = {
			timestamp,
			frameIndex: this.#frameIndex++,
			presentationTime,
			...intraFrame,
			...interFrame,
			...density,
		};

		// Update current analysis
		this.#currentAnalysis = analysis;

		// Add to history buffer (ring buffer)
		this.#historyBuffer[this.#historyWriteIndex] = analysis;
		this.#historyWriteIndex = (this.#historyWriteIndex + 1) % this.#historySize;

		// Trigger callback
		if (this.onanalysis) {
			try {
				this.onanalysis(analysis);
			} catch (e) {
				console.error("[VideoAnalyserNode] onanalysis callback error:", e);
			}
		}

		// Update previous frame buffer for next motion calculation
		if (this.#previousFrameBuffer && this.#enabledFeatures.interFrame) {
			this.#previousFrameBuffer.set(pixelData);
		}
	}

	#convertToGrayscale(
		pixelData: Uint8Array,
		grayscale: Uint8Array,
		width: number,
		height: number,
	): void {
		for (let i = 0; i < width * height; i++) {
			const r = pixelData[i * 4]!;
			const g = pixelData[i * 4 + 1]!;
			const b = pixelData[i * 4 + 2]!;
			// ITU-R BT.601 luma
			grayscale[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
		}
	}

	#calculateIntraFrame(
		pixelData: Uint8Array,
		grayscale: Uint8Array,
		width: number,
		height: number,
	): {
		lumaAverage: number;
		lumaVariance: number;
		chromaVariance: number;
		frameEnergy: number;
	} {
		const pixelCount = width * height;
		let sumLuma = 0;
		let sumLumaSquared = 0;
		let sumChromaU = 0;
		let sumChromaV = 0;
		let sumChromaUSquared = 0;
		let sumChromaVSquared = 0;
		let sumEnergy = 0;

		// Single-pass calculation using Welford's online algorithm
		for (let i = 0; i < pixelCount; i++) {
			const r = pixelData[i * 4]!;
			const g = pixelData[i * 4 + 1]!;
			const b = pixelData[i * 4 + 2]!;
			const luma = grayscale[i]! / 255;

			// Luma statistics
			sumLuma += luma;
			sumLumaSquared += luma * luma;

			// Chroma (simplified YUV conversion)
			const u = (b - luma * 255) / 255;
			const v = (r - luma * 255) / 255;
			sumChromaU += u;
			sumChromaV += v;
			sumChromaUSquared += u * u;
			sumChromaVSquared += v * v;

			// Energy (normalized pixel intensity)
			sumEnergy += (r + g + b) / (3 * 255);
		}

		const lumaAverage = sumLuma / pixelCount;
		const lumaVariance = (sumLumaSquared / pixelCount) -
			(lumaAverage * lumaAverage);

		const chromaUMean = sumChromaU / pixelCount;
		const chromaVMean = sumChromaV / pixelCount;
		const chromaUVariance = (sumChromaUSquared / pixelCount) -
			(chromaUMean * chromaUMean);
		const chromaVVariance = (sumChromaVSquared / pixelCount) -
			(chromaVMean * chromaVMean);
		const chromaVariance = (chromaUVariance + chromaVVariance) / 2;

		const frameEnergy = sumEnergy / pixelCount;

		return {
			lumaAverage: Math.max(0, Math.min(1, lumaAverage)),
			lumaVariance: Math.max(0, Math.min(1, lumaVariance)),
			chromaVariance: Math.max(0, Math.min(1, chromaVariance)),
			frameEnergy: Math.max(0, Math.min(1, frameEnergy)),
		};
	}

	#calculateInterFrame(
		currentPixels: Uint8Array,
		previousPixels: Uint8Array | undefined,
		width: number,
		height: number,
	): {
		frameDelta: number;
		motionEnergy: number;
		activityLevel: number;
	} {
		if (!previousPixels) {
			return { frameDelta: 0, motionEnergy: 0, activityLevel: 0 };
		}

		const pixelCount = width * height;
		let sumAbsoluteDiff = 0;
		let sumSquaredDiff = 0;

		// Calculate frame difference (SAD and SSD)
		for (let i = 0; i < pixelCount * 4; i += 4) {
			const diffR = currentPixels[i]! - previousPixels[i]!;
			const diffG = currentPixels[i + 1]! - previousPixels[i + 1]!;
			const diffB = currentPixels[i + 2]! - previousPixels[i + 2]!;

			sumAbsoluteDiff += Math.abs(diffR) + Math.abs(diffG) + Math.abs(diffB);
			sumSquaredDiff += diffR * diffR + diffG * diffG + diffB * diffB;
		}

		// Normalize to 0-1 range
		const frameDelta = sumAbsoluteDiff / (pixelCount * 3 * 255);
		const motionEnergy = Math.sqrt(sumSquaredDiff / (pixelCount * 3)) / 255;

		// Activity level (simple threshold-based classification)
		const activityLevel = Math.min(1, motionEnergy * 5);

		return {
			frameDelta: Math.max(0, Math.min(1, frameDelta)),
			motionEnergy: Math.max(0, Math.min(1, motionEnergy)),
			activityLevel: Math.max(0, Math.min(1, activityLevel)),
		};
	}

	#calculateDensity(
		grayscale: Uint8Array,
		width: number,
		height: number,
	): {
		edgeDensity: number;
		highFrequencyRatio: number;
		spatialComplexity: number;
	} {
		// Edge density using Sobel operator
		let edgeSum = 0;
		let edgeCount = 0;

		for (let y = 1; y < height - 1; y++) {
			for (let x = 1; x < width - 1; x++) {
				const gx = -1 * grayscale[(y - 1) * width + (x - 1)]! +
					1 * grayscale[(y - 1) * width + (x + 1)]! +
					-2 * grayscale[y * width + (x - 1)]! +
					2 * grayscale[y * width + (x + 1)]! +
					-1 * grayscale[(y + 1) * width + (x - 1)]! +
					1 * grayscale[(y + 1) * width + (x + 1)]!;

				const gy = -1 * grayscale[(y - 1) * width + (x - 1)]! -
					2 * grayscale[(y - 1) * width + x]! -
					1 * grayscale[(y - 1) * width + (x + 1)]! +
					1 * grayscale[(y + 1) * width + (x - 1)]! +
					2 * grayscale[(y + 1) * width + x]! +
					1 * grayscale[(y + 1) * width + (x + 1)]!;

				const magnitude = Math.sqrt(gx * gx + gy * gy);
				edgeSum += magnitude;
				edgeCount++;
			}
		}

		const edgeDensity = edgeCount > 0 ? (edgeSum / edgeCount) / 1442 : 0;

		// High frequency ratio (estimate from edge strength)
		const highFrequencyRatio = Math.min(1, edgeDensity * 2);

		// Spatial complexity (entropy)
		const hist = new Uint32Array(256);
		for (let i = 0; i < grayscale.length; i++) {
			const idx = grayscale[i]!;
			hist[idx] = (hist[idx] ?? 0) + 1;
		}

		let entropy = 0;
		const total = grayscale.length;
		for (let i = 0; i < 256; i++) {
			if (hist[i]! > 0) {
				const p = hist[i]! / total;
				entropy -= p * Math.log2(p);
			}
		}
		const spatialComplexity = entropy / 8; // Normalize to 0-1

		return {
			edgeDensity: Math.max(0, Math.min(1, edgeDensity)),
			highFrequencyRatio: Math.max(0, Math.min(1, highFrequencyRatio)),
			spatialComplexity: Math.max(0, Math.min(1, spatialComplexity)),
		};
	}

	override dispose(): void {
		if (this.disposed) return;

		// Cancel pending analysis
		if (this.#idleCallbackId !== undefined) {
			cancelIdleCallback(this.#idleCallbackId);
			this.#idleCallbackId = undefined;
		}

		// Clear buffers
		this.#pixelBuffer = undefined;
		this.#grayscaleBuffer = undefined;
		this.#previousFrameBuffer = undefined;
		this.#historyBuffer = [];
		this.#currentAnalysis = null;
		this.onanalysis = null;

		this.context._unregister(this);
		super.dispose();
	}
}

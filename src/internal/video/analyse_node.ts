import type { VideoContext } from "./context.ts";
import { VideoNode } from "./video_node.ts";

export class VideoAnalyserNode extends VideoNode {
	readonly context: VideoContext;

	// Basic image statistics
	#brightness: number = 0;
	#contrast: number = 0;
	#saturation: number = 0;

	// Color analysis
	#colorHistogram: Uint32Array;
	#dominantColors: Array<{ r: number; g: number; b: number; count: number }> = [];

	// Spatial features
	#sharpness: number = 0;
	#edgeStrength: number = 0;
	#textureComplexity: number = 0;

	// Motion features (requires frame comparison)
	#motionMagnitude: number = 0;
	#motionDirection: number = 0;
	#previousFrameData: Uint8Array | null = null;

	// Frequency domain features
	#spatialFrequency: Float32Array;

	// Performance optimization
	#canvas?: OffscreenCanvas;
	#ctx?: OffscreenCanvasRenderingContext2D | null;
	#throttle: number;
	#frameCount = 0;

	constructor(context: VideoContext, options?: {
		histogramBins?: number;
		enableMotionDetection?: boolean;
		enableContentDetection?: boolean;
		throttle?: number;
	}) {
		super({ numberOfInputs: 1, numberOfOutputs: 1 });
		this.context = context;
		this.context._register(this);

		const histogramBins = options?.histogramBins ?? 256;
		this.#colorHistogram = new Uint32Array(histogramBins * 3); // RGB
		this.#spatialFrequency = new Float32Array(histogramBins);
		this.#throttle = options?.throttle ?? 1; // Analyze every Nth frame (1 = every frame)
	}

	// Basic statistics getters
	get brightness(): number {
		return this.#brightness;
	}
	get contrast(): number {
		return this.#contrast;
	}
	get saturation(): number {
		return this.#saturation;
	}

	// Color analysis getters
	getColorHistogram(array: Uint32Array): void {
		const length = Math.min(array.length, this.#colorHistogram.length);
		for (let i = 0; i < length; i++) {
			array[i] = this.#colorHistogram[i] ?? 0;
		}
	}

	getDominantColors(): ReadonlyArray<
		{ r: number; g: number; b: number; count: number }
	> {
		return [...this.#dominantColors];
	}

	// Spatial features getters
	get sharpness(): number {
		return this.#sharpness;
	}
	get edgeStrength(): number {
		return this.#edgeStrength;
	}
	get textureComplexity(): number {
		return this.#textureComplexity;
	}

	// Motion features getters
	get motionMagnitude(): number {
		return this.#motionMagnitude;
	}
	get motionDirection(): number {
		return this.#motionDirection;
	}

	// Frequency domain getters
	getSpatialFrequencyData(array: Float32Array): void {
		const length = Math.min(array.length, this.#spatialFrequency.length);
		for (let i = 0; i < length; i++) {
			array[i] = this.#spatialFrequency[i] ?? 0;
		}
	}

	process(input: VideoFrame): void {
		if (this.disposed) {
			return;
		}

        const clonedFrame = input.clone();

		// Throttle analysis: only analyze every Nth frame
		this.#frameCount++;
		if (this.#frameCount % this.#throttle === 0) {
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

	// Pending pixel data for deferred analysis
	#pendingPixelData: Uint8Array | null = null;
	#pendingWidth = 0;
	#pendingHeight = 0;
	#idleCallbackId?: number;

	#scheduleAnalysis(frame: VideoFrame): void {
		// Extract pixel data synchronously (this is fast)
		const width = frame.displayWidth;
		const height = frame.displayHeight;
		const sampleWidth = Math.min(width, 320);
		const sampleHeight = Math.min(height, 240);

		const pixelData = new Uint8Array(sampleWidth * sampleHeight * 4);
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
			pixelData.set(imageData.data);
		} catch (_e) {
			return; // Skip analysis on error
		}

		// Store for deferred processing
		this.#pendingPixelData = pixelData;
		this.#pendingWidth = sampleWidth;
		this.#pendingHeight = sampleHeight;

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
		if (!this.#pendingPixelData) return;

		const pixelData = this.#pendingPixelData;
		const sampleWidth = this.#pendingWidth;
		const sampleHeight = this.#pendingHeight;
		this.#pendingPixelData = null;

		// Run all analysis on the extracted pixel data (no longer blocks frame processing)
		this.#calculateBasicStats(pixelData, sampleWidth, sampleHeight);
		this.#calculateColorHistogram(pixelData, sampleWidth, sampleHeight);
		this.#calculateDominantColors();
		this.#calculateSpatialFeatures(pixelData, sampleWidth, sampleHeight);
		this.#calculateMotionFeatures(pixelData, sampleWidth, sampleHeight);
		this.#calculateSpatialFrequency(pixelData, sampleWidth, sampleHeight);
	}

	#calculateBasicStats(
		pixelData: Uint8Array,
		width: number,
		height: number,
	): void {
		let sumBrightness = 0;
		let sumSaturation = 0;
		const pixelCount = width * height;

		for (let i = 0; i < pixelData.length; i += 4) {
			const r = pixelData[i]!;
			const g = pixelData[i + 1]!;
			const b = pixelData[i + 2]!;

			// Brightness (luminance)
			const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
			sumBrightness += brightness;

			// Saturation
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			const saturation = max > 0 ? (max - min) / max : 0;
			sumSaturation += saturation;
		}

		this.#brightness = sumBrightness / pixelCount;

		// Contrast (standard deviation of brightness)
		let sumSquaredDiff = 0;
		for (let i = 0; i < pixelData.length; i += 4) {
			const r = pixelData[i]!;
			const g = pixelData[i + 1]!;
			const b = pixelData[i + 2]!;
			const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
			sumSquaredDiff += Math.pow(brightness - this.#brightness, 2);
		}
		this.#contrast = Math.sqrt(sumSquaredDiff / pixelCount);
		this.#saturation = sumSaturation / pixelCount;
	}

	#calculateColorHistogram(
		pixelData: Uint8Array,
		_width: number,
		_height: number,
	): void {
		// Reset histogram
		this.#colorHistogram.fill(0);

		for (let i = 0; i < pixelData.length; i += 4) {
			const r = pixelData[i]!;
			const g = pixelData[i + 1]!;
			const b = pixelData[i + 2]!;

			// Update histogram bins
			this.#colorHistogram[r] = (this.#colorHistogram[r] ?? 0) + 1;
			this.#colorHistogram[256 + g] = (this.#colorHistogram[256 + g] ?? 0) + 1;
			this.#colorHistogram[512 + b] = (this.#colorHistogram[512 + b] ?? 0) + 1;
		}
	}

	#calculateDominantColors(): void {
		// Find peaks in histogram to determine dominant colors
		const peaks = this.#findHistogramPeaks();

		this.#dominantColors = peaks.slice(0, 5).map((peak) => ({
			r: peak.r,
			g: peak.g,
			b: peak.b,
			count: peak.count,
		}));
	}

	#findHistogramPeaks(): Array<
		{ r: number; g: number; b: number; count: number }
	> {
		const peaks: Array<{ r: number; g: number; b: number; count: number }> = [];

		// Find local maxima in each color channel
		for (let r = 1; r < 255; r++) {
			const countR = this.#colorHistogram[r] ?? 0;
			if (
				countR > (this.#colorHistogram[r - 1] ?? 0) &&
				countR > (this.#colorHistogram[r + 1] ?? 0)
			) {
				for (let g = 1; g < 255; g++) {
					const countG = this.#colorHistogram[256 + g] ?? 0;
					if (
						countG > (this.#colorHistogram[256 + g - 1] ?? 0) &&
						countG > (this.#colorHistogram[256 + g + 1] ?? 0)
					) {
						for (let b = 1; b < 255; b++) {
							const countB = this.#colorHistogram[512 + b] ?? 0;
							if (
								countB >
									(this.#colorHistogram[512 + b - 1] ?? 0) &&
								countB >
									(this.#colorHistogram[512 + b + 1] ?? 0)
							) {
								peaks.push({
									r,
									g,
									b,
									count: countR + countG + countB,
								});
							}
						}
					}
				}
			}
		}

		return peaks.sort((a, b) => b.count - a.count);
	}

	#calculateSpatialFeatures(
		pixelData: Uint8Array,
		width: number,
		height: number,
	): void {
		// Convert to grayscale for spatial analysis
		const gray = new Uint8Array(width * height);
		for (let i = 0; i < pixelData.length; i += 4) {
			const r = pixelData[i]!;
			const g = pixelData[i + 1]!;
			const b = pixelData[i + 2]!;
			gray[i / 4] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
		}

		// Sharpness (variance of Laplacian)
		this.#sharpness = this.#calculateSharpness(gray, width, height);

		// Edge strength (Sobel operator)
		this.#edgeStrength = this.#calculateEdgeStrength(gray, width, height);

		// Texture complexity (entropy)
		this.#textureComplexity = this.#calculateTextureComplexity(gray);
	}

	#calculateSharpness(
		gray: Uint8Array,
		width: number,
		height: number,
	): number {
		let sum = 0;
		let count = 0;

		// Laplacian kernel
		for (let y = 1; y < height - 1; y++) {
			for (let x = 1; x < width - 1; x++) {
				const idx = y * width + x;
				const laplacian = -4 * gray[idx]! +
					gray[(y - 1) * width + x]! +
					gray[y * width + (x - 1)]! +
					gray[y * width + (x + 1)]! +
					gray[(y + 1) * width + x]!;

				sum += laplacian * laplacian;
				count++;
			}
		}

		return count > 0 ? Math.sqrt(sum / count) / 128 : 0; // Normalize to 0-1
	}

	#calculateEdgeStrength(
		gray: Uint8Array,
		width: number,
		height: number,
	): number {
		let sum = 0;
		let count = 0;

		// Sobel operator
		for (let y = 1; y < height - 1; y++) {
			for (let x = 1; x < width - 1; x++) {
				const gx = -1 * gray[(y - 1) * width + (x - 1)]! +
					1 * gray[(y - 1) * width + (x + 1)]! +
					-2 * gray[y * width + (x - 1)]! +
					2 * gray[y * width + (x + 1)]! +
					-1 * gray[(y + 1) * width + (x - 1)]! +
					1 * gray[(y + 1) * width + (x + 1)]!;

				const gy = -1 * gray[(y - 1) * width + (x - 1)]! -
					2 * gray[(y - 1) * width + x]! -
					1 * gray[(y - 1) * width + (x + 1)]! +
					1 * gray[(y + 1) * width + (x - 1)]! +
					2 * gray[(y + 1) * width + x]! +
					1 * gray[(y + 1) * width + (x + 1)]!;

				sum += Math.sqrt(gx * gx + gy * gy);
				count++;
			}
		}

		return count > 0 ? (sum / count) / 1442 : 0; // Normalize to 0-1 (max Sobel response)
	}

	#calculateTextureComplexity(gray: Uint8Array): number {
		// Simple entropy calculation
		const hist = new Uint32Array(256);
		for (let i = 0; i < gray.length; i++) {
			hist[gray[i]!] = (hist[gray[i]!] ?? 0) + 1;
		}

		let entropy = 0;
		const total = gray.length;
		for (let i = 0; i < 256; i++) {
			if (hist[i]! > 0) {
				const p = hist[i]! / total;
				entropy -= p * Math.log2(p);
			}
		}

		return entropy / 8; // Normalize to 0-1 (max entropy for 8-bit)
	}

	#calculateMotionFeatures(
		pixelData: Uint8Array,
		width: number,
		height: number,
	): void {
		if (!this.#previousFrameData) {
			this.#previousFrameData = new Uint8Array(pixelData);
			this.#motionMagnitude = 0;
			this.#motionDirection = 0;
			return;
		}

		let sumDiff = 0;
		let sumX = 0;
		let sumY = 0;
		let count = 0;

		// Calculate motion vectors using block matching
		const blockSize = 8;
		for (let by = 0; by < height - blockSize; by += blockSize) {
			for (let bx = 0; bx < width - blockSize; bx += blockSize) {
				const motion = this.#findBlockMotion(
					pixelData,
					this.#previousFrameData,
					width,
					height,
					bx,
					by,
					blockSize,
				);
				if (motion) {
					sumDiff += motion.magnitude;
					sumX += motion.dx;
					sumY += motion.dy;
					count++;
				}
			}
		}

		if (count > 0) {
			this.#motionMagnitude = (sumDiff / count) / (255 * 3); // Normalize to 0-1
			this.#motionDirection = Math.atan2(sumY / count, sumX / count);
		}

		// Update previous frame
		this.#previousFrameData.set(pixelData);
	}

	#findBlockMotion(
		curr: Uint8Array,
		prev: Uint8Array,
		width: number,
		height: number,
		bx: number,
		by: number,
		blockSize: number,
	): { magnitude: number; dx: number; dy: number } | null {
		let minSAD = Infinity;
		let bestDx = 0;
		let bestDy = 0;

		// Search in a small window around current position
		const searchRange = 4;
		for (let dy = -searchRange; dy <= searchRange; dy++) {
			for (let dx = -searchRange; dx <= searchRange; dx++) {
				if (
					bx + dx < 0 || bx + dx + blockSize >= width ||
					by + dy < 0 || by + dy + blockSize >= height
				) continue;

				let sad = 0;
				for (let y = 0; y < blockSize; y++) {
					for (let x = 0; x < blockSize; x++) {
						const currIdx = ((by + y) * width + (bx + x)) * 4;
						const prevIdx = ((by + dy + y) * width + (bx + dx + x)) * 4;

						const currR = curr[currIdx]!;
						const currG = curr[currIdx + 1]!;
						const currB = curr[currIdx + 2]!;

						const prevR = prev[prevIdx]!;
						const prevG = prev[prevIdx + 1]!;
						const prevB = prev[prevIdx + 2]!;

						sad += Math.abs(currR - prevR) +
							Math.abs(currG - prevG) +
							Math.abs(currB - prevB);
					}
				}

				if (sad < minSAD) {
					minSAD = sad;
					bestDx = dx;
					bestDy = dy;
				}
			}
		}

		return {
			magnitude: Math.sqrt(bestDx * bestDx + bestDy * bestDy),
			dx: bestDx,
			dy: bestDy,
		};
	}

	#calculateSpatialFrequency(
		pixelData: Uint8Array,
		width: number,
		height: number,
	): void {
		// Convert to grayscale
		const gray = new Uint8Array(width * height);
		for (let i = 0; i < pixelData.length; i += 4) {
			const r = pixelData[i]!;
			const g = pixelData[i + 1]!;
			const b = pixelData[i + 2]!;
			gray[i / 4] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
		}

		// Simple DFT for horizontal frequencies
		const numFreqs = Math.min(this.#spatialFrequency.length, width / 2);
		for (let freq = 0; freq < numFreqs; freq++) {
			let real = 0;
			let imag = 0;

			for (let x = 0; x < width; x++) {
				// Average across all rows for this frequency
				let rowSum = 0;
				for (let y = 0; y < height; y++) {
					rowSum += gray[y * width + x]!;
				}
				const avg = rowSum / height;

				const angle = -2 * Math.PI * freq * x / width;
				real += avg * Math.cos(angle);
				imag += avg * Math.sin(angle);
			}

			this.#spatialFrequency[freq] = Math.sqrt(real * real + imag * imag) /
				width;
		}

		// Normalize
		const maxFreq = Math.max(...this.#spatialFrequency);
		if (maxFreq > 0) {
			for (let i = 0; i < this.#spatialFrequency.length; i++) {
				this.#spatialFrequency[i] = this.#spatialFrequency[i]! /
					maxFreq;
			}
		}
	}

	// Content detection getters (removed - use separate AI nodes)
	// get hasFaces(): boolean { return this.#hasFaces; }
	// get hasText(): boolean { return this.#hasText; }
	// get sceneChange(): boolean { return this.#sceneChange; }

	override dispose(): void {
		if (this.disposed) return;
		this.#previousFrameData = null;
		this.context._unregister(this);
		super.dispose();
	}
}

import type { VideoContext } from "./context.ts";
import { VideoNode } from "./video_node.ts";

/**
 * Frames waiting for a repaint. Decoded frames often arrive in pairs within
 * one repaint; keeping two lets each be drawn, one per repaint, without a
 * backlog building up behind them.
 */
const MAX_PENDING_FRAMES = 2;

export interface CanvasLike {
	width: number;
	height: number;
	getContext(contextId: "2d", ...options: unknown[]): CanvasRenderingContext2D | null;
}

export class VideoDestinationNode extends VideoNode {
	readonly canvas: CanvasLike;
	readonly context: VideoContext;
	#animateId?: number;
	#pendingFrames: VideoFrame[] = [];
	#isVisible: boolean = true;
	#renderFunction: VideoRenderFunction;
	#delayFunc?: () => Promise<void>;
	#timeoutId?: number;

	constructor(
		context: VideoContext,
		canvas: CanvasLike,
		options?: {
			renderFunction?: VideoRenderFunction;
		},
	) {
		super({ numberOfInputs: 1, numberOfOutputs: 0 });
		this.context = context;
		this.context._register(this);
		this.canvas = canvas;
		this.#renderFunction = options?.renderFunction ??
			VideoRenderFunctions.contain;
	}

	get renderFunction(): VideoRenderFunction {
		return this.#renderFunction;
	}

	set renderFunction(fn: VideoRenderFunction) {
		this.#renderFunction = fn;
	}

	get delayFunc(): (() => Promise<void>) | undefined {
		return this.#delayFunc;
	}

	set delayFunc(fn: (() => Promise<void>) | undefined) {
		this.#delayFunc = fn;
	}

	get isVisible(): boolean {
		return this.#isVisible;
	}

	process(input: VideoFrame): void {
		if (this.disposed || this.context.state !== "running") {
			return;
		}

		// Ownership: Caller owns input, so we clone for our use
		this.#pendingFrames.push(input.clone());

		// Past the limit the oldest waiting frame is dropped: showing the newest
		// matters more than showing every one.
		if (this.#pendingFrames.length > MAX_PENDING_FRAMES) {
			this.#closeFrame(this.#pendingFrames.shift());
		}

		this.#scheduleRender();
	}

	// Draws one pending frame per repaint, and schedules the next repaint while
	// frames remain. Only one rAF is scheduled at a time.
	#scheduleRender(): void {
		if (this.#animateId) return;

		this.#animateId = requestAnimationFrame(() => {
			this.#animateId = undefined;

			// Clear timeout since rAF fired
			if (this.#timeoutId !== undefined) {
				clearTimeout(this.#timeoutId);
				this.#timeoutId = undefined;
			}

			void this.#renderVideoFrame(this.#pendingFrames.shift());
			if (this.#pendingFrames.length > 0) this.#scheduleRender();
		});

		// Fallback: drop pending frames after 1 second if rAF doesn't fire
		// (e.g., tab backgrounded)
		this.#timeoutId = setTimeout(() => {
			if (this.#animateId) {
				cancelAnimationFrame(this.#animateId);
				this.#animateId = undefined;
			}
			this.#closePendingFrames();
			this.#timeoutId = undefined;
		}, 1000);

		// Pending frames are closed when drawn (#renderVideoFrame), dropped, or
		// disposed.
	}

	#closeFrame(frame: VideoFrame | undefined): void {
		if (!frame) return;
		try {
			frame.close();
		} catch (e) {
			console.error("[VideoDestinationNode] frame close error:", e);
		}
	}

	#closePendingFrames(): void {
		for (const frame of this.#pendingFrames) this.#closeFrame(frame);
		this.#pendingFrames = [];
	}

	async #renderVideoFrame(frame?: VideoFrame): Promise<void> {
		if (!frame) return;

		// Skip rendering if canvas is not visible
		if (!this.#isVisible) {
			try {
				frame.close();
			} catch (e) {
				console.error("[VideoDestinationNode] frame close error:", e);
			}
			return;
		}

		// Check if delay function is defined
		if (this.#delayFunc) {
			try {
				await this.#delayFunc();
			} catch (error) {
				console.warn("[VideoDestinationNode] delay error:", error);
			}
		}

		// Calculate rendering dimensions using render function
		const { x, y, width, height } = this.#renderFunction(
			frame.displayWidth,
			frame.displayHeight,
			this.canvas.width,
			this.canvas.height,
		);

		// Get 2D context
		const ctx = this.canvas.getContext("2d");
		if (!ctx) {
			try {
				frame.close();
			} catch (_) {
				/* ignore */
			}
			return;
		}

		// Clear the canvas and draw frame. try/finally guarantees the frame is
		// closed even if drawImage throws (e.g. zero-size geometry) — otherwise
		// the frame leaks and the rejection propagates unhandled.
		try {
			ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
			ctx.drawImage(frame, x, y, width, height);
		} finally {
			try {
				frame.close();
			} catch (e) {
				console.error("[VideoDestinationNode] frame close error:", e);
			}
		}
	}

	setVisible(visible: boolean): void {
		this.#isVisible = visible;
	}

	override dispose(): void {
		if (this.disposed) return;
		// Cancel any scheduled animation
		if (this.#animateId) {
			cancelAnimationFrame(this.#animateId);
			this.#animateId = undefined;
		}
		// Cancel timeout
		if (this.#timeoutId !== undefined) {
			clearTimeout(this.#timeoutId);
			this.#timeoutId = undefined;
		}
		this.#closePendingFrames();
		this.context._unregister(this);
		super.dispose();
	}
}

export type VideoRenderFunction = (
	frameWidth: number,
	frameHeight: number,
	canvasWidth: number,
	canvasHeight: number,
) => { x: number; y: number; width: number; height: number };
export const VideoRenderFunctions = {
	contain: (
		frameWidth: number,
		frameHeight: number,
		canvasWidth: number,
		canvasHeight: number,
	): { x: number; y: number; width: number; height: number } => {
		const frameAspect = frameWidth / frameHeight;
		const canvasAspect = canvasWidth / canvasHeight;

		if (frameAspect > canvasAspect) {
			// Frame is wider, fit to width
			const height = canvasWidth / frameAspect;
			const y = (canvasHeight - height) / 2;
			return { x: 0, y, width: canvasWidth, height };
		} else {
			// Frame is taller, fit to height
			const width = canvasHeight * frameAspect;
			const x = (canvasWidth - width) / 2;
			return { x, y: 0, width, height: canvasHeight };
		}
	},

	cover: (
		frameWidth: number,
		frameHeight: number,
		canvasWidth: number,
		canvasHeight: number,
	): { x: number; y: number; width: number; height: number } => {
		const frameAspect = frameWidth / frameHeight;
		const canvasAspect = canvasWidth / canvasHeight;

		if (frameAspect > canvasAspect) {
			// Frame is wider, fit to height
			const width = canvasHeight * frameAspect;
			const x = (canvasWidth - width) / 2;
			return { x, y: 0, width, height: canvasHeight };
		} else {
			// Frame is taller, fit to width
			const height = canvasWidth / frameAspect;
			const y = (canvasHeight - height) / 2;
			return { x: 0, y, width: canvasWidth, height };
		}
	},

	fill: (
		_frameWidth: number,
		_frameHeight: number,
		canvasWidth: number,
		canvasHeight: number,
	): { x: number; y: number; width: number; height: number } => {
		// Fill entire canvas, may distort
		return { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
	},

	scaleDown: (
		frameWidth: number,
		frameHeight: number,
		canvasWidth: number,
		canvasHeight: number,
	): { x: number; y: number; width: number; height: number } => {
		// Only scale down, never up
		if (frameWidth <= canvasWidth && frameHeight <= canvasHeight) {
			// No scaling needed
			const x = (canvasWidth - frameWidth) / 2;
			const y = (canvasHeight - frameHeight) / 2;
			return { x, y, width: frameWidth, height: frameHeight };
		} else {
			// Scale down using contain logic
			return VideoRenderFunctions.contain(
				frameWidth,
				frameHeight,
				canvasWidth,
				canvasHeight,
			);
		}
	},
};

import type { VideoContext } from "./context.ts";
import { VideoNode } from "./video_node.ts";

export class VideoDestinationNode extends VideoNode {
	readonly canvas: HTMLCanvasElement;
	readonly context: VideoContext;
	#animateId?: number;
	#pendingFrame?: VideoFrame;
	#isVisible: boolean = true;
	#renderFunction: VideoRenderFunction;
	#delayFunc?: () => Promise<void>;
	#timeoutId?: number;

	constructor(
		context: VideoContext,
		canvas: HTMLCanvasElement,
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
		const clonedFrame = input.clone();

		// Replace any pending frame (not yet rendered) with the newest one.
		// Close the replaced pending frame to avoid leaking VideoFrames.
		const pendingFrame = this.#pendingFrame;
		this.#pendingFrame = clonedFrame;
		if (pendingFrame) {
			try {
				pendingFrame.close();
			} catch (e) {
				console.error("[VideoDestinationNode] frame close error:", e);
			}
		}

		// Only schedule ONE rAF at a time; it will render the latest pending frame.
		if (this.#animateId) return;

		this.#animateId = requestAnimationFrame(() => {
			this.#animateId = undefined;

			// Clear timeout since rAF fired
			if (this.#timeoutId !== undefined) {
				clearTimeout(this.#timeoutId);
				this.#timeoutId = undefined;
			}

			const frame = this.#pendingFrame;
			this.#pendingFrame = undefined;
			void this.#renderVideoFrame(frame);
		});

		// Fallback: force cleanup after 1 second if rAF doesn't fire (e.g., tab backgrounded)
		this.#timeoutId = setTimeout(() => {
			if (this.#animateId) {
				cancelAnimationFrame(this.#animateId);
				this.#animateId = undefined;
			}

			const frame = this.#pendingFrame;
			this.#pendingFrame = undefined;
			if (frame) {
				try {
					frame.close();
				} catch (e) {
					console.error(
						"[VideoDestinationNode] timeout cleanup error:",
						e,
					);
				}
			}

			this.#timeoutId = undefined;
		}, 1000);

		// We don't need to close the clonedFrame here, as it is either assigned
		// to #pendingFrame (to be closed later) or closed in #renderVideoFrame.
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

		// Clear the canvas and draw frame
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		ctx.drawImage(frame, x, y, width, height);

		// Close the frame after rendering
		try {
			frame.close();
		} catch (e) {
			console.error("[VideoDestinationNode] frame close error:", e);
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
		if (this.#pendingFrame) {
			try {
				this.#pendingFrame.close();
			} catch (e) {
				console.error("[VideoDestinationNode] frame close error:", e);
			} finally {
				this.#pendingFrame = undefined;
			}
		}
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

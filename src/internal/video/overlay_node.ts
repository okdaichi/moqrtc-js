import { VideoNode } from "./video_node.ts";

/**
 * Overlay as a first-class node.
 *
 * Design: decode -> overlay -> destination
 * - Overlay receives a VideoFrame
 * - Composites overlay graphics onto it (creates a new VideoFrame)
 * - Passes the modified VideoFrame to the next node
 * - Destination just draws whatever VideoFrame it receives
 */
export class VideoOverlayNode extends VideoNode {
	#overlay: VideoOverlayFunction;
	#canvas: OffscreenCanvas;
	#ctx: OffscreenCanvasRenderingContext2D | null;

	constructor(options: { overlay: VideoOverlayFunction }) {
		super({ numberOfInputs: 1, numberOfOutputs: 1 });
		this.#overlay = options.overlay;
		this.#canvas = new OffscreenCanvas(1, 1);
		this.#ctx = this.#canvas.getContext("2d");
	}

	get overlay(): VideoOverlayFunction {
		return this.#overlay;
	}

	set overlay(fn: VideoOverlayFunction) {
		this.#overlay = fn;
	}

	/**
	 * Composite overlay onto the input VideoFrame and output a new VideoFrame.
	 */
	process(input: VideoFrame): void {
		if (this.disposed) {
			return;
		}

		const clonedFrame = input.clone();

		if (!this.#ctx) {
			// No context; pass through unchanged
			for (const output of Array.from(this.outputs)) {
				try {
					output.process(clonedFrame);
				} catch (e) {
					console.error("[VideoOverlayNode] process error:", e);
				}
			}

			// Close the input frame (we own it)
			clonedFrame.close();

			return;
		}

		try {
			const width = clonedFrame.displayWidth;
			const height = clonedFrame.displayHeight;

			// Resize canvas if needed
			if (
				this.#canvas.width !== width || this.#canvas.height !== height
			) {
				this.#canvas.width = width;
				this.#canvas.height = height;
			}

			// Draw the input VideoFrame
			this.#ctx.clearRect(0, 0, width, height);
			this.#ctx.drawImage(clonedFrame, 0, 0, width, height);

			// Draw overlay on top
			this.#overlay(this.#ctx, this.#canvas);

			// Create a new VideoFrame from the composited canvas
			const outputFrame = new VideoFrame(this.#canvas, {
				timestamp: clonedFrame.timestamp,
				duration: clonedFrame.duration ?? undefined,
			});

			// Close the input frame (we own it)
			clonedFrame.close();

			// Pass cloned frames to outputs (we own outputFrame)
			for (const output of Array.from(this.outputs)) {
				try {
					// Clone for each output (lightweight reference clone)
					output.process(outputFrame);
				} catch (e) {
					if (
						e instanceof DOMException && e.name === "InvalidStateError"
					) {
						console.warn("[VideoOverlayNode] Cannot clone closed frame");
					} else {
						console.error("[VideoOverlayNode] process error:", e);
					}
				}
			}

			// Close the original output frame (we created it, we close it)
			outputFrame.close();
		} catch (e) {
			console.error("[VideoOverlayNode] overlay composition error:", e);
		}
	}
}

export type VideoOverlayFunction = (
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	canvas: HTMLCanvasElement | OffscreenCanvas,
) => void;

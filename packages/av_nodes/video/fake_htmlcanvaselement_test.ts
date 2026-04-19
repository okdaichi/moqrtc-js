import type { CanvasLike } from "./destination_node.ts";

/**
 * FakeHTMLCanvasElement for Deno test environments.
 * Provides a working 2D canvas context backed by a Uint8ClampedArray pixel buffer.
 */
export class FakeHTMLCanvasElement implements CanvasLike {
	width: number;
	height: number;

	#pixels: Uint8ClampedArray;

	constructor(width = 640, height = 480) {
		this.width = width;
		this.height = height;
		this.#pixels = new Uint8ClampedArray(width * height * 4);
	}

	getContext(type: string): CanvasRenderingContext2D | null {
		if (type !== "2d") return null;

		const width = this.width;
		const height = this.height;
		const pixels = this.#pixels;
		return {
			drawImage(
				_source: unknown,
				_sx: number,
				_sy: number,
				_sw?: number,
				_sh?: number,
			): void {
				// Simulated draw: no-op for tests that just verify the call happens
			},
			clearRect(x: number, y: number, w: number, h: number): void {
				const stride = width * 4;
				for (let row = y; row < Math.min(y + h, height); row++) {
					pixels.fill(0, row * stride + x * 4, row * stride + (x + w) * 4);
				}
			},
			getImageData(x: number, y: number, w: number, h: number) {
				const out = new Uint8ClampedArray(w * h * 4);
				const stride = width * 4;
				for (let row = 0; row < h; row++) {
					const srcOffset = (y + row) * stride + x * 4;
					out.set(pixels.subarray(srcOffset, srcOffset + w * 4), row * w * 4);
				}
				return { data: out, width: w, height: h };
			},
			putImageData(imageData: { data: Uint8ClampedArray }, x: number, y: number): void {
				const stride = width * 4;
				const srcStride = imageData.data.length / (height || 1);
				for (let row = 0; row < height; row++) {
					pixels.set(
						imageData.data.subarray(row * srcStride, (row + 1) * srcStride),
						(y + row) * stride + x * 4,
					);
				}
			},
			fillText: (_text: string, _x: number, _y: number) => {},
			fillStyle: "" as string | CanvasGradient | CanvasPattern,
			font: "",
			textAlign: "left" as CanvasTextAlign,
			textBaseline: "top" as CanvasTextBaseline,
		} as unknown as CanvasRenderingContext2D;
	}
}

export class FakeOffscreenCanvas {
	width: number;
	height: number;

	constructor(width = 640, height = 480) {
		this.width = width;
		this.height = height;
	}

	getContext(_type: string): OffscreenCanvasRenderingContext2D | null {
		return {
			drawImage: (_source: unknown, _dx: number, _dy: number) => {},
			getImageData: (_x: number, _y: number, w: number, h: number) => ({
				data: new Uint8ClampedArray(w * h * 4).fill(128),
				width: w,
				height: h,
			}),
		} as unknown as OffscreenCanvasRenderingContext2D;
	}
}

export function overrideOffscreenCanvas() {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasOffscreenCanvas = Object.prototype.hasOwnProperty.call(g, "OffscreenCanvas");
	const originalOffscreenCanvas = g.OffscreenCanvas;

	if (typeof OffscreenCanvas === "undefined") {
		g.OffscreenCanvas = FakeOffscreenCanvas as unknown;
	}

	return () => {
		if (hasOffscreenCanvas) {
			g.OffscreenCanvas = originalOffscreenCanvas;
		} else {
			delete g.OffscreenCanvas;
		}
	};
}

export function overrideIdleCallback() {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasRequestIdleCallback = Object.prototype.hasOwnProperty.call(g, "requestIdleCallback");
	const originalRequestIdleCallback = g.requestIdleCallback;
	const hasCancelIdleCallback = Object.prototype.hasOwnProperty.call(g, "cancelIdleCallback");
	const originalCancelIdleCallback = g.cancelIdleCallback;

	if (typeof requestIdleCallback === "undefined") {
		(g as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (
			callback: () => void,
		) => {
			setTimeout(callback, 1);
			return 1;
		};
	}

	if (typeof cancelIdleCallback === "undefined") {
		(g as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = (_id: number) => {
			clearTimeout(_id);
		};
	}

	return () => {
		if (hasRequestIdleCallback) {
			g.requestIdleCallback = originalRequestIdleCallback;
		} else {
			delete g.requestIdleCallback;
		}
		if (hasCancelIdleCallback) {
			g.cancelIdleCallback = originalCancelIdleCallback;
		} else {
			delete g.cancelIdleCallback;
		}
	};
}

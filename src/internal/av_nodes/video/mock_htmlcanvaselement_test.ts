import { spy } from "@std/testing/mock";

export class MockHTMLCanvasElement {
	width: number = 640;
	height: number = 480;
	getContext = spy((type: string): CanvasRenderingContext2D | null => {
		if (type === "2d") {
			return {
				drawImage: undefined, /* TODO: Convert mock */
				clearRect: undefined, /* TODO: Convert mock */
				getImageData: spy(() => ({
					data: new Uint8ClampedArray(this.width * this.height * 4),
				})),
			} as any;
		}
		return null;
	});
}

export class FakeVideoFrame implements VideoFrame {
	displayWidth: number;
	displayHeight: number;
	codedWidth: number;
	codedHeight: number;
	timestamp: number;
	duration: number | null;
	colorSpace: VideoColorSpace;
	visibleRect: DOMRectReadOnly | null;
	codedRect: DOMRectReadOnly | null;
	format: VideoPixelFormat | null;

	#closed = false;

	constructor(
		width = 640,
		height = 480,
		timestamp = 0,
	) {
		this.displayWidth = width;
		this.displayHeight = height;
		this.codedWidth = width;
		this.codedHeight = height;
		this.timestamp = timestamp;
		this.duration = null;
		this.colorSpace = {} as VideoColorSpace;
		this.visibleRect = null;
		this.codedRect = null;
		this.format = "RGBX";
	}

	allocationSize(_options?: VideoFrameCopyToOptions): number {
		return this.displayWidth * this.displayHeight * 4;
	}

	copyTo(
		destination: AllowSharedBufferSource,
		_options?: VideoFrameCopyToOptions,
	): Promise<PlaneLayout[]> {
		if (destination instanceof Uint8Array) {
			// Fill with a test pattern: R=255, G=128, B=64, A=255
			for (let i = 0; i < destination.length; i += 4) {
				destination[i] = 255;
				destination[i + 1] = 128;
				destination[i + 2] = 64;
				destination[i + 3] = 255;
			}
		}
		return Promise.resolve([
			{ offset: 0, stride: this.displayWidth * 4 },
		]);
	}

	clone(): VideoFrame {
		return this;
	}

	close(): void {
		this.#closed = true;
	}

	get isClosed(): boolean {
		return this.#closed;
	}
}

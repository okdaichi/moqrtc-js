export class MockVideoFrame implements VideoFrame {
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

	constructor(width: number = 640, height: number = 480, timestamp: number = 0) {
		this.displayWidth = width;
		this.displayHeight = height;
		this.codedWidth = width;
		this.codedHeight = height;
		this.timestamp = timestamp;
		this.duration = null;
		this.colorSpace = {} as VideoColorSpace;
		this.visibleRect = null;
		this.codedRect = null;
		this.format = null;
	}

	copyTo(
		destination: AllowSharedBufferSource,
		_options?: VideoFrameCopyToOptions,
	): Promise<PlaneLayout[]> {
		// Fill with test pattern
		if (destination instanceof Uint8Array) {
			for (let i = 0; i < destination.length; i += 4) {
				destination[i] = 255; // R
				destination[i + 1] = 128; // G
				destination[i + 2] = 64; // B
				destination[i + 3] = 255; // A
			}
		}
		return Promise.resolve([]);
	}

	clone(): VideoFrame {
		return new MockVideoFrame(this.displayWidth, this.displayHeight, this.timestamp);
	}

	close(): void {
		// Mock close
	}

	allocationSize(_options?: VideoFrameCopyToOptions): number {
		return this.displayWidth * this.displayHeight * 4;
	}
}

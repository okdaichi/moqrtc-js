export class FakeEncodedVideoChunk implements EncodedVideoChunk {
	type: "key" | "delta";
	timestamp: number;
	duration: number | null;
	byteLength: number;

	constructor(
		type: "key" | "delta" = "key",
		timestamp = 0,
		duration: number | null = 33000,
		byteLength = 1024,
	) {
		this.type = type;
		this.timestamp = timestamp;
		this.duration = duration;
		this.byteLength = byteLength;
	}

	copyTo(destination: AllowSharedBufferSource): void {
		if (destination instanceof Uint8Array) {
			for (let i = 0; i < Math.min(destination.length, this.byteLength); i++) {
				destination[i] = i % 256;
			}
		}
	}
}

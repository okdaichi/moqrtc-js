import { spy } from "@std/testing/mock";

export class MockEncodedVideoChunk implements EncodedVideoChunk {
	type: "key" | "delta";
	timestamp: number;
	duration: number | null;
	byteLength: number;
	copyTo: (destination: AllowSharedBufferSource) => void;

	constructor(
		type: "key" | "delta" = "key",
		timestamp: number = 0,
		duration: number | null = 33,
		byteLength: number = 1024,
	) {
		this.type = type;
		this.timestamp = timestamp;
		this.duration = duration;
		this.byteLength = byteLength;
		this.copyTo = spy((dest) => {
			if (dest instanceof Uint8Array) {
				// Fill with dummy data
				for (let i = 0; i < Math.min(dest.length, byteLength); i++) {
					dest[i] = i % 256;
				}
			}
		});
	}
}

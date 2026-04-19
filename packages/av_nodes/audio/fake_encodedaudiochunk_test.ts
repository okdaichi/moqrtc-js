/**
 * FakeEncodedAudioChunk for Deno test environments.
 * Implements EncodedAudioChunk with real-like copyTo behaviour.
 */
export class FakeEncodedAudioChunk implements EncodedAudioChunk {
	type: EncodedAudioChunkType;
	timestamp: number;
	duration: number | null;
	byteLength: number;

	constructor(
		type: EncodedAudioChunkType = "key",
		timestamp = 0,
		duration: number | null = null,
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

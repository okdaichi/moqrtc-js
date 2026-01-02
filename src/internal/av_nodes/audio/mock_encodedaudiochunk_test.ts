export class MockEncodedAudioChunk implements EncodedAudioChunk {
	timestamp: number;
	duration: number | null;
	type: EncodedAudioChunkType;
	byteLength: number;
	copyTo(_destination: AllowSharedBufferSource): void {
		// Mock copy - fill with dummy data
		if (_destination instanceof Uint8Array) {
			for (let i = 0; i < _destination.length; i++) {
				_destination[i] = i % 256;
			}
		}
	}

	constructor(_type: EncodedAudioChunkType = "key", _timestamp: number = 0) {
		this.type = _type;
		this.timestamp = _timestamp;
		this.duration = null;
		this.byteLength = 1024;
	}
}

export class MockAudioData implements AudioData {
	numberOfFrames: number;
	numberOfChannels: number;
	sampleRate: number;
	format: AudioSampleFormat;
	readonly duration: number;
	readonly timestamp: number;

	constructor(_frames: number = 1024, _channels: number = 2, _sampleRate: number = 44100) {
		this.numberOfFrames = _frames;
		this.numberOfChannels = _channels;
		this.sampleRate = _sampleRate;
		this.format = "f32";
		this.duration = (_frames / _sampleRate) * 1000000; // microseconds
		this.timestamp = 0;
	}

	copyTo(_destination: AllowSharedBufferSource, _options?: AudioDataCopyToOptions): void {
		// Fill with test audio data
		if (_destination instanceof Float32Array) {
			for (let i = 0; i < _destination.length; i++) {
				_destination[i] = Math.sin(i * 0.01); // Simple sine wave
			}
		}
	}

	clone(): AudioData {
		return new MockAudioData(this.numberOfFrames, this.numberOfChannels, this.sampleRate);
	}

	close(): void {
		// Mock close
	}

	allocationSize(_options: AudioDataCopyToOptions): number {
		return this.numberOfFrames * this.numberOfChannels * 4; // 4 bytes per float32
	}
}

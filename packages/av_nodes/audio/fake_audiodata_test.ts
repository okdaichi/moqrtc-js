/**
 * FakeAudioData for Deno test environments.
 * Implements AudioData interface with real-like data (sine wave).
 */
export class FakeAudioData implements AudioData {
	numberOfFrames: number;
	numberOfChannels: number;
	sampleRate: number;
	format: AudioSampleFormat;
	readonly duration: number;
	readonly timestamp: number;

	constructor(
		numberOfFrames = 1024,
		numberOfChannels = 2,
		sampleRate = 44100,
		timestamp = 0,
	) {
		this.numberOfFrames = numberOfFrames;
		this.numberOfChannels = numberOfChannels;
		this.sampleRate = sampleRate;
		this.format = "f32";
		this.duration = (numberOfFrames / sampleRate) * 1_000_000; // microseconds
		this.timestamp = timestamp;
	}

	allocationSize(_options: AudioDataCopyToOptions): number {
		return this.numberOfFrames * 4; // 4 bytes per float32 sample per channel plane
	}

	copyTo(
		destination: AllowSharedBufferSource,
		options?: AudioDataCopyToOptions,
	): void {
		if (destination instanceof Float32Array) {
			const channelIndex = options?.planeIndex ?? 0;
			for (let i = 0; i < destination.length; i++) {
				// Simple sine wave per channel offset so channels differ
				destination[i] = Math.sin((i + channelIndex * 100) * 0.01);
			}
		}
	}

	clone(): AudioData {
		return new FakeAudioData(
			this.numberOfFrames,
			this.numberOfChannels,
			this.sampleRate,
			this.timestamp,
		);
	}

	close(): void {}
}

// URL getter function for main thread import
export function importWorkletUrl(): string {
	return new URL("./audio_offload_worklet.js", import.meta.url).href;
}

export const workletName: string = "audio-offloader";

// Check if we're in a worklet context
if (typeof AudioWorkletProcessor !== "undefined") {
	// AudioWorkletProcessor for AudioEmitter
	class AudioOffloadProcessor extends AudioWorkletProcessor {
		#channelsBuffer: Float32Array[] = [];

		#readIndex: number = 0;
		#writeIndex: number = 0;

		constructor(options: AudioWorkletNodeOptions) {
			super();
			if (!options.processorOptions) {
				throw new Error("processorOptions is required");
			}

			const channelCount = options.channelCount;
			if (!channelCount || channelCount <= 0) {
				throw new Error("invalid channelCount");
			}

			const sampleRate = options.processorOptions.sampleRate;
			if (!sampleRate || sampleRate <= 0) {
				throw new Error("invalid sampleRate");
			}

			const latency = options.processorOptions.latency;
			if (!latency || latency <= 0) {
				throw new Error("invalid latency");
			}

			const bufferingSamples = Math.ceil(sampleRate * latency / 1000);

			for (let i = 0; i < channelCount; i++) {
				this.#channelsBuffer[i] = new Float32Array(bufferingSamples);
			}

			this.port.onmessage = (
				{ data }: { data: { channels: Float32Array[]; timestamp: number } },
			) => {
				this.append(data.channels);
				// We do not use timestamp for now
				// TODO: handle timestamp and sync if needed
			};
		}

		append(channels: Float32Array[]): void {
			if (!channels.length || !channels[0] || channels[0].length === 0) {
				return;
			}

			// Not initialized yet. Skip
			if (
				this.#channelsBuffer === undefined ||
				this.#channelsBuffer.length === 0 ||
				this.#channelsBuffer[0] === undefined
			) return;

			const bufferLength = this.#channelsBuffer[0].length;
			const numberOfFrames = channels[0].length;

			// Advance read index for discarded samples (if buffer would overflow)
			const discard = this.#writeIndex - this.#readIndex + numberOfFrames - bufferLength;
			if (discard > 0) {
				this.#readIndex += discard;
			}

			// Write new samples to buffer (ring buffer)
			for (let channel = 0; channel < this.#channelsBuffer.length; channel++) {
				const src = channels[channel];
				const dst = this.#channelsBuffer[channel];

				if (!dst) continue;
				if (!src) {
					// Fill with silence if no source data
					const writeStart = this.#writeIndex % bufferLength;
					const firstPart = Math.min(numberOfFrames, bufferLength - writeStart);
					dst.fill(0, writeStart, writeStart + firstPart);
					if (firstPart < numberOfFrames) {
						dst.fill(0, 0, numberOfFrames - firstPart);
					}
					continue;
				}

				// Copy source data to ring buffer
				let writePos = this.#writeIndex % bufferLength;
				let srcOffset = 0;

				while (srcOffset < numberOfFrames) {
					const remaining = numberOfFrames - srcOffset;
					const spaceToEnd = bufferLength - writePos;
					const toCopy = Math.min(remaining, spaceToEnd);

					dst.set(src.subarray(srcOffset, srcOffset + toCopy), writePos);

					srcOffset += toCopy;
					writePos = (writePos + toCopy) % bufferLength;
				}
			}

			this.#writeIndex += numberOfFrames;
		}

		process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
			// No output to write to
			if (
				outputs === undefined ||
				outputs.length === 0 ||
				outputs[0] === undefined ||
				outputs[0]?.length === 0
			) return true;

			// Not initialized yet
			if (this.#channelsBuffer.length === 0 || this.#channelsBuffer[0] === undefined) {
				return true;
			}

			const bufferLength = this.#channelsBuffer[0].length;

			// Calculate available samples (handle wrap-around)
			const available = this.#writeIndex - this.#readIndex;
			const outputLength = outputs[0][0]?.length ?? 128;
			const numberOfFrames = Math.min(Math.max(0, available), outputLength);

			// Fill output with silence if no data available
			if (numberOfFrames <= 0) {
				for (const output of outputs) {
					for (const channel of output) {
						if (channel) channel.fill(0);
					}
				}
				return true;
			}

			for (const output of outputs) {
				for (let channel = 0; channel < output.length; channel++) {
					const src = this.#channelsBuffer[channel];
					const dst = output[channel];
					if (!dst) continue;
					if (!src) {
						dst.fill(0);
						continue;
					}

					// Read from ring buffer
					let readPos = this.#readIndex % bufferLength;
					let dstOffset = 0;

					while (dstOffset < numberOfFrames) {
						const remaining = numberOfFrames - dstOffset;
						const availableToEnd = bufferLength - readPos;
						const toCopy = Math.min(remaining, availableToEnd);

						dst.set(src.subarray(readPos, readPos + toCopy), dstOffset);

						dstOffset += toCopy;
						readPos = (readPos + toCopy) % bufferLength;
					}

					// Fill remaining with silence
					if (dstOffset < dst.length) {
						dst.fill(0, dstOffset);
					}
				}
			}

			// Advance read index
			this.#readIndex += numberOfFrames;

			return true;
		}
	}

	registerProcessor(workletName, AudioOffloadProcessor);
}

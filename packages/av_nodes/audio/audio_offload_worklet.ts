// URL getter function for main thread import
export function importWorkletUrl(): string {
	return new URL("./audio_offload_worklet.js", import.meta.url).href;
}

export const workletName: string = "audio-offloader";

// Check if we're in a worklet context
if (typeof AudioWorkletProcessor !== "undefined") {
	// AudioWorkletProcessor for AudioEmitter
	//
	// Timestamp-scheduled jitter buffer. Each decoded block carries a
	// presentation timestamp (µs). Instead of writing blocks contiguously at
	// arrival (which makes the buffer level a function of arrival cadence and
	// clicks on bursty/jittery delivery), every block is written at the audio
	// frame it should be presented at, derived from its timestamp. `process()`
	// drains by playback frame. Gaps are silence-filled; late/overlapping
	// blocks are dropped/overwritten; bursts are absorbed up to one buffer of
	// look-ahead. See issue #18.
	class AudioOffloadProcessor extends AudioWorkletProcessor {
		#channelsBuffer: Float32Array[] = [];

		// Absolute playback frame counter. Drives the read side; advanced by the
		// output length each `process()` quantum. This is the audio clock.
		#playoutFrame: number = 0;

		// Media-clock origin: the timestamp (µs) of the first block, captured once.
		#baseTsUs: number | null = null;

		// Absolute frame up to which the ring has been written (gaps silence-filled).
		// `null` until the first block establishes #baseTsUs.
		#nextWriteFrame: number | null = null;

		// Presentation lag (cushion) in frames. The first block plays this many
		// frames after playback start, giving the buffer room to absorb jitter.
		#lagSamples: number = 0;

		// Ring size in frames. Twice the lag: one lag for the cushion, one for
		// burst/jitter headroom. Slot for absolute frame P is at P % #bufferLength.
		#bufferLength: number = 0;

		readonly #sampleRate: number = 0;

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

			this.#sampleRate = sampleRate;
			this.#lagSamples = Math.ceil(sampleRate * latency / 1000);
			this.#bufferLength = this.#lagSamples * 2;

			for (let i = 0; i < channelCount; i++) {
				this.#channelsBuffer[i] = new Float32Array(this.#bufferLength);
			}

			this.port.onmessage = (
				{ data }: { data: { channels: Float32Array[]; timestamp: number } },
			) => {
				this.append(data.channels, data.timestamp);
			};
		}

		// Playout frame for a media timestamp (µs), relative to the captured origin.
		#playoutFrameForTs(tsUs: number): number {
			// #baseTsUs is set before this is ever called.
			const base = this.#baseTsUs ?? 0;
			return this.#lagSamples +
				Math.round((tsUs - base) * this.#sampleRate / 1_000_000);
		}

		// Zero-fill ring slots [from, to) on every channel (wrap-aware).
		#silenceFill(from: number, to: number): void {
			const len = this.#bufferLength;
			for (const dst of this.#channelsBuffer) {
				if (!dst) continue;
				let pos = from % len;
				let remaining = to - from;
				while (remaining > 0) {
					const toCopy = Math.min(remaining, len - pos);
					dst.fill(0, pos, pos + toCopy);
					pos = (pos + toCopy) % len;
					remaining -= toCopy;
				}
			}
		}

		append(channels: Float32Array[], tsUs: number): void {
			if (!channels.length || !channels[0] || channels[0].length === 0) {
				return;
			}

			// Not initialized yet. Skip
			if (
				this.#channelsBuffer === undefined ||
				this.#channelsBuffer.length === 0 ||
				this.#channelsBuffer[0] === undefined
			) return;

			const numberOfFrames = channels[0].length;

			// First block establishes the media-clock origin. Start the write head
			// at 0 so the gap-fill below silence-fills the pre-roll region [0, start)
			// — keeping the invariant that everything in [0, #nextWriteFrame) is
			// validly populated (never relies on the ring happening to start zeroed).
			if (this.#baseTsUs === null) {
				this.#baseTsUs = tsUs;
				this.#nextWriteFrame = 0;
			}

			let start = this.#playoutFrameForTs(tsUs);
			let end = start + numberOfFrames;

			// Stale (late) block: its whole range is already in the playback past.
			// Drop it rather than clobber current playback.
			if (end <= this.#playoutFrame) {
				return;
			}

			// Burst cap: never write more than one buffer ahead of the read pointer,
			// or the ring would wrap over not-yet-played data. Drop the overflow tail.
			const maxFrame = this.#playoutFrame + this.#bufferLength;
			if (start >= maxFrame) {
				return;
			}
			if (end > maxFrame) {
				end = maxFrame;
			}

			// If the block is scheduled ahead of what we've written, the gap in
			// between is underrun media → silence-fill it so the read side sees no
			// stale data there.
			const writeHead = this.#nextWriteFrame ?? start;
			if (start > writeHead) {
				this.#silenceFill(writeHead, start);
			}

			const len = this.#bufferLength;
			const writeLen = end - start;

			for (let channel = 0; channel < this.#channelsBuffer.length; channel++) {
				const src = channels[channel];
				const dst = this.#channelsBuffer[channel];
				if (!dst) continue;

				// Missing source channel → silence for this block's range.
				if (!src) {
					let pos = start % len;
					let remaining = writeLen;
					while (remaining > 0) {
						const toCopy = Math.min(remaining, len - pos);
						dst.fill(0, pos, pos + toCopy);
						pos = (pos + toCopy) % len;
						remaining -= toCopy;
					}
					continue;
				}

				let writePos = start % len;
				let srcOffset = 0;
				while (srcOffset < writeLen) {
					const remaining = writeLen - srcOffset;
					const spaceToEnd = len - writePos;
					const toCopy = Math.min(remaining, spaceToEnd);
					dst.set(src.subarray(srcOffset, srcOffset + toCopy), writePos);
					srcOffset += toCopy;
					writePos = (writePos + toCopy) % len;
				}
			}

			if (this.#nextWriteFrame === null || end > this.#nextWriteFrame) {
				this.#nextWriteFrame = end;
			}
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

			const len = this.#bufferLength;
			const outputLength = outputs[0][0]?.length ?? 128;

			// How much real (written) data is available in this quantum. Slots beyond
			// #nextWriteFrame haven't been written yet → silence (startup pre-roll or
			// underrun). No base timestamp yet → nothing written → all silence.
			const written = this.#nextWriteFrame ?? this.#playoutFrame;
			const realEnd = Math.min(this.#playoutFrame + outputLength, written);
			const realFrames = Math.max(0, realEnd - this.#playoutFrame);

			for (const output of outputs) {
				for (let channel = 0; channel < output.length; channel++) {
					const src = this.#channelsBuffer[channel];
					const dst = output[channel];
					if (!dst) continue;
					if (!src || realFrames <= 0) {
						dst.fill(0);
						continue;
					}

					// Read the written region from the ring.
					let readPos = this.#playoutFrame % len;
					let dstOffset = 0;
					while (dstOffset < realFrames) {
						const remaining = realFrames - dstOffset;
						const availableToEnd = len - readPos;
						const toCopy = Math.min(remaining, availableToEnd);
						dst.set(src.subarray(readPos, readPos + toCopy), dstOffset);
						dstOffset += toCopy;
						readPos = (readPos + toCopy) % len;
					}

					// Fill the rest of the quantum with silence.
					if (dstOffset < dst.length) {
						dst.fill(0, dstOffset);
					}
				}
			}

			// Advance the playback clock.
			this.#playoutFrame += outputLength;

			return true;
		}
	}

	registerProcessor(workletName, AudioOffloadProcessor);
}

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
	//
	// Overlap policy is last-writer-wins: two blocks scheduled into the same
	// frame range simply overwrite (no keep-earliest, no mix). That's correct
	// for a single-source live stream; if this buffer is ever reused for
	// splicing / dual sources, that assumption needs revisiting.
	//
	// TODO(long-term drift): the playback clock (sound card, advanced once per
	// `process()` quantum) and the media clock (PTS) are independent oscillators
	// and will drift. The lag cushion absorbs ±lag; beyond that the buffer pins
	// one edge (persistent underrun or overflow). Fine for short/medium
	// sessions; a long-running stream wants a slow leaky correction (nudge
	// #playoutFrame ±1 sample when the level sits at an edge for N seconds).
	class AudioOffloadProcessor extends AudioWorkletProcessor {
		#channelsBuffer: Float32Array[] = [];

		// Absolute playback frame counter. Drives the read side; advanced by the
		// output length each `process()` quantum. This is the audio clock.
		#playoutFrame: number = 0;

		// Media-clock origin: the timestamp (µs) of the first block, captured once.
		#baseTsUs: number | null = null;

		// Playback frame at the moment the first block arrived. The lag cushion is
		// measured from HERE (not from frame 0), so a first block that arrives
		// after playback has already been idling still gets a full cushion —
		// otherwise it would map into the playback past and be dropped forever.
		#playoutOriginFrame: number = 0;

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

		// Playout frame for a media timestamp (µs): the first block's frame, plus
		// the lag cushion measured from first-arrival (#playoutOriginFrame), plus
		// the media-time delta. #baseTsUs / #playoutOriginFrame are set on the
		// first block before this is ever called.
		#playoutFrameForTs(tsUs: number): number {
			const base = this.#baseTsUs ?? 0;
			return this.#playoutOriginFrame + this.#lagSamples +
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

			// First block establishes the media-clock origin and anchors the lag
			// cushion to the playback frame at arrival. Start the write head at the
			// current read pointer so the gap-fill below populates the pre-roll
			// region [#playoutFrame, start) — everything in [#playoutFrame,
			// #nextWriteFrame) stays validly populated (without relying on the ring
			// happening to start zeroed, and without touching already-past slots).
			if (this.#baseTsUs === null) {
				this.#baseTsUs = tsUs;
				this.#playoutOriginFrame = this.#playoutFrame;
				this.#nextWriteFrame = this.#playoutFrame;
			}

			let start = this.#playoutFrameForTs(tsUs);
			const end = start + numberOfFrames;

			// Stale (late) block: its whole range is already in the playback past.
			// Drop it rather than clobber current playback.
			if (end <= this.#playoutFrame) {
				return;
			}

			// Partially-late block (start < #playoutFrame < end): discard the
			// already-played prefix. This keeps `start >= #playoutFrame`, so the
			// ring write never targets past slots (which would alias future reads on
			// wrap) and `start % #bufferLength` is never negative — a pre-base or
			// out-of-order timestamp can't reach `dst.set(..., negativeOffset)` and
			// kill the onmessage handler.
			let srcOffset0 = 0;
			if (start < this.#playoutFrame) {
				srcOffset0 = this.#playoutFrame - start;
				start = this.#playoutFrame;
			}

			// Burst cap: never write more than one buffer ahead of the read pointer,
			// or the ring would wrap over not-yet-played data. Drop the overflow tail.
			const maxFrame = this.#playoutFrame + this.#bufferLength;
			let writeEnd = end;
			if (start >= maxFrame) {
				return;
			}
			if (writeEnd > maxFrame) {
				writeEnd = maxFrame;
			}

			// If the block is scheduled ahead of what we've written, the gap in
			// between is underrun media → silence-fill it so the read side sees no
			// stale data there.
			const writeHead = this.#nextWriteFrame ?? start;
			if (start > writeHead) {
				this.#silenceFill(writeHead, start);
			}

			const len = this.#bufferLength;
			const writeLen = writeEnd - start;

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
					dst.set(
						src.subarray(srcOffset0 + srcOffset, srcOffset0 + srcOffset + toCopy),
						writePos,
					);
					srcOffset += toCopy;
					writePos = (writePos + toCopy) % len;
				}
			}

			if (this.#nextWriteFrame === null || writeEnd > this.#nextWriteFrame) {
				this.#nextWriteFrame = writeEnd;
			}
		}

		process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
			// process() is invoked once per render quantum, so the playback clock
			// advances by one quantum on every call — including the guard paths
			// below. Skipping the advance on an empty-outputs / not-initialized
			// quantum would stall #playoutFrame while real time (and the timestamps
			// scheduled against it) keeps moving, dropping every later block.
			const outputLength = outputs?.[0]?.[0]?.length ?? 128;

			// No output to write to
			if (
				outputs === undefined ||
				outputs.length === 0 ||
				outputs[0] === undefined ||
				outputs[0]?.length === 0
			) {
				this.#playoutFrame += outputLength;
				return true;
			}

			// Not initialized yet
			if (this.#channelsBuffer.length === 0 || this.#channelsBuffer[0] === undefined) {
				this.#playoutFrame += outputLength;
				return true;
			}

			const len = this.#bufferLength;

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

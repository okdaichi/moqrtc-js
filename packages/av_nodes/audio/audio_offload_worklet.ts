// URL getter function for main thread import
export function importWorkletUrl(): string {
	return new URL("./audio_offload_worklet.js", import.meta.url).href;
}

export const workletName: string = "audio-offloader";

// Blocks in a row, each wholly in the playback past and too late to absorb by
// raising the delay, after which playback starts over from the stream as it now
// arrives. One such block is only dropped.
const REANCHOR_AFTER_BEHIND_BLOCKS = 3;

// Upper bound of the playout delay when `maxLatency` is not given (ms).
const DEFAULT_MAX_LATENCY_MS = 400;

// Relative-delay histogram: bucket width (ms), the quantile the target delay
// covers, and the time constant (s) over which old arrivals are forgotten.
const DELAY_BUCKET_MS = 10;
const DELAY_QUANTILE = 0.97;
const HISTOGRAM_TIME_CONSTANT_S = 20;

// Fast attack: the largest recent relative delay plus this margin (ms) is
// covered at once; that peak is released with this time constant (s).
const PEAK_MARGIN_MS = 20;
const PEAK_RELEASE_TIME_CONSTANT_S = 10;

// The delay floor (the fastest arrival) is the minimum over the last one to
// two windows of this length (s), so it follows a slowly drifting clock.
const FLOOR_WINDOW_S = 2;

// Target changes smaller than this (ms) are ignored.
const ADJUST_DEADBAND_MS = 5;

// Lowering the delay: at most this much (ms) per step, one step per interval
// (s). A step waits for a silence gap or a quiet stretch to cut, for at most
// the quiet wait (s); after that it cuts with a crossfade.
const SHRINK_STEP_MS = 10;
const SHRINK_INTERVAL_S = 1;
const SHRINK_QUIET_WAIT_S = 2;
const QUIET_LEVEL = 0.001; // -60 dBFS

// Length (ms) of the fades at every edge between audio and silence.
const FADE_MS = 3;

if (typeof AudioWorkletProcessor !== "undefined") {
	// Adaptive, timestamp-scheduled jitter buffer.
	//
	// Each decoded block carries a presentation timestamp (µs) and is written
	// into a ring at the audio frame it is due, so the buffer level does not
	// depend on arrival cadence. `process()` reads by playback frame. Gaps are
	// silence; overlapping blocks overwrite (last writer wins, right for one
	// live source).
	//
	// The playout delay adapts to the observed arrival jitter, after WebRTC's
	// NetEQ. For each block the receiver measures its delay: the playback frame
	// at arrival minus the frame its timestamp maps to. The delay floor is the
	// fastest recent arrival; a block's relative delay is how far it came after
	// that floor. A decaying histogram of relative delays gives the target
	// cushion as a high quantile, and a peak detector raises it at once when a
	// block comes later than any recent one (fast attack). The peak and the
	// histogram forget slowly, so the delay falls back over tens of seconds
	// (slow release). `latency` is the starting and minimum cushion over the
	// floor, `maxLatency` the maximum.
	//
	// The applied delay follows the target by moving the playout mapping:
	// - A block that arrives after its playout frame raises the delay so it
	//   plays instead of being dropped; the reader has already run dry, and
	//   playback resumes with a fade-in.
	// - A higher target otherwise inserts silence at the write head, with a
	//   fade-out before it and a fade-in after it.
	// - A lower target removes audio in small steps, preferring a silence gap
	//   or a quiet stretch, and crossfades the cut.
	// Because the floor tracks the fastest recent arrival, a drift between the
	// sender's and the receiver's audio clocks shows up as a rising or falling
	// floor and is absorbed the same way.
	//
	// When the reader runs out of audio it fades out over a few ms ahead of the
	// end and fades back in when audio resumes, so an underrun is a soft gap.
	//
	// Posting `{ type: "stats", id }` to the port asks for a snapshot of the
	// buffer's state; the processor replies with `{ type: "stats", id, stats }`.
	class AudioOffloadProcessor extends AudioWorkletProcessor {
		#channelsBuffer: Float32Array[] = [];

		// Absolute playback frame counter. Drives the read side; advanced by the
		// output length each `process()` quantum. This is the audio clock.
		#playoutFrame: number = 0;

		// Media-clock origin: the timestamp (µs) of the anchoring block.
		#baseTsUs: number | null = null;

		// Playback frame at which the anchoring block arrived. A block's
		// scheduled frame is this plus its media time since #baseTsUs; its
		// playout frame is that plus #delay.
		#playoutOriginFrame: number = 0;

		// Absolute frame up to which the ring has been written (gaps silence-filled).
		// `null` until the first block establishes #baseTsUs.
		#nextWriteFrame: number | null = null;

		// Applied playout delay (frames) from a block's scheduled frame to its
		// playout frame: the delay floor plus the cushion.
		#delay: number = 0;

		// Bounds of the cushion over the delay floor (frames).
		readonly #minCushion: number = 0;
		readonly #maxCushion: number = 0;

		// Ring size in frames: twice the maximum cushion, allocated once. Slot
		// for absolute frame P is at P % #bufferLength.
		readonly #bufferLength: number = 0;

		readonly #sampleRate: number = 0;
		readonly #fadeFrames: number = 0;

		// Delay floor: the minimum delay over the current and the previous window.
		#floorCurrent: number = 0;
		#floorPrevious: number = 0;
		#floorWindowStart: number = 0;

		// Relative-delay histogram: weight per bucket, summing to 1. It starts
		// with all weight on no jitter, so a few early outliers do not set the
		// target before the stream has shown its jitter.
		readonly #histogram: Float64Array = new Float64Array(0);
		readonly #bucketFrames: number = 1;

		// Largest recent relative delay (frames), decaying.
		#peak: number = 0;

		// Playback frame before which no further lowering step is taken, and
		// the frame since which a step has waited for a quiet place (-1: none).
		#nextShrinkFrame: number = 0;
		#shrinkWaitingSince: number = -1;

		// Output gain envelope for underrun fades, carried across quanta.
		#gain: number = 1;
		#starved: boolean = false;

		// Blocks in a row that arrived wholly in the playback past and could not
		// be absorbed. A run of them means the stream itself fell behind (the
		// sender's audio clock stopped, or delivery stalled).
		#behindBlocks: number = 0;

		// Counters reported in the stats snapshot.
		#receivedBlocks: number = 0;
		#lateBlocks: number = 0;
		#droppedBlocks: number = 0;
		#underruns: number = 0;
		#expands: number = 0;
		#expandedFrames: number = 0;
		#accelerates: number = 0;
		#acceleratedFrames: number = 0;
		#resyncs: number = 0;
		#reanchors: number = 0;

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

			const maxLatency = options.processorOptions.maxLatency ?? DEFAULT_MAX_LATENCY_MS;
			if (typeof maxLatency !== "number" || !(maxLatency > 0)) {
				throw new Error("invalid maxLatency");
			}

			this.#sampleRate = sampleRate;
			this.#minCushion = this.#frames(latency);
			this.#maxCushion = Math.max(this.#minCushion, this.#frames(maxLatency));
			this.#bufferLength = this.#maxCushion * 2;
			this.#delay = this.#minCushion;
			this.#fadeFrames = Math.max(1, this.#frames(FADE_MS));
			this.#bucketFrames = Math.max(1, this.#frames(DELAY_BUCKET_MS));
			this.#histogram = new Float64Array(
				Math.ceil(this.#maxCushion / this.#bucketFrames) + 1,
			);
			this.#histogram[0] = 1;

			for (let i = 0; i < channelCount; i++) {
				this.#channelsBuffer[i] = new Float32Array(this.#bufferLength);
			}

			this.port.onmessage = (
				{ data }: {
					data:
						| { channels: Float32Array[]; timestamp: number }
						| { type: "stats"; id: number };
				},
			) => {
				if ("type" in data) {
					if (data.type === "stats") {
						this.port.postMessage({ type: "stats", id: data.id, stats: this.stats() });
					}
					return;
				}
				this.append(data.channels, data.timestamp);
			};
		}

		#frames(ms: number): number {
			return Math.ceil(this.#sampleRate * ms / 1000);
		}

		#ms(frames: number): number {
			return frames * 1000 / this.#sampleRate;
		}

		// Snapshot of the buffer's state. Delays are cushions over the delay
		// floor, in ms.
		stats() {
			const written = this.#nextWriteFrame ?? this.#playoutFrame;
			return {
				targetDelayMs: this.#ms(this.#targetCushion()),
				delayMs: this.#ms(this.#delay - this.#floor()),
				bufferLevelMs: this.#ms(Math.max(0, written - this.#playoutFrame)),
				receivedBlocks: this.#receivedBlocks,
				lateBlocks: this.#lateBlocks,
				droppedBlocks: this.#droppedBlocks,
				underruns: this.#underruns,
				expands: this.#expands,
				expandedMs: this.#ms(this.#expandedFrames),
				accelerates: this.#accelerates,
				acceleratedMs: this.#ms(this.#acceleratedFrames),
				resyncs: this.#resyncs,
				reanchors: this.#reanchors,
			};
		}

		// Frame a block would play at with no delay: the anchoring block's
		// arrival frame plus the block's media time since it.
		#scheduledFrameForTs(tsUs: number): number {
			const base = this.#baseTsUs ?? 0;
			return this.#playoutOriginFrame +
				Math.round((tsUs - base) * this.#sampleRate / 1_000_000);
		}

		#playoutFrameForTs(tsUs: number): number {
			return this.#scheduledFrameForTs(tsUs) + this.#delay;
		}

		#floor(): number {
			return Math.min(this.#floorCurrent, this.#floorPrevious);
		}

		#resetFloor(delay: number): void {
			this.#floorCurrent = delay;
			this.#floorPrevious = delay;
			this.#floorWindowStart = this.#playoutFrame;
			this.#peak = 0;
		}

		// Cushion over the delay floor that the statistics ask for (frames).
		#targetCushion(): number {
			let quantile = 0;
			let sum = 0;
			for (let i = 0; i < this.#histogram.length; i++) {
				sum += this.#histogram[i]!;
				if (sum >= DELAY_QUANTILE) {
					quantile = (i + 1) * this.#bucketFrames;
					break;
				}
			}
			const peak = this.#peak > 0 ? this.#peak + this.#frames(PEAK_MARGIN_MS) : 0;
			const cushion = Math.round(Math.max(quantile, peak));
			return Math.min(this.#maxCushion, Math.max(this.#minCushion, cushion));
		}

		// Records a block's delay (frames) into the floor, histogram and peak.
		#observe(delay: number, numberOfFrames: number): void {
			if (
				this.#playoutFrame - this.#floorWindowStart >=
					this.#frames(FLOOR_WINDOW_S * 1000)
			) {
				this.#floorPrevious = this.#floorCurrent;
				this.#floorCurrent = delay;
				this.#floorWindowStart = this.#playoutFrame;
			} else if (delay < this.#floorCurrent) {
				this.#floorCurrent = delay;
			}

			const relative = Math.max(0, delay - this.#floor());
			const seconds = numberOfFrames / this.#sampleRate;
			this.#peak *= Math.exp(-seconds / PEAK_RELEASE_TIME_CONSTANT_S);

			// A relative delay beyond the maximum cushion cannot be absorbed: it
			// is a straggler or a stream that fell behind, not jitter to cover.
			if (relative > this.#maxCushion) return;

			const keep = Math.exp(-seconds / HISTOGRAM_TIME_CONSTANT_S);
			for (let i = 0; i < this.#histogram.length; i++) {
				this.#histogram[i] = this.#histogram[i]! * keep;
			}
			const bucket = Math.min(
				this.#histogram.length - 1,
				Math.floor(relative / this.#bucketFrames),
			);
			this.#histogram[bucket] = this.#histogram[bucket]! + (1 - keep);

			if (relative > this.#peak) {
				this.#peak = relative;
			}
		}

		// Makes tsUs the media-clock origin, played one cushion from now. The
		// write head starts at the read pointer so the gap-fill populates the
		// pre-roll region [#playoutFrame, start).
		#anchor(tsUs: number): void {
			this.#baseTsUs = tsUs;
			this.#playoutOriginFrame = this.#playoutFrame;
			this.#nextWriteFrame = this.#playoutFrame;
			this.#behindBlocks = 0;
			this.#resetFloor(0);
			this.#delay = this.#targetCushion();
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

		// Fades out the written frames just before `end`, so the audio ends
		// softly where silence follows. Only frames not yet played are touched.
		#fadeOutBefore(end: number): void {
			const len = this.#bufferLength;
			const fade = this.#fadeFrames;
			const from = Math.max(this.#playoutFrame, end - fade);
			for (const dst of this.#channelsBuffer) {
				if (!dst) continue;
				for (let f = from; f < end; f++) {
					const pos = f % len;
					dst[pos] = dst[pos]! * ((end - f) / (fade + 1));
				}
			}
		}

		// Whether ring frames [from, to) are all below the quiet level.
		#isQuiet(from: number, to: number): boolean {
			const len = this.#bufferLength;
			for (const dst of this.#channelsBuffer) {
				if (!dst) continue;
				for (let f = from; f < to; f++) {
					if (Math.abs(dst[f % len]!) > QUIET_LEVEL) return false;
				}
			}
			return true;
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
			this.#receivedBlocks++;

			// The first block establishes the media-clock origin and anchors the
			// delay to the playback frame at its arrival. Playback starting (or
			// starting over) from a block is not faded in.
			let restart = false;
			if (this.#baseTsUs === null) {
				this.#anchor(tsUs);
				restart = true;
			}

			let start = this.#playoutFrameForTs(tsUs);

			// Resync to the live edge: a block more than one cushion ahead of the
			// cushion means playback has fallen behind the media (a catch-up burst
			// after a slow spell). The backlog is stale for a live stream: advance
			// the read pointer so this block lands one cushion ahead, and measure
			// delays from here on.
			const cushion = Math.max(this.#minCushion, this.#delay - this.#floor());
			if (start - this.#playoutFrame >= 2 * cushion) {
				this.#playoutFrame = start - this.#targetCushion();
				this.#nextWriteFrame = this.#playoutFrame;
				this.#resetFloor(this.#playoutFrame - this.#scheduledFrameForTs(tsUs));
				this.#delay = this.#floor() + this.#targetCushion();
				start = this.#playoutFrameForTs(tsUs);
				this.#resyncs++;
				restart = true;
			}

			this.#observe(this.#playoutFrame - this.#scheduledFrameForTs(tsUs), numberOfFrames);
			const target = this.#floor() + this.#targetCushion();
			const deadband = this.#frames(ADJUST_DEADBAND_MS);

			// Frames at the head of this block to crossfade with the audio
			// already in the ring, where a lowering step cut into it.
			let crossfade = 0;

			if (start < this.#playoutFrame) {
				// Late: raise the delay so the block plays rather than being
				// dropped, if the target covers it.
				if (target - this.#delay >= this.#playoutFrame - start) {
					this.#delay = target;
					start = this.#playoutFrameForTs(tsUs);
					this.#lateBlocks++;
				}
			} else if (target > this.#delay + deadband) {
				// Raise: the gap this opens before the block is silence-filled
				// below, with fades on both sides.
				const raise = target - this.#delay;
				this.#delay = target;
				start += raise;
				this.#expands++;
				this.#expandedFrames += raise;
			} else if (target < this.#delay - deadband) {
				if (this.#playoutFrame >= this.#nextShrinkFrame) {
					crossfade = this.#lower(target, start, numberOfFrames);
					start = this.#playoutFrameForTs(tsUs);
				}
			} else {
				this.#shrinkWaitingSince = -1;
			}

			// Stale (late) block: its whole range is already in the playback past
			// and raising the delay could not save it. Drop it rather than clobber
			// current playback. A run of them means the stream fell behind for
			// good: every later block would be dropped too, so start over from
			// this block, as for the first one.
			if (start + numberOfFrames <= this.#playoutFrame) {
				this.#behindBlocks++;
				if (this.#behindBlocks < REANCHOR_AFTER_BEHIND_BLOCKS) {
					this.#droppedBlocks++;
					return;
				}
				this.#anchor(tsUs);
				start = this.#playoutFrameForTs(tsUs);
				this.#reanchors++;
				restart = true;
			}
			this.#behindBlocks = 0;
			const end = start + numberOfFrames;

			// Partially-late block (start < #playoutFrame < end): discard the
			// already-played prefix, so the ring write never targets past slots
			// (which would alias future reads on wrap).
			let srcOffset0 = 0;
			if (start < this.#playoutFrame) {
				srcOffset0 = this.#playoutFrame - start;
				start = this.#playoutFrame;
			}

			// Never write more than one ring ahead of the read pointer, or the
			// ring would wrap over not-yet-played data.
			let writeEnd = end;
			if (writeEnd > this.#playoutFrame + this.#bufferLength) {
				writeEnd = this.#playoutFrame + this.#bufferLength;
			}

			// A block scheduled after the write head follows silence: a gap, or
			// an underrun the reader has already run into. Fade it in, and fade
			// out the unplayed audio before the gap, so neither edge clicks.
			const head = this.#nextWriteFrame ?? start;
			let fadeIn = 0;
			if (start > head) {
				if (head > this.#playoutFrame) {
					this.#fadeOutBefore(head);
				}
				this.#silenceFill(Math.max(head, this.#playoutFrame), start);
				if (!restart) fadeIn = this.#fadeFrames;
			}

			const len = this.#bufferLength;
			const writeLen = Math.max(0, writeEnd - start);
			const shaped = Math.min(writeLen, Math.max(crossfade, fadeIn));

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

				// Head frames: crossfaded with the ring's audio, or faded in.
				for (let i = 0; i < shaped; i++) {
					const pos = (start + i) % len;
					const sample = src[srcOffset0 + i]!;
					if (crossfade > 0) {
						const g = (i + 1) / (crossfade + 1);
						dst[pos] = dst[pos]! * (1 - g) + sample * g;
					} else {
						dst[pos] = sample * ((i + 1) / (fadeIn + 1));
					}
				}

				let writePos = (start + shaped) % len;
				let srcOffset = shaped;
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

		// Takes one lowering step towards `target` for a block due at `start`,
		// playing it earlier. When there is no silence gap before it to take the
		// step from, the step cuts the end of the audio already written: it
		// waits for that stretch to be quiet, up to the quiet wait. Returns the
		// number of head frames to crossfade with the ring.
		#lower(target: number, start: number, numberOfFrames: number): number {
			const floor = Math.max(this.#nextWriteFrame ?? start, this.#playoutFrame);
			const step = Math.min(
				this.#delay - target,
				this.#frames(SHRINK_STEP_MS),
				start - this.#playoutFrame,
				Math.max(0, start - floor) + numberOfFrames,
			);
			if (step <= 0) return 0;

			const newStart = start - step;
			const cut = Math.max(0, floor - newStart);
			if (this.#shrinkWaitingSince < 0) {
				this.#shrinkWaitingSince = this.#playoutFrame;
			}
			const waited = this.#playoutFrame - this.#shrinkWaitingSince >=
				this.#frames(SHRINK_QUIET_WAIT_S * 1000);
			if (cut > 0 && !waited && !this.#isQuiet(newStart, floor)) return 0;

			this.#delay -= step;
			this.#accelerates++;
			this.#acceleratedFrames += step;
			this.#nextShrinkFrame = this.#playoutFrame + this.#frames(SHRINK_INTERVAL_S * 1000);
			this.#shrinkWaitingSince = -1;
			return Math.min(cut, this.#fadeFrames);
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
			const fade = this.#fadeFrames;
			const playout = this.#playoutFrame;

			// How much real (written) data is available in this quantum. Slots beyond
			// #nextWriteFrame haven't been written yet → silence (startup pre-roll or
			// underrun). No base timestamp yet → nothing written → all silence.
			const written = this.#nextWriteFrame ?? playout;
			const realEnd = Math.min(playout + outputLength, written);
			const realFrames = Math.max(0, realEnd - playout);

			// Gain envelope: it falls as the read nears the end of the written
			// audio (a fade-out ahead of an underrun) and rises by at most 1/fade
			// per frame (a fade-in after one). At unity with audio well ahead the
			// output is a plain copy.
			const gain0 = this.#gain;
			const shaped = gain0 < 1 || written - playout < outputLength + fade;
			let gainEnd = gain0;

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
					let readPos = playout % len;
					let dstOffset = 0;
					while (dstOffset < realFrames) {
						const remaining = realFrames - dstOffset;
						const availableToEnd = len - readPos;
						const toCopy = Math.min(remaining, availableToEnd);
						dst.set(src.subarray(readPos, readPos + toCopy), dstOffset);
						dstOffset += toCopy;
						readPos = (readPos + toCopy) % len;
					}

					if (shaped) {
						let g = gain0;
						for (let i = 0; i < realFrames; i++) {
							const ahead = (written - playout - i) / (fade + 1);
							g = Math.min(ahead, g + 1 / fade, 1);
							dst[i] = dst[i]! * g;
						}
						gainEnd = g;
					}

					// Fill the rest of the quantum with silence.
					if (dstOffset < dst.length) {
						dst.fill(0, dstOffset);
					}
				}
			}

			if (realFrames < outputLength) {
				if (!this.#starved && this.#baseTsUs !== null) {
					this.#underruns++;
				}
				this.#starved = true;
				this.#gain = 0;
			} else {
				this.#starved = false;
				this.#gain = gainEnd;
			}

			// Advance the playback clock.
			this.#playoutFrame += outputLength;

			return true;
		}
	}

	registerProcessor(workletName, AudioOffloadProcessor);
}

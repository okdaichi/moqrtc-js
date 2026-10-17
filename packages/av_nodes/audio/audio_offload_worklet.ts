import {
	DEFAULT_MAX_LATENCY_MS,
	isAudioOffloadMessage,
	type StatsReply,
} from "./audio_offload_protocol.ts";
import type { AudioPlayoutStats } from "./audio_playback_stats.ts";
import { OFFLOAD_PROCESSOR_NAME } from "./audio_worklet_protocol.ts";
import { DelayEstimator } from "./delay_estimator.ts";

// URL getter function for main thread import
export function importWorkletUrl(): string {
	return new URL("./audio_offload_worklet.js", import.meta.url).href;
}

// Blocks in a row, each wholly in the playback past and too late to absorb by
// raising the delay, after which playback starts over from the stream as it now
// arrives. One such block is only dropped.
const REANCHOR_AFTER_BEHIND_BLOCKS = 3;

// Target changes smaller than this (ms) are ignored.
const ADJUST_DEADBAND_MS = 5;

// Lowering the delay: a step of at most this much (ms) is taken once the delay
// has waited to be lowered for the step interval (s), at a silence gap or a
// quiet stretch. With neither, it cuts with a crossfade once the wait reaches
// the quiet wait (s). So the delay falls by 10 ms per second where there are
// pauses, and by 10 ms per two seconds through continuous sound.
const SHRINK_STEP_MS = 10;
const SHRINK_INTERVAL_S = 1;
const SHRINK_QUIET_WAIT_S = 2;
const QUIET_LEVEL = 0.001; // -60 dBFS

// Length (ms) of the fades at every edge between audio and silence.
const FADE_MS = 3;

// Longest crossfade (ms) where a lowering step cuts into audio. Longer than a
// fade, as both sides are sound and a short crossfade between them clicks.
const CUT_CROSSFADE_MS = 10;

// A positive, finite number.
function isPositive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// The processor options a node can get wrong.
type ProcessorOption =
	| "processorOptions"
	| "channelCount"
	| "sampleRate"
	| "latency"
	| "maxLatency";

// A processor option missing or out of range. The node sees it as a
// processorerror event.
class ProcessorOptionError extends RangeError {
	readonly option: ProcessorOption;

	constructor(option: ProcessorOption) {
		super(`invalid ${option}`);
		this.name = "ProcessorOptionError";
		this.option = option;
	}
}

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
	// NetEQ: a DelayEstimator turns each block's arrival delay into a target
	// cushion over the fastest recent arrival (the delay floor), raising it at
	// once for a late block and lowering it slowly. `latency` is the starting
	// and minimum cushion, `maxLatency` the maximum; equal, they fix the delay.
	//
	// The applied delay follows the target by moving the playout mapping:
	// - A block that arrives after its playout frame raises the delay so it
	//   plays instead of being dropped; the reader has already run dry, and
	//   playback resumes with a fade-in.
	// - A higher target otherwise inserts silence at the write head, with a
	//   fade-out before it and a fade-in after it.
	// - A lower target removes audio in small steps, preferring a silence gap
	//   or a quiet stretch, and crossfades the cut (longer where it cuts sound).
	// - A block more than one cushion ahead of the cushion, or beyond the ring,
	//   moves the reader to the live edge; the audio it was playing fades out.
	// - Until the reader reaches the stream's first block, blocks whose
	//   timestamps span more than the cushion (a backlog, such as the start of
	//   a stream joined mid-way, however the decoder spreads it over render
	//   quanta) move the reader so the newest lands one cushion ahead; the
	//   older audio is skipped, and playback fades in from the audio kept. Until
	//   the reader reaches that newest block, the rest of the backlog is
	//   skipped the same way, fading out the audio it was playing.
	// Because the floor tracks the fastest recent arrival, a drift between the
	// sender's and the receiver's audio clocks shows up as a rising or falling
	// floor and is absorbed the same way.
	//
	// When the reader runs out of audio it fades out over a few ms ahead of the
	// end and fades back in when audio resumes, so an underrun is a soft gap.
	//
	// Messages are an AudioOffloadMessage: `append` plays a block, `stats`
	// asks for a snapshot, answered with a StatsReply of the same id. Anything
	// else is ignored.
	class AudioOffloadProcessor extends AudioWorkletProcessor {
		readonly #channelsBuffer: Float32Array[] = [];

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

		readonly #minCushion: number;
		readonly #adaptive: boolean;
		readonly #estimator: DelayEstimator;

		// Ring size in frames: twice the maximum cushion, allocated once. Slot
		// for absolute frame P is at P % #bufferLength.
		readonly #bufferLength: number;

		readonly #sampleRate: number;
		readonly #fadeFrames: number;
		readonly #cutCrossfadeFrames: number;

		// Ring frame up to which a backlog may still be skipped: the start of
		// the anchoring block, or of the newest block a skip placed; null once
		// the reader has reached it. And whether a backlog was skipped since
		// the stream was anchored.
		#prerollEnd: number | null = null;
		#skippedBacklog: boolean = false;

		// Playback frame since which the delay has waited to be lowered: when the
		// target fell below it, or the last lowering step. Null while the target
		// does not ask for a lower delay.
		#shrinkWaitingSince: number | null = null;

		// Fade-out of the audio that was playing when the reader jumped to the
		// live edge (per channel, allocated once), and how many of its frames are
		// still to be mixed into the output.
		readonly #resyncTail: Float32Array[] = [];
		#resyncTailFrames: number = 0;

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

		// Set by a stop message: process() then returns false, so the
		// processor can be collected.
		#stopped = false;

		constructor(options: AudioWorkletNodeOptions) {
			super();
			if (!options.processorOptions) {
				throw new ProcessorOptionError("processorOptions");
			}

			const channelCount = options.channelCount;
			if (!channelCount || channelCount <= 0) {
				throw new ProcessorOptionError("channelCount");
			}

			const sampleRate: unknown = options.processorOptions.sampleRate;
			if (!isPositive(sampleRate)) {
				throw new ProcessorOptionError("sampleRate");
			}

			const latency: unknown = options.processorOptions.latency;
			if (!isPositive(latency)) {
				throw new ProcessorOptionError("latency");
			}

			const maxLatency: unknown = options.processorOptions.maxLatency ??
				Math.max(DEFAULT_MAX_LATENCY_MS, latency);
			if (!isPositive(maxLatency) || maxLatency < latency) {
				throw new ProcessorOptionError("maxLatency");
			}

			this.#sampleRate = sampleRate;
			this.#minCushion = this.#frames(latency);
			// At least #minCushion, as maxLatency is at least latency.
			const maxCushion = this.#frames(maxLatency);
			this.#adaptive = maxCushion > this.#minCushion;
			this.#estimator = new DelayEstimator({
				sampleRate,
				minCushion: this.#minCushion,
				maxCushion,
			});
			this.#bufferLength = maxCushion * 2;
			this.#delay = this.#minCushion;
			this.#fadeFrames = Math.max(1, this.#frames(FADE_MS));
			this.#cutCrossfadeFrames = Math.max(this.#fadeFrames, this.#frames(CUT_CROSSFADE_MS));

			for (let i = 0; i < channelCount; i++) {
				this.#channelsBuffer[i] = new Float32Array(this.#bufferLength);
				this.#resyncTail[i] = new Float32Array(this.#fadeFrames);
			}

			this.port.onmessage = (event: MessageEvent<unknown>) => {
				const message = event.data;
				if (!isAudioOffloadMessage(message)) return;
				switch (message.type) {
					case "append":
						this.append(message.channels, message.timestamp);
						return;
					case "stats": {
						const reply: StatsReply = {
							type: "stats",
							id: message.id,
							stats: this.stats(),
						};
						this.port.postMessage(reply);
						return;
					}
					case "stop":
						this.#stopped = true;
						this.port.close();
						return;
					default: {
						const unhandled: never = message;
						return unhandled;
					}
				}
			};
		}

		#frames(ms: number): number {
			return Math.ceil(this.#sampleRate * ms / 1000);
		}

		#ms(frames: number): number {
			return frames * 1000 / this.#sampleRate;
		}

		// Snapshot of the buffer's state.
		stats(): AudioPlayoutStats {
			const written = this.#nextWriteFrame ?? this.#playoutFrame;
			return {
				targetDelayMs: this.#ms(this.#estimator.targetCushion()),
				delayMs: this.#ms(this.#delay - this.#estimator.floor()),
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

		// Makes tsUs the media-clock origin, played one cushion from now. The
		// write head starts at the read pointer so the gap-fill populates the
		// pre-roll region [#playoutFrame, start).
		#anchor(tsUs: number): void {
			this.#baseTsUs = tsUs;
			this.#playoutOriginFrame = this.#playoutFrame;
			this.#nextWriteFrame = this.#playoutFrame;
			this.#behindBlocks = 0;
			this.#estimator.reset(0, this.#playoutFrame);
			this.#delay = this.#estimator.targetCushion();
			// The anchoring block plays one delay from now.
			this.#prerollEnd = this.#playoutFrame + this.#delay;
			this.#skippedBacklog = false;
		}

		// Whether a block due `lead` frames from now is part of a backlog to
		// skip: before the reader reaches the stream's first block, once blocks
		// span more than the cushion (the span at which a resync would move the
		// reader anyway), and then until it reaches the newest block skipped to.
		#isBacklog(lead: number, cushion: number): boolean {
			if (this.#prerollEnd === null || lead <= cushion) return false;
			return this.#skippedBacklog || lead >= 2 * cushion;
		}

		// Moves the reader so a block due at `start` lands one cushion ahead,
		// keeping the audio already written after the new read position and
		// fading in from it. Audio of an earlier skip the reader was playing
		// fades out, unless a resync's fade-out is still under way.
		#skipBacklog(tsUs: number, start: number, cushion: number): void {
			const written = this.#nextWriteFrame ?? this.#playoutFrame;
			if (this.#resyncTailFrames === 0) this.#keepResyncTail();
			this.#playoutFrame = start - cushion;
			this.#nextWriteFrame = Math.max(written, this.#playoutFrame);
			this.#prerollEnd = start;
			this.#estimator.reset(
				this.#playoutFrame - this.#scheduledFrameForTs(tsUs),
				this.#playoutFrame,
			);
			this.#delay = this.#estimator.floor() + cushion;
			this.#gain = 0;
			if (!this.#skippedBacklog) this.#resyncs++;
			this.#skippedBacklog = true;
		}

		// Zero-fill `count` ring slots of one channel from absolute frame `from`
		// (wrap-aware).
		#zero(dst: Float32Array, from: number, count: number): void {
			const len = this.#bufferLength;
			let pos = from % len;
			let remaining = count;
			while (remaining > 0) {
				const toFill = Math.min(remaining, len - pos);
				dst.fill(0, pos, pos + toFill);
				pos = (pos + toFill) % len;
				remaining -= toFill;
			}
		}

		// Zero-fill ring slots [from, to) on every channel.
		#silenceFill(from: number, to: number): void {
			for (const dst of this.#channelsBuffer) {
				this.#zero(dst, from, to - from);
			}
		}

		// Keeps the next fade of audio the reader would have played, faded out,
		// to mix into the output after it jumps.
		#keepResyncTail(): void {
			const len = this.#bufferLength;
			const fade = this.#fadeFrames;
			const written = this.#nextWriteFrame ?? this.#playoutFrame;
			for (let channel = 0; channel < this.#channelsBuffer.length; channel++) {
				const src = this.#channelsBuffer[channel];
				const tail = this.#resyncTail[channel];
				if (!src || !tail) continue;
				for (let i = 0; i < fade; i++) {
					const frame = this.#playoutFrame + i;
					const sample = frame < written ? (src[frame % len] ?? 0) : 0;
					tail[i] = sample * this.#gain * ((fade - i) / (fade + 1));
				}
			}
			this.#resyncTailFrames = fade;
		}

		// Fades out the written frames just before `end`, so the audio ends
		// softly where silence follows. Only frames not yet played are touched.
		#fadeOutBefore(end: number): void {
			const len = this.#bufferLength;
			const fade = this.#fadeFrames;
			const from = Math.max(this.#playoutFrame, end - fade);
			for (const dst of this.#channelsBuffer) {
				for (let f = from; f < end; f++) {
					const pos = f % len;
					dst[pos] = (dst[pos] ?? 0) * ((end - f) / (fade + 1));
				}
			}
		}

		// Whether ring frames [from, to) are all below the quiet level.
		#isQuiet(from: number, to: number): boolean {
			const len = this.#bufferLength;
			for (const dst of this.#channelsBuffer) {
				for (let f = from; f < to; f++) {
					if (Math.abs(dst[f % len] ?? 0) > QUIET_LEVEL) return false;
				}
			}
			return true;
		}

		append(channels: readonly Float32Array[], tsUs: number): void {
			const first = channels[0];
			if (!first || first.length === 0) {
				return;
			}

			const numberOfFrames = first.length;
			this.#receivedBlocks++;

			// The first block establishes the media-clock origin and anchors the
			// delay to the playback frame at its arrival. Playback starting from
			// it, after silence, is not faded in.
			const restart = this.#baseTsUs === null;
			if (restart) this.#anchor(tsUs);

			let start = this.#playoutFrameForTs(tsUs);

			const target = this.#estimator.targetCushion();
			if (this.#isBacklog(start - this.#playoutFrame, target)) {
				this.#skipBacklog(tsUs, start, target);
				start = this.#playoutFrameForTs(tsUs);
			}

			// Resync to the live edge: a block more than one cushion ahead of the
			// cushion means playback has fallen behind the media (a catch-up burst
			// after a slow spell), and a block reaching past the ring cannot be
			// written at all. The backlog is stale for a live stream: advance the
			// read pointer so this block lands one cushion ahead, fading out the
			// audio it was playing, and measure delays from here on.
			const cushion = Math.max(this.#minCushion, this.#delay - this.#estimator.floor());
			if (
				start - this.#playoutFrame >= 2 * cushion ||
				start + numberOfFrames > this.#playoutFrame + this.#bufferLength
			) {
				this.#keepResyncTail();
				this.#playoutFrame = Math.max(this.#playoutFrame, start - target);
				this.#nextWriteFrame = this.#playoutFrame;
				this.#estimator.reset(
					this.#playoutFrame - this.#scheduledFrameForTs(tsUs),
					this.#playoutFrame,
				);
				this.#delay = this.#estimator.floor() + target;
				start = this.#playoutFrameForTs(tsUs);
				this.#resyncs++;
			}

			this.#estimator.observe(
				this.#playoutFrame - this.#scheduledFrameForTs(tsUs),
				numberOfFrames,
				this.#playoutFrame,
			);

			// Frames at the head of this block to crossfade with the audio
			// already in the ring, where a lowering step cut into it.
			const crossfade = this.#adaptive ? this.#adjust(start, numberOfFrames) : 0;
			start = this.#playoutFrameForTs(tsUs);

			// Stale (late) block: its whole range is already in the playback past
			// and raising the delay could not save it. Drop it rather than clobber
			// current playback. A run of them means the stream fell behind for
			// good: every later block would be dropped too, so start over from
			// this block, as for the first one, fading out the audio it was
			// playing and fading this block in, as for a resync.
			if (start + numberOfFrames <= this.#playoutFrame) {
				this.#behindBlocks++;
				if (this.#behindBlocks < REANCHOR_AFTER_BEHIND_BLOCKS) {
					this.#droppedBlocks++;
					return;
				}
				this.#keepResyncTail();
				this.#anchor(tsUs);
				start = this.#playoutFrameForTs(tsUs);
				this.#reanchors++;
			}
			this.#behindBlocks = 0;
			const end = start + numberOfFrames;

			// Partially-late block (start < #playoutFrame < end): discard the
			// already-played prefix, so the ring write never targets past slots
			// (which would alias future reads on wrap).
			const srcOffset0 = Math.max(0, this.#playoutFrame - start);
			start = Math.max(start, this.#playoutFrame);

			// Never write more than one ring ahead of the read pointer, or the
			// ring would wrap over not-yet-played data.
			const writeEnd = Math.min(end, this.#playoutFrame + this.#bufferLength);

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
					this.#zero(dst, start, writeLen);
					continue;
				}

				// Head frames: crossfaded with the ring's audio, or faded in. A
				// source channel shorter than the first reads as silence.
				for (let i = 0; i < shaped; i++) {
					const pos = (start + i) % len;
					const sample = src[srcOffset0 + i] ?? 0;
					if (crossfade > 0) {
						const g = (i + 1) / (crossfade + 1);
						dst[pos] = (dst[pos] ?? 0) * (1 - g) + sample * g;
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

		// Moves the applied delay towards the target for a block due at
		// `start`. Returns the number of head frames to crossfade with the ring.
		#adjust(start: number, numberOfFrames: number): number {
			const target = this.#estimator.floor() + this.#estimator.targetCushion();
			const deadband = this.#frames(ADJUST_DEADBAND_MS);

			if (target < this.#delay - deadband && start >= this.#playoutFrame) {
				return this.#lower(target, start, numberOfFrames);
			}
			this.#shrinkWaitingSince = null;

			if (start < this.#playoutFrame) {
				// Late: raise the delay so the block plays rather than being
				// dropped, if the target covers it and the reader has run dry at
				// it. With a later block already written it arrived out of order,
				// and moving the playout would play it after that block.
				const written = this.#nextWriteFrame ?? start;
				if (
					target - this.#delay >= this.#playoutFrame - start &&
					written <= start + numberOfFrames
				) {
					this.#delay = target;
					this.#lateBlocks++;
				}
			} else if (target > this.#delay + deadband) {
				// Raise: the gap this opens before the block is silence-filled,
				// with fades on both sides.
				this.#expands++;
				this.#expandedFrames += target - this.#delay;
				this.#delay = target;
			}
			return 0;
		}

		// Takes one lowering step towards `target` for a block due at `start`,
		// playing it earlier, once the delay has waited the step interval. When
		// there is no silence gap before the block to take the step from, the
		// step cuts the end of the audio already written: it waits for that
		// stretch to be quiet, up to the quiet wait. Returns the number of head
		// frames to crossfade with the ring.
		#lower(target: number, start: number, numberOfFrames: number): number {
			const waitingSince = this.#shrinkWaitingSince ?? this.#playoutFrame;
			this.#shrinkWaitingSince = waitingSince;
			const waited = this.#playoutFrame - waitingSince;
			if (waited < this.#frames(SHRINK_INTERVAL_S * 1000)) return 0;

			// The moved block must still reach the end of the written audio, so no
			// audio from before the step is left playing after it.
			const floor = Math.max(this.#nextWriteFrame ?? start, this.#playoutFrame);
			const step = Math.min(
				this.#delay - target,
				this.#frames(SHRINK_STEP_MS),
				start - this.#playoutFrame,
				start + numberOfFrames - floor,
			);
			if (step <= 0) return 0;

			const newStart = start - step;
			const cut = Math.max(0, floor - newStart);
			const quiet = cut === 0 || this.#isQuiet(newStart, floor);
			const forced = waited >= this.#frames(SHRINK_QUIET_WAIT_S * 1000);
			if (!quiet && !forced) return 0;

			this.#delay -= step;
			this.#accelerates++;
			this.#acceleratedFrames += step;
			this.#shrinkWaitingSince = this.#playoutFrame;
			return Math.min(cut, quiet ? this.#fadeFrames : this.#cutCrossfadeFrames);
		}

		// Adds what is left of the resync fade-out to the start of a quantum.
		#mixResyncTail(channel: number, dst: Float32Array): void {
			const tail = this.#resyncTail[channel];
			if (this.#resyncTailFrames === 0 || !tail) return;
			const from = tail.length - this.#resyncTailFrames;
			const frames = Math.min(this.#resyncTailFrames, dst.length);
			for (let i = 0; i < frames; i++) {
				dst[i] = (dst[i] ?? 0) + (tail[from + i] ?? 0);
			}
		}

		process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
			if (this.#stopped) return false;

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
						this.#mixResyncTail(channel, dst);
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
							dst[i] = (dst[i] ?? 0) * g;
						}
						gainEnd = g;
					}

					// Fill the rest of the quantum with silence.
					if (dstOffset < dst.length) {
						dst.fill(0, dstOffset);
					}
					this.#mixResyncTail(channel, dst);
				}
			}
			this.#resyncTailFrames = Math.max(0, this.#resyncTailFrames - outputLength);

			if (this.#prerollEnd !== null && playout + realFrames > this.#prerollEnd) {
				this.#prerollEnd = null;
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

	try {
		registerProcessor(OFFLOAD_PROCESSOR_NAME, AudioOffloadProcessor);
	} catch (e) {
		// reason: the module was evaluated again in this scope (another copy of
		// the same version loaded it); the identical processor registered first
		// stays in use.
		if (!(e instanceof DOMException && e.name === "NotSupportedError")) throw e;
	}
}

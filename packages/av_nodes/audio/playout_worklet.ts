import {
	DEFAULT_MAX_LATENCY_MS,
	isAudioPlayoutMessage,
	type StatsReply,
} from "./playout_protocol.ts";
import type { AudioPlayoutStats } from "./audio_playback_stats.ts";
import { PLAYOUT_PROCESSOR_NAME } from "./audio_worklet_names.ts";
import { DelayEstimator } from "./delay_estimator.ts";
import { insertSegment, removeSegment, TimeStretcher } from "./time_stretch.ts";

// URL getter function for main thread import
export function importWorkletUrl(): string {
	return new URL("./playout_worklet.js", import.meta.url).href;
}

// Blocks in a row, each wholly in the playback past and too late to absorb by
// raising the delay, after which playback starts over from the stream as it now
// arrives. One such block is only dropped.
const REANCHOR_AFTER_BEHIND_BLOCKS = 3;

// A target higher than the delay by less than this (ms) is ignored.
const ADJUST_DEADBAND_MS = 5;

// Lowering the delay: once the target has stayed more than the margin (ms)
// below the delay for the sustain time (s), one step of up to 15 ms is taken
// per interval (ms) while it stays there: a cut where the audio is quiet or
// a silence gap, or, once a step has waited the quiet wait (ms) for one, the
// removal of a pitch period (see time_stretch.ts). The sustain time keeps a
// target that dips between delay spikes from cutting audio only to raise the
// delay again at the next spike; the interval keeps the speed-up at 3% or
// less where there are pauses and 1.5% through continuous sound, too little
// to hear.
const LOWER_MARGIN_MS = 10;
const LOWER_SUSTAIN_S = 4;
const LOWER_INTERVAL_MS = 500;
const LOWER_QUIET_WAIT_MS = 500;

// Below this level (-60 dBFS) audio is quiet.
const QUIET_LEVEL = 0.001;

// Length (ms) of the fades at every edge between audio and silence.
const FADE_MS = 3;

// Concealment of missing audio: when the reader is about to run out, the last
// period of the audio is repeated, at full level for the hold time (ms) and
// then fading to silence over the fade time (ms), so a short gap in delivery
// is bridged and a long one ends softly. The concealed audio raises the delay
// by its length, as a late block would.
const CONCEAL_HOLD_MS = 30;
const CONCEAL_FADE_MS = 30;

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
	// The applied delay follows the target by moving the playout mapping, with
	// time-scale modification (WSOLA, see time_stretch.ts) wherever it changes
	// the delay inside sound:
	// - When the reader is about to run out of audio, the last period of the
	//   audio is repeated with an overlap-add (concealment), fading to silence
	//   after 30 ms; it raises the delay by its length. The next block
	//   crossfades from the concealed audio.
	// - A block that arrives after its playout frame raises the delay so it
	//   plays instead of being dropped; the reader has already run dry, and
	//   playback resumes with a fade-in.
	// - A higher target otherwise repeats one correlated segment at the write
	//   head per block or, after a silence gap or with the reader caught up,
	//   widens the gap at once.
	// - A target that stays well below the delay for seconds lowers it in
	//   steps, preferring a silence gap or a quiet stretch to cut, and
	//   otherwise removing a correlated segment before the write head with an
	//   overlap-add.
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
	// With a fixed delay nothing is concealed, as concealment moves the delay.
	//
	// Messages are an AudioPlayoutMessage: `append` plays a block, `stats`
	// asks for a snapshot, answered with a StatsReply of the same id. Anything
	// else is ignored.
	class PlayoutProcessor extends AudioWorkletProcessor {
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
		readonly #deadbandFrames: number;
		readonly #lowerMarginFrames: number;
		readonly #lowerSustainFrames: number;
		readonly #lowerIntervalFrames: number;
		readonly #lowerQuietWaitFrames: number;
		readonly #concealHoldFrames: number;
		readonly #concealFrames: number;
		readonly #stretcher: TimeStretcher;

		// Frame at which the audio written up to #nextWriteFrame began without
		// a gap: segments are only searched and repeated within it.
		#runStart: number = 0;

		// Ring frame up to which a backlog may still be skipped: the start of
		// the anchoring block, or of the newest block a skip placed; null once
		// the reader has reached it. And whether a backlog was skipped since
		// the stream was anchored.
		#prerollEnd: number | null = null;
		#skippedBacklog: boolean = false;

		// Playback frame since which the target has stayed well below the
		// delay, null while it does not; and that of the last lowering step.
		#lowerWaitingSince: number | null = null;
		#lastLowerFrame: number | null = null;

		// Concealment: the period repeated (0 when not concealing), how many
		// frames have been concealed, and the period's audio per channel
		// (allocated once).
		#concealLag: number = 0;
		#concealedFrames: number = 0;
		readonly #concealPeriod: Float32Array[] = [];

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
			this.#deadbandFrames = this.#frames(ADJUST_DEADBAND_MS);
			this.#lowerMarginFrames = this.#frames(LOWER_MARGIN_MS);
			this.#lowerSustainFrames = this.#frames(LOWER_SUSTAIN_S * 1000);
			this.#lowerIntervalFrames = this.#frames(LOWER_INTERVAL_MS);
			this.#lowerQuietWaitFrames = this.#frames(LOWER_QUIET_WAIT_MS);
			this.#concealHoldFrames = this.#frames(CONCEAL_HOLD_MS);
			this.#concealFrames = this.#concealHoldFrames + this.#frames(CONCEAL_FADE_MS);
			this.#stretcher = new TimeStretcher(sampleRate);

			for (let i = 0; i < channelCount; i++) {
				this.#channelsBuffer[i] = new Float32Array(this.#bufferLength);
				this.#resyncTail[i] = new Float32Array(this.#fadeFrames);
				this.#concealPeriod[i] = new Float32Array(this.#stretcher.maxLag);
			}

			this.port.onmessage = (event: MessageEvent<unknown>) => {
				const message = event.data;
				if (!isAudioPlayoutMessage(message)) return;
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

			if (this.#adaptive) this.#adjust(start, numberOfFrames);
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
			// A block following concealed audio crossfades from its
			// continuation instead.
			const head = this.#nextWriteFrame ?? start;
			const writeLen = Math.max(0, writeEnd - start);
			let fadeIn = 0;
			let crossfade = 0;
			if (start > head) {
				if (head > this.#playoutFrame) {
					this.#fadeOutBefore(head);
				}
				this.#silenceFill(Math.max(head, this.#playoutFrame), start);
				if (!restart) fadeIn = this.#fadeFrames;
				this.#runStart = start;
			} else if (this.#concealLag > 0) {
				crossfade = Math.min(this.#stretcher.overlap, writeLen);
				this.#synthesize(Math.max(0, start + crossfade - head));
			}
			this.#concealLag = 0;
			this.#concealedFrames = 0;

			const len = this.#bufferLength;
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
			if (this.#adaptive) this.#lowerIfDue();
		}

		// The absolute delay the statistics ask for.
		#targetDelay(): number {
			return this.#estimator.floor() + this.#estimator.targetCushion();
		}

		// Raises the applied delay towards the target for a block due at
		// `start`, and notes whether the target asks for a lower delay. A due
		// lowering step for a block after a silence gap shortens the gap.
		#adjust(start: number, numberOfFrames: number): void {
			const target = this.#targetDelay();
			if (target < this.#delay - this.#lowerMarginFrames) {
				this.#lowerWaitingSince ??= this.#playoutFrame;
			} else {
				this.#lowerWaitingSince = null;
			}

			const head = this.#nextWriteFrame ?? start;
			const due = this.#lowerDueFrom();
			if (due !== null && due <= this.#playoutFrame && start > head) {
				const gap = start - Math.max(head, this.#playoutFrame);
				const step = Math.min(this.#delay - target, gap);
				if (step > 0) this.#lowered(step);
				return;
			}

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
				return;
			}
			if (target <= this.#delay + this.#deadbandFrames) return;

			// Raise. A block that follows the written audio directly gets one
			// repeated segment before it; one after a silence gap, or with the
			// reader caught up, widens the gap at once, with fades on both sides.
			if (start === head && this.#expandAt(head, target - this.#delay)) return;
			this.#expands++;
			this.#expandedFrames += target - this.#delay;
			this.#delay = target;
		}

		// Repeats one segment of up to `room` frames of the audio ending at
		// `end`, the write head, raising the delay by its length. Returns
		// whether there was enough unplayed audio and history to do so.
		#expandAt(end: number, room: number): boolean {
			const stretcher = this.#stretcher;
			const reference = this.#channelsBuffer[0];
			const overlap = Math.min(stretcher.overlap, end - this.#playoutFrame);
			const maxLag = Math.min(
				stretcher.maxLag,
				room,
				end - overlap - this.#runStart,
				this.#playoutFrame + this.#bufferLength - end,
			);
			if (!reference || overlap < this.#fadeFrames || maxLag < stretcher.minLag) return false;

			const lag = stretcher.findLag(reference, end - overlap, -1, maxLag, overlap);
			for (const ring of this.#channelsBuffer) insertSegment(ring, end, lag, overlap);
			this.#nextWriteFrame = end + lag;
			this.#delay += lag;
			this.#expands++;
			this.#expandedFrames += lag;
			return true;
		}

		// Playback frame from which a lowering step is due: the end of the
		// sustain time, or of the interval after the last step. Null while the
		// target does not stay well below the delay.
		#lowerDueFrom(): number | null {
			const since = this.#lowerWaitingSince;
			if (since === null) return null;
			const last = this.#lastLowerFrame;
			return Math.max(
				since + this.#lowerSustainFrames,
				last === null ? since : last + this.#lowerIntervalFrames,
			);
		}

		// Takes a due lowering step on the audio before the write head: a cut
		// with a short crossfade where it is quiet; otherwise, once the step
		// has waited the quiet wait for a quiet stretch, the removal of a
		// period found by correlation, with an overlap-add.
		#lowerIfDue(): void {
			const due = this.#lowerDueFrom();
			const end = this.#nextWriteFrame;
			const reference = this.#channelsBuffer[0];
			if (due === null || end === null || !reference || this.#playoutFrame < due) return;

			const stretcher = this.#stretcher;
			const maxLag = Math.min(stretcher.maxLag, this.#delay - this.#targetDelay());
			if (maxLag < stretcher.minLag) return;

			const quietAt = end - maxLag - this.#fadeFrames;
			if (quietAt >= this.#playoutFrame && this.#isQuiet(quietAt, end)) {
				this.#removeAt(quietAt, maxLag, this.#fadeFrames, end);
				return;
			}
			if (this.#playoutFrame - due < this.#lowerQuietWaitFrames) return;

			const at = end - maxLag - stretcher.overlap;
			if (at < this.#playoutFrame || at < this.#runStart) return;
			const lag = stretcher.findLag(reference, at, 1, maxLag, stretcher.overlap);
			this.#removeAt(at, lag, stretcher.overlap, end);
		}

		// Removes `lag` frames from the audio [at, end) before the write head,
		// lowering the delay by as much.
		#removeAt(at: number, lag: number, overlap: number, end: number): void {
			for (const ring of this.#channelsBuffer) removeSegment(ring, at, lag, overlap, end);
			this.#nextWriteFrame = end - lag;
			this.#lowered(lag);
		}

		// Counts a lowering step of `frames`, taken now.
		#lowered(frames: number): void {
			this.#delay -= frames;
			this.#accelerates++;
			this.#acceleratedFrames += frames;
			this.#lastLowerFrame = this.#playoutFrame;
		}

		// Conceals missing audio once less than a quantum and an overlap of it
		// is left to play: repeats the last period of the audio, at full level
		// for the hold time and then fading out, raising the delay by what it
		// adds. Needs a period and an overlap of history without a gap.
		#conceal(outputLength: number): void {
			const end = this.#nextWriteFrame;
			const reference = this.#channelsBuffer[0];
			if (end === null || !reference) return;
			const wanted = outputLength + this.#stretcher.overlap;
			const ahead = end - this.#playoutFrame;
			if (ahead >= wanted || ahead <= 0) return;

			if (this.#concealLag === 0) {
				const stretcher = this.#stretcher;
				const overlap = Math.min(stretcher.overlap, ahead);
				const maxLag = Math.min(stretcher.maxLag, end - overlap - this.#runStart);
				if (overlap < this.#fadeFrames || maxLag < stretcher.minLag) return;

				const lag = stretcher.findLag(reference, end - overlap, -1, maxLag, overlap);
				const len = this.#bufferLength;
				for (let channel = 0; channel < this.#channelsBuffer.length; channel++) {
					const ring = this.#channelsBuffer[channel];
					const period = this.#concealPeriod[channel];
					if (!ring || !period) continue;
					insertSegment(ring, end, lag, overlap);
					for (let i = 0; i < lag; i++) period[i] = ring[(end + i) % len] ?? 0;
				}
				this.#concealLag = lag;
				this.#concealedFrames = lag;
				this.#expands++;
				this.#countConcealed(lag);
			}

			while (
				(this.#nextWriteFrame ?? end) - this.#playoutFrame < wanted &&
				this.#concealedFrames < this.#concealFrames
			) {
				const count = Math.min(
					this.#concealLag,
					this.#concealFrames - this.#concealedFrames,
				);
				this.#synthesize(count);
				this.#concealedFrames += count;
				this.#countConcealed(count);
			}
		}

		// Counts `count` concealed frames written at the write head as audio,
		// raising the delay by as much.
		#countConcealed(count: number): void {
			this.#nextWriteFrame = (this.#nextWriteFrame ?? this.#playoutFrame) + count;
			this.#delay += count;
			this.#expandedFrames += count;
		}

		// Writes the next `count` frames of concealment at the write head,
		// without counting them as written.
		#synthesize(count: number): void {
			const from = this.#nextWriteFrame;
			const lag = this.#concealLag;
			if (from === null || lag === 0) return;
			const len = this.#bufferLength;
			const hold = this.#concealHoldFrames;
			const fade = this.#concealFrames - hold;
			const frames = Math.min(count, this.#playoutFrame + len - from);
			for (let channel = 0; channel < this.#channelsBuffer.length; channel++) {
				const ring = this.#channelsBuffer[channel];
				const period = this.#concealPeriod[channel];
				if (!ring || !period) continue;
				for (let i = 0; i < frames; i++) {
					const k = this.#concealedFrames + i;
					const gain = Math.min(1, Math.max(0, (hold + fade - k) / (fade + 1)));
					ring[(from + i) % len] = (period[k % lag] ?? 0) * gain;
				}
			}
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
			if (this.#adaptive) this.#conceal(outputLength);

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
		registerProcessor(PLAYOUT_PROCESSOR_NAME, PlayoutProcessor);
	} catch (e) {
		// reason: the module was evaluated again in this scope (another copy of
		// the same version loaded it); the identical processor registered first
		// stays in use.
		if (!(e instanceof DOMException && e.name === "NotSupportedError")) throw e;
	}
}

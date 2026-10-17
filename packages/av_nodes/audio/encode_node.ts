// Audio node API: AudioEncodeNode
// Extends GainNode to enable standard connect() pattern while adding encoding capabilities
import type { CancelFunc } from "@okdaichi/golikejs/context";
import {
	DEFAULT_FRAME_DURATION_US,
	type FormatMessage,
	type FrameMessage,
	isCaptureMessage,
} from "./audio_hijack_protocol.ts";
import { HijackCode } from "./audio_hijack_worklet_inline.ts";
import { AudioWorkletModule, stopProcessor } from "./audio_worklet_module.ts";
import { HIJACK_PROCESSOR_NAME } from "./audio_worklet_protocol.ts";

const hijackWorklet = new AudioWorkletModule(HijackCode);

interface AudioContextLike {
	readonly sampleRate: number;
	readonly destination: { readonly channelCount: number };
	readonly audioWorklet: { addModule(moduleUrl: string): Promise<void> };
	readonly state?: AudioContextState;
}

// Audio the encoder may hold queued (µs) before a captured frame is dropped:
// enough to ride out the main thread's jitter, so a frame is only dropped when
// the encoder has stalled.
const MAX_QUEUED_US = 200_000;

// A gap in the captured audio longer than this (in microseconds) is kept in
// the encoded timestamps; shorter ones are taken for jitter in the timestamps
// of process()'s input. A dropped frame is always kept.
const CAPTURE_GAP_US = 100_000;

// Dropped frames are reported in one warning at most this often (ms).
const DROP_WARNING_INTERVAL_MS = 5_000;

// Queued in place of a frame when the capture worklet's input stops.
const INPUT_ENDED = Symbol("input ended");
type Captured = AudioData | typeof INPUT_ENDED;

/**
 * AudioEncodeNode extends GainNode to capture audio from the Web Audio graph
 * and encode it using WebCodecs AudioEncoder.
 *
 * Usage:
 * ```typescript
 * const encodeNode = new AudioEncodeNode(audioContext);
 * encodeNode.configure(audioEncoderConfig);
 *
 * // Standard Web Audio connect() works directly
 * sourceNode.connect(encodeNode);
 *
 * // Start encoding
 * encodeNode.encodeTo(destination);
 * ```
 */
export class AudioEncodeNode extends GainNode {
	#encoder: AudioEncoder;
	#disposed = false;
	#dests: Map<AudioEncodeDestination, CancelFunc> = new Map();
	// Retained to tear down on dispose: closing the controller unblocks #next's
	// pending read(); closing the port detaches the onmessage that feeds it.
	#readableController?: ReadableStreamDefaultController<Captured>;
	#worklet: AudioWorkletNode | null = null;
	#context: AudioContextLike;
	// Where the next captured frame starts if no audio is missing, in
	// microseconds, or null before the first frame.
	#nextTimestamp: number | null = null;
	// Whether a frame was dropped since the last one encoded.
	#dropped = false;
	// Frames dropped since the last warning, and when that was (ms).
	#droppedSinceWarning = 0;
	#lastDropWarning = -Infinity;
	// Frames captured per frame handed to the encoder, and how many of them
	// may be queued in the encoder before one is dropped.
	#frameLength: number;
	#maxQueuedFrames: number;
	// Whether the encoder was given audio since it was last flushed.
	#unflushed = false;
	// Channels of the frames handed to the encoder: the configured count, or
	// the output device's until configure() is called. WebCodecs refuses a
	// frame whose channel count differs from the encoder's and closes.
	#channels: number;

	constructor(context: AudioContextLike) {
		// Initialize as a passthrough GainNode
		super(context as unknown as AudioContext, { gain: 1.0 });

		// Set channel properties appropriate for a terminal encode node
		this.#context = context;
		this.#channels = Math.max(1, context.destination.channelCount);
		this.channelCount = this.#channels;
		this.channelCountMode = "explicit" as ChannelCountMode;
		this.#frameLength = this.#framesOf(DEFAULT_FRAME_DURATION_US);
		this.#maxQueuedFrames = Math.ceil(MAX_QUEUED_US / DEFAULT_FRAME_DURATION_US);
		this.#encoder = new AudioEncoder({
			output: (chunk, meta) => {
				for (const [dest, cancel] of this.#dests) {
					try {
						void dest.output(chunk, meta?.decoderConfig).then((err) => {
							if (err !== undefined) {
								this.#dests.delete(dest);
								cancel();
							}
						}).catch(() => {
							this.#dests.delete(dest);
							cancel();
						});
					} catch (_) {
						this.#dests.delete(dest);
						cancel();
					}
				}
			},
			error: (e) => {
				console.error("[AudioEncodeNode] encoder error:", e);
			},
		});

		// Initialize worklet and connect this GainNode to it
		hijackWorklet.load(context).then(
			() => {
				// Disposed while the module was loading: capture nothing.
				if (this.#disposed) return;

				const readable = new ReadableStream<Captured>({
					start: (controller) => {
						this.#readableController = controller;
					},
				});
				this.#attachWorklet();
				this.#next(readable.getReader());
			},
		).catch((e: unknown) => {
			if (
				(this.#disposed || context.state === "closed") &&
				e instanceof DOMException &&
				e.name === "AbortError"
			) {
				return;
			}
			console.error("[AudioEncodeNode] Failed to initialize worklet:", e);
		});
	}

	/**
	 * Configures the encoder. The node captures `config.numberOfChannels`
	 * channels from then on, mixing its input up or down as Web Audio does, so
	 * the frames match the encoder whatever the source and the output device
	 * have. It hands the encoder one frame per `config.opus.frameDuration`
	 * (20 ms if not given).
	 */
	configure(config: AudioEncoderConfig): void {
		const channels = config.numberOfChannels;
		const duration = config.opus?.frameDuration ?? DEFAULT_FRAME_DURATION_US;
		const frameLength = this.#framesOf(duration);
		if (channels !== this.#channels || frameLength !== this.#frameLength) {
			// Web Audio refuses a count it does not support, before anything
			// is committed.
			this.channelCount = channels;
			if (this.#worklet) {
				this.#worklet.channelCount = channels;
				const format: FormatMessage = { type: "format", channels, frameLength };
				this.#worklet.port.postMessage(format);
			}
			this.#channels = channels;
			this.#frameLength = frameLength;
		}
		this.#maxQueuedFrames = Math.ceil(MAX_QUEUED_US / duration);

		this.#encoder.configure(config);
	}

	// Context frames lasting `durationUs`, at least one.
	#framesOf(durationUs: number): number {
		return Math.max(1, Math.round(this.#context.sampleRate * durationUs / 1_000_000));
	}

	/**
	 * Creates the capture worklet for the current channel count, feeds its
	 * frames to the encode loop and routes this node's input into it.
	 */
	#attachWorklet(): void {
		const worklet = new AudioWorkletNode(
			this.#context as unknown as BaseAudioContext,
			HIJACK_PROCESSOR_NAME,
			{
				numberOfInputs: 1,
				numberOfOutputs: 1,
				channelCount: this.#channels,
				channelCountMode: "explicit",
				processorOptions: {
					sampleRate: this.#context.sampleRate,
					targetChannels: this.#channels,
					frameLength: this.#frameLength,
				},
			},
		);
		worklet.port.onmessage = ({ data }: MessageEvent<unknown>) => {
			if (!isCaptureMessage(data)) return;
			if (data.type === "inputEnded") {
				try {
					this.#readableController?.enqueue(INPUT_ENDED);
				} catch (_) {
					// reason: the stream closed on dispose; nothing is left to flush.
				}
				return;
			}
			let frame: AudioData;
			try {
				frame = new AudioData(audioDataInit(data));
			} catch (e) {
				console.error("[AudioEncodeNode] Failed to create AudioData:", e);
				return;
			}
			try {
				this.#readableController?.enqueue(frame);
			} catch (_) {
				// The stream closed on dispose; a frame already posted is not kept.
				frame.close();
			}
		};

		// Connect this GainNode (super) to the worklet
		// This captures all audio flowing into this node
		super.connect(worklet);
		this.#worklet = worklet;
	}

	/**
	 * Directly process an AudioData frame for encoding.
	 * Useful for testing or bypassing the Web Audio worklet pipeline.
	 */
	process(input: AudioData): void {
		if (this.#disposed || this.#encoder.state === "closed") {
			return;
		}

		// The encoder refuses a frame with another channel count and closes.
		if (
			this.#encoder.state === "configured" && input.numberOfChannels !== this.#channels
		) {
			return;
		}

		// The encoder has stalled: drop the frame.
		if (this.#encoderFull()) {
			this.#dropped = true;
			this.#countDrop();
			return;
		}

		this.#followTimeline(input);

		// Ownership: Caller owns input, so we clone for our use
		const clonedData = input.clone();

		// Encode the data
		try {
			this.#encoder.encode(clonedData);
			this.#unflushed = true;
		} catch (e) {
			// Only log if not a closed codec error during shutdown
			if (!this.#disposed) {
				console.error("[AudioEncodeNode] encode error:", e);
			}
		}

		// Ownership: We own the clone, so we close it
		clonedData.close();
	}

	/**
	 * Keeps a gap in the captured audio in the encoded timestamps. WebCodecs
	 * stamps encoded chunks by counting samples from the first frame it was
	 * given, so a gap (a source that was disconnected, or a dropped frame)
	 * would vanish, and the receiver would play the audio on either side of it
	 * back to back; a flush makes the encoder start again from the next frame's
	 * timestamp, so the receiver sees the gap. Called just before frame is
	 * encoded.
	 */
	#followTimeline(frame: AudioData): void {
		if (
			this.#dropped ||
			(this.#nextTimestamp !== null &&
				frame.timestamp - this.#nextTimestamp > CAPTURE_GAP_US)
		) {
			this.#flushHeld();
		}
		this.#dropped = false;
		this.#nextTimestamp = frame.timestamp +
			Math.round(frame.numberOfFrames * 1_000_000 / frame.sampleRate);
	}

	/**
	 * Flushes the encoder if it holds audio: it emits the partial frame it
	 * buffers, at that audio's time. It is not awaited: frames encoded after it
	 * are queued behind it, in order.
	 */
	#flushHeld(): void {
		if (!this.#unflushed) return;
		this.#unflushed = false;
		void this.flush();
	}

	async #next(stream: ReadableStreamDefaultReader<Captured>): Promise<void> {
		try {
			while (!this.#disposed) {
				const { done, value } = await stream.read();
				if (done) {
					return;
				}

				// The capture input stopped: send what the encoder holds now, at its
				// time, rather than after the input comes back, when it would be late.
				if (value === INPUT_ENDED) {
					this.#flushHeld();
					continue;
				}

				// Check again after await - state may have changed
				if (this.#disposed) {
					value.close();
					return;
				}

				// Nothing to encode with until configure(): drop the frame and keep
				// reading, so a later configure() starts encoding.
				if (this.#encoder.state === "unconfigured") {
					value.close();
					continue;
				}

				// A frame captured before configure() changed the channel count: the
				// encoder would refuse it and close.
				if (value.numberOfChannels !== this.#channels) {
					value.close();
					continue;
				}

				// The encoder has stalled: drop the frame. The next frame encoded
				// keeps its own timestamp, so the receiver sees the gap.
				if (this.#encoderFull()) {
					value.close();
					this.#dropped = true;
					this.#countDrop();
					continue;
				}

				this.#followTimeline(value);

				// Ownership: this node owns `value` — the ReadableStream is created in
				// the constructor and the AudioData is constructed here from worklet
				// messages. WebCodecs encode() captures what it needs synchronously, so
				// we can encode directly and close immediately after — no clone needed
				// (unlike process(), where the caller owns the frame).
				try {
					this.#encoder.encode(value);
					this.#unflushed = true;
				} catch (e) {
					// A thrown encode() is terminal (the codec closed, or it refuses
					// the frame): stop the loop instead of failing once per frame.
					if (!this.#disposed) {
						console.error("[AudioEncodeNode] encode error — stopping loop:", e);
					}
					value.close();
					return;
				}

				value.close();
			}
		} finally {
			stream.releaseLock();
		}
	}

	// Whether the encoder holds as much queued audio as it may: it has
	// stalled, as a working one keeps up with real time.
	#encoderFull(): boolean {
		return this.encodeQueueSize >= this.#maxQueuedFrames;
	}

	// Counts a dropped frame, and warns of the drops at most once per interval.
	#countDrop(): void {
		this.#droppedSinceWarning++;
		const now = Date.now();
		if (now - this.#lastDropWarning < DROP_WARNING_INTERVAL_MS) return;
		console.warn(
			`[AudioEncodeNode] Encoder stalled: dropped ${this.#droppedSinceWarning} frame(s) since the last warning.`,
		);
		this.#lastDropWarning = now;
		this.#droppedSinceWarning = 0;
	}

	// Codec state monitoring
	get encoderState(): CodecState {
		return this.#encoder.state;
	}

	// Queue size monitoring for backpressure management
	get encodeQueueSize(): number {
		try {
			return this.#encoder.encodeQueueSize;
		} catch (_) {
			return 0; // Graceful fallback if encoder not ready
		}
	}

	encodeTo(dest: AudioEncodeDestination): { done: Promise<void> } {
		const promise = new Promise<void>((resolve) => {
			this.#dests.set(dest, resolve);
		});

		return { done: promise };
	}

	async flush(): Promise<void> {
		if (this.#encoder.state !== "configured") {
			return;
		}
		try {
			await this.#encoder.flush();
		} catch (e) {
			// AbortError during close is expected, don't log it
			if (e instanceof DOMException && e.name === "AbortError") {
				return;
			}
			console.error("[AudioEncodeNode] flush error:", e);
		}
	}

	// Unified disposal pattern following video pattern
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;

		// Close the internal worklet→encoder stream so #next's pending read()
		// unblocks (it only re-checks #disposed after read returns), and stop the
		// worklet's processor; closing its port detaches the onmessage handler so
		// late worklet messages don't enqueue into a dead stream.
		try {
			this.#readableController?.close();
		} catch (_) {
			// reason: the stream is already closed or errored, so no read is
			// left waiting on it.
		}
		if (this.#worklet) stopProcessor(this.#worklet);

		// Flush encoder before closing
		try {
			await this.flush();
		} catch (_) {
			/* ignore */
		}

		// Clean up encoder
		try {
			this.#encoder.close();
		} catch (_) {
			/* ignore */
		}

		// Disconnect this GainNode
		try {
			super.disconnect();
		} catch (_) {
			/* ignore */
		}

		// Cleanup all destinations
		for (const [_, cancel] of this.#dests) {
			cancel();
		}
		this.#dests.clear();
	}
}

// The AudioData a captured frame makes, taking over its buffer.
function audioDataInit(frame: FrameMessage): AudioDataInit {
	return {
		format: "f32-planar",
		sampleRate: frame.sampleRate,
		numberOfChannels: frame.numberOfChannels,
		numberOfFrames: frame.numberOfFrames,
		timestamp: frame.timestamp,
		data: frame.data,
		transfer: [frame.data.buffer],
	};
}

export interface AudioEncodeDestination {
	output: (
		chunk: EncodedAudioChunk,
		decoderConfig?: AudioDecoderConfig,
	) => Promise<Error | undefined>;
}

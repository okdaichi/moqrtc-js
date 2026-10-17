// Audio node API: AudioEncodeNode
// Extends GainNode to enable standard connect() pattern while adding encoding capabilities
import type { CancelFunc } from "@okdaichi/golikejs/context";
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

// Backpressure management: Maximum queue size before dropping frames
const MAX_ENCODE_QUEUE_SIZE = 2;

// A gap in the captured audio longer than this (in microseconds) is kept in
// the encoded timestamps; shorter ones, such as a frame dropped under
// backpressure, are not.
const CAPTURE_GAP_US = 100_000;

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
	 * have.
	 */
	configure(config: AudioEncoderConfig): void {
		const channels = config.numberOfChannels;
		if (channels !== this.#channels) {
			// Web Audio refuses a count it does not support, before anything
			// is committed.
			this.channelCount = channels;
			if (this.#worklet) {
				this.#worklet.channelCount = channels;
				this.#worklet.port.postMessage({ targetChannels: channels });
			}
			this.#channels = channels;
		}

		this.#encoder.configure(config);
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
				},
			},
		);
		worklet.port.onmessage = (
			{ data }: { data: AudioDataInit | { inputEnded: true } },
		) => {
			if ("inputEnded" in data) {
				try {
					this.#readableController?.enqueue(INPUT_ENDED);
				} catch (_) {
					// The stream closed on dispose.
				}
				return;
			}
			let frame: AudioData;
			try {
				frame = new AudioData(data);
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

		// Backpressure: Drop frame if encoder is overloaded
		if (this.encodeQueueSize > MAX_ENCODE_QUEUE_SIZE) {
			console.warn(
				`[AudioEncodeNode] Dropping frame, queue size: ${this.encodeQueueSize}`,
			);
			return; // Drop frame without encoding
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
	 * given, so a gap (a source that was disconnected) would vanish; a flush
	 * makes the encoder start again from the next frame's timestamp. Called
	 * just before frame is encoded.
	 */
	#followTimeline(frame: AudioData): void {
		if (
			this.#nextTimestamp !== null &&
			frame.timestamp - this.#nextTimestamp > CAPTURE_GAP_US
		) {
			this.#flushHeld();
		}
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

				// Backpressure: When queue is overloaded, drop this frame but wait for the
				// encoder to actually drain before reading the next one.
				if (this.encodeQueueSize > MAX_ENCODE_QUEUE_SIZE) {
					console.warn(
						`[AudioEncodeNode] Dropping frame, queue size: ${this.encodeQueueSize}, waiting for drain...`,
					);
					value.close();

					if (this.#encoder.state === "closed") {
						return;
					}

					const drained = await this.#waitForEncoderDrain(5000);
					if (!drained) {
						console.warn(
							"[AudioEncodeNode] Encoder stalled, stopping stream reads after timeout.",
						);
						return;
					}

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

	#waitForEncoderDrain(timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;

			const finish = (drained: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				this.#encoder.removeEventListener("dequeue", onDequeue);
				resolve(drained);
			};

			const onDequeue = () => {
				finish(true);
			};

			const timeoutId = setTimeout(() => {
				finish(false);
			}, timeoutMs);

			this.#encoder.addEventListener("dequeue", onDequeue, { once: true });

			// Re-check immediately after attaching the listener so we don't miss
			// a drain transition that happened just before listener registration.
			if (
				this.#encoder.state !== "configured" ||
				this.encodeQueueSize <= MAX_ENCODE_QUEUE_SIZE
			) {
				finish(true);
			}
		});
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

export interface AudioEncodeDestination {
	output: (
		chunk: EncodedAudioChunk,
		decoderConfig?: AudioDecoderConfig,
	) => Promise<Error | undefined>;
}

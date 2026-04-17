// Audio node API: AudioEncodeNode
// Extends GainNode to enable standard connect() pattern while adding encoding capabilities
import type { CancelFunc } from "@okdaichi/golikejs/context";
import { createWorkletBlobUrl as createHijackWorkletBlobUrl } from "./audio_hijack_worklet_inline.ts";

const hijackWorkletName = "audio-hijacker";

interface AudioContextLike {
	readonly sampleRate: number;
	readonly destination: { readonly channelCount: number };
	readonly audioWorklet: { addModule(moduleUrl: string): Promise<void> };
}

// Backpressure management: Maximum queue size before dropping frames
const MAX_ENCODE_QUEUE_SIZE = 2;

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
	#workletReady: Promise<AudioWorkletNode>;
	#disposed = false;
	#dests: Map<AudioEncodeDestination, CancelFunc> = new Map();

	constructor(context: AudioContextLike) {
		// Initialize as a passthrough GainNode
		super(context as unknown as AudioContext, { gain: 1.0 });

		// Set channel properties appropriate for a terminal encode node
		this.channelCount = Math.max(1, context.destination.channelCount);
		this.channelCountMode = "explicit" as ChannelCountMode;
		this.#encoder = new AudioEncoder({
			output: async (chunk, meta) => {
				// Use allSettled to ensure one destination error doesn't affect others
				await Promise.allSettled(Array.from(this.#dests, async ([dest, cancel]) => {
					const err = await dest.output(chunk, meta?.decoderConfig);
					if (err !== undefined) {
						this.#dests.delete(dest);
						cancel();
					}
				}));
			},
			error: (e) => {
				console.error("[AudioEncodeNode] encoder error:", e);
			},
		});

		// Initialize worklet and connect this GainNode to it
		this.#workletReady = context.audioWorklet.addModule(
			createHijackWorkletBlobUrl(),
		).then(
			() => {
				const worklet = new AudioWorkletNode(
					context,
					hijackWorkletName,
					{
						numberOfInputs: 1,
						numberOfOutputs: 1,
						channelCount: context.destination.channelCount,
						processorOptions: {
							sampleRate: context.sampleRate,
							targetChannels: context.destination.channelCount,
						},
					},
				);

				const readable = new ReadableStream<AudioData>({
					start: (controller) => {
						worklet.port.onmessage = (
							{ data }: { data: AudioDataInit },
						) => {
							try {
								const frame = new AudioData(data);
								controller.enqueue(frame);
							} catch (e) {
								console.error(
									"[AudioEncodeNode] Failed to create AudioData:",
									e,
								);
							}
						};
					},
					cancel() {
						// Clean up when stream is cancelled
					},
				});

				// Connect this GainNode (super) to the worklet
				// This captures all audio flowing into this node
				super.connect(worklet);

				this.#next(readable.getReader());
				return worklet;
			},
		).catch((e) => {
			console.error("[AudioEncodeNode] Failed to initialize worklet:", e);
			throw e;
		});
	}

	configure(config: AudioEncoderConfig): void {
		this.#encoder.configure(config);
	}

	/**
	 * Directly process an AudioData frame for encoding.
	 * Useful for testing or bypassing the Web Audio worklet pipeline.
	 */
	process(input: AudioData): void {
		if (this.#disposed || this.#encoder.state === "closed") {
			return;
		}

		// Backpressure: Drop frame if encoder is overloaded
		if (this.encodeQueueSize > MAX_ENCODE_QUEUE_SIZE) {
			console.warn(
				`[AudioEncodeNode] Dropping frame, queue size: ${this.encodeQueueSize}`,
			);
			return; // Drop frame without encoding
		}

		// Ownership: Caller owns input, so we clone for our use
		const clonedData = input.clone();

		// Encode the data
		try {
			this.#encoder.encode(clonedData);
		} catch (e) {
			// Only log if not a closed codec error during shutdown
			if (!this.#disposed) {
				console.error("[AudioEncodeNode] encode error:", e);
			}
		}

		// Ownership: We own the clone, so we close it
		clonedData.close();
	}

	async #next(stream: ReadableStreamDefaultReader<AudioData>): Promise<void> {
		// Stop processing if disposed
		if (this.#disposed) {
			stream.releaseLock();
			return;
		}

		const { done, value } = await stream.read();
		if (done) {
			stream.releaseLock();
			return;
		}

		// Check again after await - state may have changed
		if (this.#disposed) {
			value.close();
			stream.releaseLock();
			return;
		}

		// Backpressure: Drop frame if queue is overloaded
		if (this.encodeQueueSize > MAX_ENCODE_QUEUE_SIZE) {
			console.warn(
				`[AudioEncodeNode] Dropping frame, queue size: ${this.encodeQueueSize}`,
			);
			value.close();
			queueMicrotask(() => this.#next(stream));
			return;
		}

		// Ownership: Stream owns value, so we clone for our use
		const clonedData = value.clone();
		value.close(); // Close original since we cloned it

		try {
			this.#encoder.encode(clonedData);
		} catch (e) {
			// Only log if not a closed codec error during shutdown
			if (!this.#disposed) {
				console.error("[AudioEncodeNode] encode error:", e);
			}
		}

		// Ownership: We own the clone, so we close it
		clonedData.close();

		queueMicrotask(() => this.#next(stream));
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
		if (this.#encoder.state === "closed") {
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

		// Clean up worklet
		this.#workletReady.then((worklet) => {
			try {
				worklet.disconnect();
			} catch (_) {
				/* ignore */
			}
		}).catch(() => {
			/* ignore */
		});

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

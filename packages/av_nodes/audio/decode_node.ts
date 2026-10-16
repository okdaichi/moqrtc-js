// Audio node API: AudioDecodeNode
// Extends GainNode to enable standard connect() pattern while adding decoding capabilities
import { createWorkletBlobUrl as createOffloadWorkletBlobUrl } from "./audio_offload_worklet_inline.ts";

const offloadWorkletName = "audio-offloader";

const MAX_DECODE_QUEUE_SIZE = 3;

/**
 * Snapshot of an {@link AudioDecodeNode}'s playout buffer. Delays are the
 * cushion over the fastest recent arrival, in ms.
 */
export interface AudioPlaybackStats {
	/** Delay the arrival statistics ask for. */
	targetDelayMs: number;
	/** Delay applied now; it follows the target in steps. */
	delayMs: number;
	/** Audio written ahead of the playback position. */
	bufferLevelMs: number;
	/** Decoded blocks received. */
	receivedBlocks: number;
	/** Blocks that arrived after their playout time and played after raising the delay. */
	lateBlocks: number;
	/** Blocks that arrived too late to play and were dropped. */
	droppedBlocks: number;
	/** Times playback ran out of audio and faded to silence. */
	underruns: number;
	/** Silence insertions that raised the delay, and their total length. */
	expands: number;
	expandedMs: number;
	/** Cuts that lowered the delay, and their total length. */
	accelerates: number;
	acceleratedMs: number;
	/** Jumps to the live edge after the stream ran far ahead of playback. */
	resyncs: number;
	/** Restarts from a stream that fell too far behind. */
	reanchors: number;
}

/** Options for {@link AudioDecodeNode}. */
export interface AudioDecodeNodeInit {
	/** Starting and minimum playout delay in ms (default 100). */
	latency?: number;
	/** Maximum playout delay in ms (default 400). Equal to `latency` fixes the delay. */
	maxLatency?: number;
}

/**
 * AudioDecodeNode extends GainNode to decode audio using WebCodecs AudioDecoder
 * and output it to the Web Audio graph.
 *
 * Usage:
 * ```typescript
 * const decodeNode = new AudioDecodeNode(audioContext);
 * decodeNode.configure(audioDecoderConfig);
 *
 * // Standard Web Audio connect() works directly
 * decodeNode.connect(audioContext.destination);
 *
 * // Start decoding from stream
 * decodeNode.decodeFrom(encodedAudioStream);
 * ```
 *
 * The worklet holds decoded audio in an adaptive jitter buffer. Its playout
 * delay starts at `init.latency` (ms, default 100) and follows the observed
 * arrival jitter: it rises at once when audio arrives late and falls back
 * slowly, over tens of seconds, once arrivals settle, never below `latency`
 * and never above `init.maxLatency` (ms, default 400). A good link keeps the
 * minimum delay; a bursty one (Wi-Fi power saving, coalesced RTP packets) gets
 * as much as it needs to play without gaps. Changes of delay and underruns
 * are faded over a few ms rather than cut. {@link AudioDecodeNode.getStats}
 * reports the buffer's state.
 */
export class AudioDecodeNode extends GainNode {
	#decoder: AudioDecoder;
	#workletReady: Promise<AudioWorkletNode | undefined>;
	// Cached once the worklet resolves, so #process can post directly without
	// allocating a `.then()` continuation on every decoded frame.
	#worklet: AudioWorkletNode | null = null;
	#disposed = false;
	// Active decodeFrom reader, retained so dispose() can cancel an in-flight
	// read() instead of leaving it pending (and upstream buffering into a pipe
	// nobody drains).
	#activeReader?: ReadableStreamDefaultReader<EncodedAudioChunk>;

	// Stats requests waiting for the worklet's reply, by request id.
	#statsRequests = new Map<
		number,
		{ resolve: (stats: AudioPlaybackStats) => void; reject: (error: Error) => void }
	>();
	#nextStatsRequest = 0;

	// Callback for decoded output (for metrics)
	onoutput: (() => void) | null = null;

	constructor(context: AudioContext, init: AudioDecodeNodeInit = {}) {
		// Initialize as a passthrough GainNode
		super(context, { gain: 1.0 });

		// Initialize worklet asynchronously
		this.#workletReady = context.audioWorklet.addModule(
			createOffloadWorkletBlobUrl(),
		).then(
			() => {
				// Create AudioWorkletNode
				const worklet = new AudioWorkletNode(
					context,
					offloadWorkletName,
					{
						channelCount: context.destination.channelCount,
						numberOfInputs: 0,
						numberOfOutputs: 1,
						processorOptions: {
							sampleRate: context.sampleRate,
							latency: init.latency || 100, // Default to 100ms if not specified
							maxLatency: init.maxLatency,
						},
					},
				);

				worklet.port.onmessage = (
					{ data }: { data: { type?: string; id?: number; stats?: AudioPlaybackStats } },
				) => {
					if (data.type !== "stats" || data.id === undefined || !data.stats) return;
					const request = this.#statsRequests.get(data.id);
					if (!request) return;
					this.#statsRequests.delete(data.id);
					request.resolve(data.stats);
				};

				// Connect worklet to this GainNode (super)
				// Audio flows: worklet → this GainNode → destination
				worklet.connect(this as GainNode);

				this.#worklet = worklet;
				return worklet;
			},
		).catch((error) => {
			if (
				(this.#disposed || context.state === "closed") &&
				error instanceof DOMException &&
				error.name === "AbortError"
			) {
				return undefined;
			}
			console.error(
				"[AudioDecodeNode] failed to load AudioWorklet module:",
				error,
			);
			throw error;
		});

		this.#decoder = new AudioDecoder({
			output: (frame) => {
				// try/finally guarantees the frame is closed even if #process
				// throws (e.g. copyTo format mismatch) — otherwise every decoded
				// AudioData would leak and the throw would escape the callback.
				try {
					this.#process(frame);
				} catch (e) {
					console.error("[AudioDecodeNode] process error:", e);
				} finally {
					frame.close();
				}
			},
			error: (e) => {
				console.error("[AudioDecodeNode] decoder error:", e);
			},
		});
	}

	configure(config: AudioDecoderConfig): void {
		this.#decoder.configure(config);
	}

	// Codec state monitoring
	get decoderState(): CodecState {
		return this.#decoder.state;
	}

	// Queue size monitoring for backpressure management
	get decodeQueueSize(): number {
		try {
			return this.#decoder.decodeQueueSize;
		} catch (_) {
			return 0; // Graceful fallback if decoder not ready
		}
	}

	decodeFrom(
		stream: ReadableStream<EncodedAudioChunk>,
	): { done: Promise<void> } {
		const done = (async () => {
			let reader:
				| ReadableStreamDefaultReader<EncodedAudioChunk>
				| undefined;
			try {
				reader = stream.getReader();
				this.#activeReader = reader;
				while (this.context.state === "running" && !this.#disposed) {
					// Backpressure: Wait for decoder queue to drain before reading
					// from upstream so the stream can naturally slow down.
					while (
						this.context.state === "running" &&
						!this.#disposed &&
						this.decodeQueueSize > MAX_DECODE_QUEUE_SIZE
					) {
						if (this.#decoder.state !== "configured") {
							return;
						}

						const drained = await this.#waitForDecoderDrain(5000);
						if (!drained) {
							console.warn(
								"[AudioDecodeNode] Decoder stalled, stopping stream reads after timeout.",
							);
							return;
						}
					}

					const { done, value: chunk } = await reader.read();
					if (done) {
						break;
					}

					this.#decoder.decode(chunk);
				}
			} catch (e) {
				// AbortError during close is expected, don't log it
				if (e instanceof DOMException && e.name === "AbortError") {
					return;
				}
				if (!this.#disposed) {
					console.error("[AudioDecodeNode] decodeFrom error:", e);
				}
			} finally {
				this.#activeReader = undefined;
				reader?.releaseLock();
			}
		})();

		return {
			done,
		};
	}

	#waitForDecoderDrain(timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;

			const finish = (drained: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				this.#decoder.removeEventListener("dequeue", onDequeue);
				resolve(drained);
			};

			const onDequeue = () => {
				finish(true);
			};

			const timeoutId = setTimeout(() => {
				finish(false);
			}, timeoutMs);

			this.#decoder.addEventListener("dequeue", onDequeue, { once: true });

			// Re-check immediately after attaching the listener so we don't miss
			// a drain transition that happened just before listener registration.
			if (
				this.#decoder.state !== "configured" ||
				this.decodeQueueSize <= MAX_DECODE_QUEUE_SIZE
			) {
				finish(true);
			}
		});
	}

	#process(input: AudioData): void {
		if (this.#disposed) return;

		// Call output callback for metrics
		if (this.onoutput) {
			this.onoutput();
		}

		// Extract audio channels from AudioData
		const numChannels = input.numberOfChannels;
		const numFrames = input.numberOfFrames;
		const channels = new Array<Float32Array>(numChannels);
		const transfer = new Array<ArrayBuffer>(numChannels);
		for (let i = 0; i < numChannels; i++) {
			const data = new Float32Array(numFrames);
			input.copyTo(data, { format: "f32-planar", planeIndex: i });
			channels[i] = data;
			transfer[i] = data.buffer;
		}

		// Send AudioData to the worklet.
		// Ownership: Transfer buffer ownership to worklet.
		// Fast path: once the worklet has resolved (once, at startup) post
		// directly. This avoids allocating a `.then()` Promise continuation and
		// an extra microtask hop on every decoded frame. Until it resolves, fall
		// back to queuing via the readiness promise.
		const worklet = this.#worklet;
		if (worklet) {
			// try/catch mirrors the fallback's .catch(() => {}): a throw here
			// (e.g. DataCloneError on a non-transferable buffer, or the port
			// closing during dispose) must not escape into the decoder's output
			// callback, where it would skip the caller's frame.close().
			try {
				worklet.port.postMessage(
					{
						channels: channels,
						timestamp: input.timestamp,
					},
					transfer, // Transfer ownership of the buffers
				);
			} catch (_) {
				/* ignore */
			}
			return;
		}

		this.#workletReady.then((w) => {
			if (!w) return;
			w.port.postMessage(
				{
					channels: channels,
					timestamp: input.timestamp,
				},
				transfer, // Transfer ownership of the buffers
			);
		}).catch(() => {
			/* ignore */
		});
	}

	/**
	 * Asks the playback worklet for a snapshot of its jitter buffer. Rejects if
	 * the worklet failed to load or the node is disposed before it replies.
	 */
	async getStats(): Promise<AudioPlaybackStats> {
		const worklet = await this.#workletReady;
		if (!worklet || this.#disposed) {
			throw new Error("AudioDecodeNode has no playback worklet");
		}
		const id = this.#nextStatsRequest++;
		return new Promise<AudioPlaybackStats>((resolve, reject) => {
			this.#statsRequests.set(id, { resolve, reject });
			try {
				worklet.port.postMessage({ type: "stats", id });
			} catch (e) {
				this.#statsRequests.delete(id);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	async flush(): Promise<void> {
		if (this.#decoder.state !== "configured") {
			return;
		}
		try {
			await this.#decoder.flush();
		} catch (e) {
			// AbortError during close is expected, don't log it
			if (e instanceof DOMException && e.name === "AbortError") {
				return;
			}
			console.error("[AudioDecodeNode] flush error:", e);
		}
	}

	async close(): Promise<void> {
		try {
			await this.#decoder.flush();
			this.#decoder.close();
		} catch (_) {
			/* ignore */
		}
	}

	// Unified disposal pattern following video pattern
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;

		for (const request of this.#statsRequests.values()) {
			request.reject(new Error("AudioDecodeNode disposed"));
		}
		this.#statsRequests.clear();

		// Close decoder directly (skip flush to avoid AbortError)
		try {
			this.#decoder.close();
		} catch (_) {
			/* ignore */
		}

		// Cancel any in-flight decodeFrom read() so its loop unblocks instead
		// of staying pending on a stream we no longer drain.
		try {
			void this.#activeReader?.cancel();
		} catch (_) {
			/* ignore */
		}

		// Disconnect this GainNode
		try {
			super.disconnect();
		} catch (_) {
			/* ignore */
		}

		// Disconnect worklet
		this.#workletReady.then((worklet) => {
			try {
				worklet?.disconnect();
			} catch (_) {
				/* ignore */
			}
		}).catch(() => {
			/* ignore */
		});
	}
}

// Audio node API: AudioDecodeNode
// Extends GainNode to enable standard connect() pattern while adding decoding capabilities
import {
	type AppendMessage,
	DEFAULT_LATENCY_MS,
	DEFAULT_MAX_LATENCY_MS,
	isStatsReply,
	type StatsRequest,
} from "./audio_offload_protocol.ts";
import { createWorkletBlobUrl as createOffloadWorkletBlobUrl } from "./audio_offload_worklet_inline.ts";
import type { AudioPlaybackStats } from "./audio_playback_stats.ts";

const offloadWorkletName = "audio-offloader";

const MAX_DECODE_QUEUE_SIZE = 3;

export type { AudioPlaybackStats } from "./audio_playback_stats.ts";

/** Options for {@link AudioDecodeNode}. */
export interface AudioDecodeNodeInit {
	/** Starting and minimum playout delay in ms (default 100). */
	readonly latency?: number;
	/**
	 * Maximum playout delay in ms (default 400, or `latency` if larger). Equal
	 * to `latency` fixes the delay.
	 */
	readonly maxLatency?: number;
}

/** An {@link AudioDecodeNodeInit} value out of range. */
export class AudioDecodeNodeOptionError extends RangeError {
	readonly option: keyof AudioDecodeNodeInit;
	readonly value: number;

	constructor(option: keyof AudioDecodeNodeInit, value: number, requirement: string) {
		super(`AudioDecodeNode: ${option} must be ${requirement}, got ${value}`);
		this.name = "AudioDecodeNodeOptionError";
		this.option = option;
		this.value = value;
	}
}

/** The node was disposed before or while the operation ran. */
export class AudioDecodeNodeDisposedError extends Error {
	constructor() {
		super("AudioDecodeNode is disposed");
		this.name = "AudioDecodeNodeDisposedError";
	}
}

/** The playback worklet failed to load, failed while running, or could not be reached. */
export class AudioPlaybackUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AudioPlaybackUnavailableError";
	}
}

interface StatsRequestHandlers {
	readonly resolve: (stats: AudioPlaybackStats) => void;
	readonly reject: (error: Error) => void;
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
	readonly #statsRequests = new Map<number, StatsRequestHandlers>();
	#nextStatsRequest = 0;
	// Set when the worklet's processor fails; it then answers nothing.
	#playbackError: AudioPlaybackUnavailableError | null = null;

	// Callback for decoded output (for metrics)
	onoutput: (() => void) | null = null;

	/**
	 * @throws {AudioDecodeNodeOptionError} if `latency` or `maxLatency` is not a
	 * positive finite number, or `maxLatency` is below `latency`.
	 */
	constructor(context: AudioContext, init: AudioDecodeNodeInit = {}) {
		// Initialize as a passthrough GainNode
		super(context, { gain: 1.0 });

		const latency = init.latency ?? DEFAULT_LATENCY_MS;
		if (!Number.isFinite(latency) || latency <= 0) {
			throw new AudioDecodeNodeOptionError("latency", latency, "a positive finite number");
		}
		const maxLatency = init.maxLatency ?? Math.max(DEFAULT_MAX_LATENCY_MS, latency);
		if (!Number.isFinite(maxLatency) || maxLatency < latency) {
			throw new AudioDecodeNodeOptionError(
				"maxLatency",
				maxLatency,
				`a finite number not below latency (${latency})`,
			);
		}

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
							latency,
							maxLatency,
						},
					},
				);

				worklet.port.onmessage = (event: MessageEvent<unknown>) => {
					const reply = event.data;
					if (!isStatsReply(reply)) return;
					const request = this.#statsRequests.get(reply.id);
					if (request === undefined) return;
					this.#statsRequests.delete(reply.id);
					request.resolve(reply.stats);
				};

				worklet.onprocessorerror = () => {
					const error = new AudioPlaybackUnavailableError(
						"AudioDecodeNode: the playback worklet failed",
					);
					this.#playbackError = error;
					this.#rejectStatsRequests(error);
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

		const message: AppendMessage = {
			type: "append",
			channels,
			timestamp: input.timestamp,
		};

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
					message,
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
				message,
				transfer, // Transfer ownership of the buffers
			);
		}).catch(() => {
			/* ignore */
		});
	}

	/**
	 * Asks the playback worklet for a snapshot of its jitter buffer.
	 *
	 * @throws {AudioDecodeNodeDisposedError} if the node is disposed before the
	 * worklet replies.
	 * @throws {AudioPlaybackUnavailableError} if the worklet failed to load,
	 * fails before replying, or cannot be posted to.
	 */
	async getStats(): Promise<AudioPlaybackStats> {
		const worklet = await this.#workletReady.catch((e: unknown) => {
			throw new AudioPlaybackUnavailableError(
				"AudioDecodeNode: the playback worklet failed to load",
				{ cause: e },
			);
		});
		if (this.#disposed) throw new AudioDecodeNodeDisposedError();
		if (this.#playbackError) throw this.#playbackError;
		if (!worklet) {
			throw new AudioPlaybackUnavailableError(
				"AudioDecodeNode: the playback worklet was not loaded",
			);
		}

		const id = this.#nextStatsRequest++;
		const request: StatsRequest = { type: "stats", id };
		return new Promise<AudioPlaybackStats>((resolve, reject) => {
			this.#statsRequests.set(id, { resolve, reject });
			try {
				worklet.port.postMessage(request);
			} catch (e) {
				this.#statsRequests.delete(id);
				reject(
					new AudioPlaybackUnavailableError(
						"AudioDecodeNode: could not post to the playback worklet",
						{ cause: e },
					),
				);
			}
		});
	}

	#rejectStatsRequests(error: Error): void {
		for (const request of this.#statsRequests.values()) {
			request.reject(error);
		}
		this.#statsRequests.clear();
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

		this.#rejectStatsRequests(new AudioDecodeNodeDisposedError());

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

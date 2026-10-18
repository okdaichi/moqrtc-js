// Audio node API: AudioDecodeNode
// Extends GainNode to enable standard connect() pattern while adding decoding capabilities
import {
	type AppendMessage,
	DEFAULT_LATENCY_MS,
	DEFAULT_MAX_LATENCY_MS,
	isStatsReply,
	type StatsRequest,
} from "./playout_protocol.ts";
import { PlayoutCode } from "./playout_worklet_inline.ts";
import type { AudioPlaybackStats, AudioPlayoutStats } from "./audio_playback_stats.ts";
import { AudioWorkletModule, stopProcessor } from "./audio_worklet_module.ts";
import { PLAYOUT_PROCESSOR_NAME } from "./audio_worklet_protocol.ts";

const playoutWorklet = new AudioWorkletModule(PlayoutCode);

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

/** Options for {@link AudioDecodeNode.getStats}. */
export interface AudioPlaybackStatsOptions {
	/** How long to wait for the worklet's reply, in ms (default 1000). */
	readonly timeoutMs?: number;
}

/** An {@link AudioDecodeNodeInit} or {@link AudioPlaybackStatsOptions} value out of range. */
export class AudioDecodeNodeOptionError extends RangeError {
	readonly option: keyof AudioDecodeNodeInit | keyof AudioPlaybackStatsOptions;
	readonly value: number;

	constructor(
		option: keyof AudioDecodeNodeInit | keyof AudioPlaybackStatsOptions,
		value: number,
		requirement: string,
	) {
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

/**
 * Why the playback worklet cannot answer: its module failed to load, it was
 * not created, its processor failed, posting to it failed, the audio context
 * is closed, or it did not reply in time.
 */
export type AudioPlaybackUnavailableReason =
	| "load-failed"
	| "not-loaded"
	| "processor-failed"
	| "post-failed"
	| "context-closed"
	| "timeout";

const UNAVAILABLE_MESSAGES: { readonly [R in AudioPlaybackUnavailableReason]: string } = {
	"load-failed": "the playback worklet failed to load",
	"not-loaded": "the playback worklet was not loaded",
	"processor-failed": "the playback worklet failed",
	"post-failed": "could not post to the playback worklet",
	"context-closed": "the audio context is closed",
	"timeout": "the playback worklet did not reply in time",
};

/** The playback worklet failed to load, failed while running, or could not be reached. */
export class AudioPlaybackUnavailableError extends Error {
	readonly reason: AudioPlaybackUnavailableReason;

	constructor(reason: AudioPlaybackUnavailableReason, options?: ErrorOptions) {
		super(`AudioDecodeNode: ${UNAVAILABLE_MESSAGES[reason]}`, options);
		this.name = "AudioPlaybackUnavailableError";
		this.reason = reason;
	}
}

/** The playback worklet did not answer a stats request in time. */
export class AudioPlaybackStatsTimeoutError extends AudioPlaybackUnavailableError {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super("timeout");
		this.name = "AudioPlaybackStatsTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

// How long getStats() waits for the worklet's reply by default (ms).
const DEFAULT_STATS_TIMEOUT_MS = 1000;

// Cancels a stream that is no longer read.
function abandon(reader: ReadableStreamDefaultReader<unknown>): void {
	reader.cancel().catch(() => {
		// reason: the stream is abandoned either way; a source that fails to
		// cancel leaves nothing to do.
	});
}

interface StatsRequestHandlers {
	readonly resolve: (stats: AudioPlayoutStats) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
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
 * arrival jitter: it rises at once when audio arrives late, holds while late
 * arrivals recur within 20 to 40 s, and falls back slowly once they stop,
 * never below `latency` and never above `init.maxLatency` (ms, default 400).
 * A good link keeps the minimum delay; a bursty one (Wi-Fi power saving,
 * coalesced RTP packets) gets as much as it needs to play without gaps.
 * Inside sound, the delay changes by repeating or removing a pitch period
 * with an overlap-add, and audio that has not arrived in time is concealed
 * the same way for up to 60 ms, so neither clicks; silence and underruns are
 * faded over a few ms. {@link AudioDecodeNode.getStats} reports the buffer's
 * state.
 */
export class AudioDecodeNode extends GainNode {
	#decoder: AudioDecoder;
	// Resolves to the worklet, or to undefined if it was not created; never
	// rejects (a failed load is kept in #playbackError).
	readonly #workletReady: Promise<AudioWorkletNode | undefined>;
	// Cached once the worklet resolves, so #process can post directly without
	// allocating a `.then()` continuation on every decoded frame.
	#worklet: AudioWorkletNode | null = null;
	#disposed = false;
	// Active decodeFrom reader, retained so dispose() can cancel an in-flight
	// read() instead of leaving it pending (and upstream buffering into a pipe
	// nobody drains).
	#activeReader?: ReadableStreamDefaultReader<EncodedAudioChunk>;
	// Chunks decodeFrom dropped because the context was not running.
	#droppedWhileSuspended = 0;

	// Stats requests waiting for the worklet's reply, by request id.
	readonly #statsRequests = new Map<number, StatsRequestHandlers>();
	#nextStatsRequest = 0;
	// Set when the worklet fails to load, its processor fails or the context
	// closes; the worklet then answers nothing.
	#playbackError: AudioPlaybackUnavailableError | null = null;
	readonly #onStateChange: () => void;

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
		this.#onStateChange = () => {
			if (context.state === "closed") {
				this.#fail(new AudioPlaybackUnavailableError("context-closed"));
				// A pending read() would otherwise wait for the next chunk.
				if (this.#activeReader) abandon(this.#activeReader);
			}
		};
		context.addEventListener("statechange", this.#onStateChange);

		this.#workletReady = playoutWorklet.load(context).then(
			() => {
				// Disposed while the module was loading: play nothing.
				if (this.#disposed) return undefined;

				// Create AudioWorkletNode
				const worklet = new AudioWorkletNode(
					context,
					PLAYOUT_PROCESSOR_NAME,
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
					this.#settle(reply.id)?.resolve(reply.stats);
				};

				worklet.onprocessorerror = () => {
					this.#fail(new AudioPlaybackUnavailableError("processor-failed"));
				};

				// Connect worklet to this GainNode (super)
				// Audio flows: worklet → this GainNode → destination
				worklet.connect(this as GainNode);

				this.#worklet = worklet;
				return worklet;
			},
		).catch((error: unknown) => {
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
			this.#fail(new AudioPlaybackUnavailableError("load-failed", { cause: error }));
			return undefined;
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

	/**
	 * Reads `stream` and decodes its chunks for playback. A chunk read while the
	 * context is not running (not yet resumed, suspended or interrupted) would
	 * play late, so it is dropped and reading goes on: playback picks up with
	 * the stream as it arrives once the context runs again. Reading ends at the
	 * end of the stream, on {@link AudioDecodeNode.dispose}, when the context
	 * closes, or on an error; ending any way but the end of the stream cancels
	 * the stream.
	 */
	decodeFrom(
		stream: ReadableStream<EncodedAudioChunk>,
	): { done: Promise<void> } {
		const done = (async () => {
			let reader:
				| ReadableStreamDefaultReader<EncodedAudioChunk>
				| undefined;
			let ended = false;
			try {
				reader = stream.getReader();
				this.#activeReader = reader;
				while (!this.#disposed && this.context.state !== "closed") {
					// Backpressure: Wait for decoder queue to drain before reading
					// from upstream so the stream can naturally slow down.
					while (
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
						ended = true;
						return;
					}

					if (this.context.state === "running") {
						this.#decoder.decode(chunk);
					} else {
						this.#droppedWhileSuspended++;
					}
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
				if (this.#activeReader === reader) this.#activeReader = undefined;
				if (reader !== undefined && !ended) abandon(reader);
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
	 * @throws {AudioDecodeNodeOptionError} if `timeoutMs` is not a positive
	 * finite number.
	 * @throws {AudioDecodeNodeDisposedError} if the node is disposed before the
	 * worklet replies.
	 * @throws {AudioPlaybackStatsTimeoutError} if the worklet does not reply
	 * within `timeoutMs`.
	 * @throws {AudioPlaybackUnavailableError} if the worklet failed to load,
	 * fails before replying, cannot be posted to, or the context is closed.
	 */
	async getStats(options: AudioPlaybackStatsOptions = {}): Promise<AudioPlaybackStats> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_STATS_TIMEOUT_MS;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new AudioDecodeNodeOptionError(
				"timeoutMs",
				timeoutMs,
				"a positive finite number",
			);
		}
		const worklet = await this.#workletReady;
		if (this.#disposed) throw new AudioDecodeNodeDisposedError();
		this.#onStateChange();
		if (this.#playbackError) throw this.#playbackError;
		if (!worklet) {
			throw new AudioPlaybackUnavailableError("not-loaded");
		}

		const id = this.#nextStatsRequest++;
		const request: StatsRequest = { type: "stats", id };
		const playout = await new Promise<AudioPlayoutStats>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#settle(id)?.reject(new AudioPlaybackStatsTimeoutError(timeoutMs));
			}, timeoutMs);
			this.#statsRequests.set(id, { resolve, reject, timer });
			try {
				worklet.port.postMessage(request);
			} catch (e) {
				this.#settle(id)?.reject(
					new AudioPlaybackUnavailableError("post-failed", { cause: e }),
				);
			}
		});
		return { ...playout, droppedWhileSuspended: this.#droppedWhileSuspended };
	}

	// Removes a pending stats request and stops its timer, returning it.
	#settle(id: number): StatsRequestHandlers | undefined {
		const request = this.#statsRequests.get(id);
		if (request === undefined) return undefined;
		this.#statsRequests.delete(id);
		clearTimeout(request.timer);
		return request;
	}

	#rejectStatsRequests(error: Error): void {
		for (const id of [...this.#statsRequests.keys()]) {
			this.#settle(id)?.reject(error);
		}
	}

	// The worklet will answer nothing more: fail every request, now and later.
	#fail(error: AudioPlaybackUnavailableError): void {
		this.#playbackError ??= error;
		this.#rejectStatsRequests(error);
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

		this.context.removeEventListener("statechange", this.#onStateChange);
		this.#rejectStatsRequests(new AudioDecodeNodeDisposedError());

		// Close decoder directly (skip flush to avoid AbortError)
		try {
			this.#decoder.close();
		} catch (_) {
			/* ignore */
		}

		// Cancel any in-flight decodeFrom read() so its loop unblocks instead
		// of staying pending on a stream we no longer drain.
		if (this.#activeReader) abandon(this.#activeReader);

		// Disconnect this GainNode
		try {
			super.disconnect();
		} catch (_) {
			/* ignore */
		}

		if (this.#worklet) stopProcessor(this.#worklet);
	}
}

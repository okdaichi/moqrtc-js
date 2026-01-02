// Audio node API: AudioDecodeNode
// Extends GainNode to enable standard connect() pattern while adding decoding capabilities
import {
	createWorkletBlobUrl as createOffloadWorkletBlobUrl,
} from "./audio_offload_worklet_inline.ts";

const offloadWorkletName = "audio-offloader";

const MAX_DECODE_QUEUE_SIZE = 3;

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
 */
export class AudioDecodeNode extends GainNode {
	#decoder: AudioDecoder;
	#workletReady: Promise<AudioWorkletNode>;
	#disposed = false;

	// Callback for decoded output (for metrics)
	onoutput: (() => void) | null = null;

	constructor(context: AudioContext, init: { latency?: number } = {}) {
		// Initialize as a passthrough GainNode
		super(context, { gain: 1.0 });

		// Initialize worklet asynchronously
		this.#workletReady = context.audioWorklet.addModule(createOffloadWorkletBlobUrl()).then(() => {
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
					},
				},
			);

			// Connect worklet to this GainNode (super)
			// Audio flows: worklet → this GainNode → destination
			worklet.connect(this as GainNode);

			return worklet;
		}).catch((error) => {
			console.error("[AudioDecodeNode] failed to load AudioWorklet module:", error);
			throw error;
		});

		this.#decoder = new AudioDecoder({
			output: (frame) => {
				// Pass audio frame to processing
				this.#process(frame);

				// Close the decoded frame after processing
				frame.close();
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

	decodeFrom(stream: ReadableStream<EncodedAudioChunk>): { done: Promise<void> } {
		const done = (async () => {
			let reader: ReadableStreamDefaultReader<EncodedAudioChunk> | undefined;
			try {
				reader = stream.getReader();
				while (this.context.state === "running" && !this.#disposed) {
					// Backpressure: Wait if decoder queue is overloaded
					if (this.decodeQueueSize > MAX_DECODE_QUEUE_SIZE) {
						await new Promise<void>((resolve) => {
							queueMicrotask(() => resolve());
						});
						continue;
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
				reader?.releaseLock();
			}
		})();

		return {
			done,
		};
	}

	#process(input: AudioData): void {
		if (this.#disposed) return;

		// Call output callback for metrics
		if (this.onoutput) {
			this.onoutput();
		}

		// Extract audio channels from AudioData
		const channels: Float32Array[] = [];
		for (let i = 0; i < input.numberOfChannels; i++) {
			const data = new Float32Array(input.numberOfFrames);
			input.copyTo(data, { format: "f32-planar", planeIndex: i });
			channels.push(data);
		}

		// Send AudioData to the worklet
		// Ownership: Transfer buffer ownership to worklet
		this.#workletReady.then((worklet) => {
			worklet.port.postMessage(
				{
					channels: channels,
					timestamp: input.timestamp,
				},
				channels.map((d) => d.buffer), // Transfer ownership of the buffers
			);
		}).catch(() => {
			/* ignore */
		});
	}

	async flush(): Promise<void> {
		if (this.#decoder.state === "closed") {
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

		// Close decoder directly (skip flush to avoid AbortError)
		try {
			this.#decoder.close();
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
				worklet.disconnect();
			} catch (_) {
				/* ignore */
			}
		}).catch(() => {
			/* ignore */
		});
	}
}

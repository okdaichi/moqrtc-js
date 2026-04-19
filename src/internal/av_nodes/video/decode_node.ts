import type { VideoContext } from "./context.ts";
import { VideoNode } from "./video_node.ts";

const MAX_QUEUE_SIZE = 3;

export class VideoDecodeNode extends VideoNode {
	readonly context: VideoContext;
	#decoder: VideoDecoder;

	constructor(context: VideoContext) {
		super({ numberOfInputs: 1, numberOfOutputs: 1 });
		this.context = context;
		this.context._register(this);

		this.#decoder = new VideoDecoder({
			output: (frame) => {
				// Pass decoded frame to next nodes
				this.process(frame);

				// Close the decoded frame after processing
				try {
					frame.close();
				} catch (e) {
					console.error("[VideoDecodeNode] frame close error:", e);
				}
			},
			error: (e) => {
				console.error("[VideoDecodeNode] decoder error:", e);
			},
		});
	}

	get decoderState(): CodecState {
		return this.#decoder.state;
	}

	get decodeQueueSize(): number {
		try {
			return this.#decoder.decodeQueueSize;
		} catch (_) {
			return 0;
		}
	}

	configure(config: VideoDecoderConfig): void {
		this.#decoder.configure(config);
	}

	decodeFrom(
		stream: ReadableStream<EncodedVideoChunk>,
	): { done: Promise<void> } {
		const done = (async () => {
			let reader:
				| ReadableStreamDefaultReader<EncodedVideoChunk>
				| undefined;
			try {
				reader = stream.getReader();
				while (this.context.state === "running" && !this.disposed) {
					// Backpressure: Wait if decoder queue is overloaded
					if (this.decodeQueueSize > MAX_QUEUE_SIZE) {
						console.warn(
							`[VideoDecodeNode] Decoder overloaded (queue: ${this.decodeQueueSize}), waiting...`,
						);
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
				console.error("[VideoDecodeNode] decodeFrom error:", e);
			} finally {
				reader?.releaseLock();
			}
		})();

		return { done };
	}

	process(input: VideoFrame): void {
		// Ownership: Caller (decoder callback) owns input, outputs will clone if needed
		for (const output of this.outputs) {
			try {
				void output.process(input);
			} catch (e) {
				// Handle closed frame or clone error
				if (
					e instanceof DOMException && e.name === "InvalidStateError"
				) {
					console.warn("[VideoDecodeNode] Cannot clone closed frame");
				} else {
					console.error("[VideoDecodeNode] process error:", e);
				}
			}
		}
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
			console.error("[VideoDecodeNode] flush error:", e);
		}
	}

	override async dispose(): Promise<void> {
		if (this.disposed) return;
		try {
			await this.flush();
		} catch (_) {
			/* ignore */
		}
		try {
			this.#decoder.close();
		} catch (_) {
			/* ignore */
		}
		this.context._unregister(this);
		super.dispose();
	}
}

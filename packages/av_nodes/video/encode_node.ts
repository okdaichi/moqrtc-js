import type { CancelFunc } from "@okdaichi/golikejs/context";
import type { VideoContext } from "./context.ts";
import { VideoNode } from "./video_node.ts";

const MAX_QUEUE_SIZE = 2;

export class VideoEncodeNode extends VideoNode {
	readonly context: VideoContext;
	#encoder: VideoEncoder;
	#isKey: IsKeyFunction;
	#dests: Map<VideoEncodeDestination, CancelFunc> = new Map();

	constructor(
		context: VideoContext,
		options?: { isKey?: IsKeyFunction },
	) {
		super({ numberOfInputs: 1, numberOfOutputs: 1 });
		this.context = context;
		this.#isKey = options?.isKey ?? (() => false);
		this.context._register(this);

		this.#encoder = new VideoEncoder({
			output: (chunk, meta) => {
				// Pass encoded chunk to all registered destinations
				Promise.allSettled(Array.from(this.#dests, async ([dest, cancel]) => {
					const err = await dest.output(chunk, meta?.decoderConfig);
					if (err !== undefined) {
						this.#dests.delete(dest);
						cancel();
					}
				}));
			},
			error: (e) => {
				console.error("[VideoEncodeNode] encoder error:", e);
			},
		});
	}

	get encoderState(): CodecState {
		return this.#encoder.state;
	}

	get encodeQueueSize(): number {
		try {
			return this.#encoder.encodeQueueSize;
		} catch (_) {
			return 0;
		}
	}

	configure(config: VideoEncoderConfig): void {
		this.#encoder.configure(config);
	}

	process(input: VideoFrame): void {
		if (this.disposed || this.#encoder.state === "closed") {
			return;
		}

		// Backpressure: Drop frames if encoder is overloaded
		if (this.encodeQueueSize > MAX_QUEUE_SIZE) {
			console.warn(
				`[VideoEncodeNode] Dropping frame, queue size: ${this.encodeQueueSize}`,
			);
			return; // Drop frame without encoding
		}

		// Ownership: Caller owns input, so we clone for our use
		const clonedFrame = input.clone();

		// Encode the frame
		try {
			this.#encoder.encode(clonedFrame, {
				keyFrame: this.#isKey(input.timestamp, this.encodeQueueSize),
			});
		} catch (e) {
			// Only log if not a closed codec error during shutdown
			if (!this.disposed) {
				console.error("[VideoEncodeNode] encode error:", e);
			}
		}

		// Ownership: We own the clone, so we close it
		clonedFrame.close();
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
			console.error("[VideoEncodeNode] flush error:", e);
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
			this.#encoder.close();
		} catch (_) {
			/* ignore */
		}
		// Cleanup all destinations
		for (const [_, cancel] of this.#dests) {
			cancel();
		}
		this.#dests.clear();
		this.context._unregister(this);
		super.dispose();
	}

	encodeTo(dest: VideoEncodeDestination): { done: Promise<void> } {
		const promise = new Promise<void>((resolve) => {
			this.#dests.set(dest, resolve);
		});

		return { done: promise };
	}
}

type IsKeyFunction = (timestamp: number, count: number) => boolean;

export interface VideoEncodeDestination {
	output: (
		chunk: EncodedVideoChunk,
		decoderConfig?: VideoDecoderConfig,
	) => Promise<Error | undefined>;
}

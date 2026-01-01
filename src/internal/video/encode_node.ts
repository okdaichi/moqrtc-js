import type { EncodeDestination } from "./container.ts";
import type { VideoContext } from "./context.ts";
import { VideoNode } from "./video_node.ts";

export class VideoEncodeNode extends VideoNode {
	readonly context: VideoContext;
	#encoder: VideoEncoder;
	#isKey: () => boolean;
	#dests: Set<EncodeDestination> = new Set();

	constructor(
		context: VideoContext,
		options?: { startSequence?: bigint; isKey?: () => boolean },
	) {
		super({ numberOfInputs: 1, numberOfOutputs: 1 });
		this.context = context;
		this.#isKey = options?.isKey ?? (() => false);
		this.context._register(this);

		this.#encoder = new VideoEncoder({
			output: async (chunk) => {
				// Pass encoded chunk to all registered destinations
				await Promise.allSettled(
					Array.from(this.#dests, (dest) => dest.output(chunk)),
				);
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
		if (this.disposed) {
			return;
		}

		// Clone the input frame
		const clonedFrame = input.clone();

		// Encode the frame
		try {
			this.#encoder.encode(clonedFrame, { keyFrame: this.#isKey() });
		} catch (e) {
			console.error("[VideoEncodeNode] encode error:", e);
		}

		clonedFrame.close();
	}

	async flush(): Promise<void> {
		try {
			await this.#encoder.flush();
		} catch (e) {
			console.error("[VideoEncodeNode] flush error:", e);
		}
	}

	async close(): Promise<void> {
		try {
			await this.flush();
			this.#encoder.close();
		} catch (_) {
			/* ignore */
		}
	}

	override dispose(): void {
		if (this.disposed) return;
		try {
			this.#encoder.close();
		} catch (_) {
			/* ignore */
		}
		this.context._unregister(this);
		super.dispose();
	}

	async encodeTo(dest: EncodeDestination): Promise<void> {
		this.#dests.add(dest);
		await Promise.allSettled([dest.done]);
		this.#dests.delete(dest);
	}
}

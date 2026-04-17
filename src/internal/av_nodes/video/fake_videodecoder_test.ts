import { FakeVideoFrame } from "./fake_videoframe_test.ts";

/**
 * FakeVideoDecoder for Deno test environments.
 *
 * Behaves like the real VideoDecoder:
 * - configure() sets state to "configured"
 * - decode(chunk) queues a microtask that calls init.output() with a FakeVideoFrame
 * - close() sets state to "closed"
 * - reset() returns to "unconfigured"
 *
 * Call tracking arrays allow test assertions without spy API.
 */
export class FakeVideoDecoder {
	/** The most recently constructed FakeVideoDecoder instance. */
	static lastCreated: FakeVideoDecoder | null = null;

	// State
	state: CodecState = "unconfigured";
	decodeQueueSize = 0;

	// Call tracking
	configureCalls: VideoDecoderConfig[][] = [];
	decodeCalls: EncodedVideoChunk[][] = [];
	resetCalls = 0;
	flushCalls = 0;
	closeCalls = 0;

	get configureCalled(): boolean {
		return this.configureCalls.length > 0;
	}
	get decodeCalled(): boolean {
		return this.decodeCalls.length > 0;
	}
	get resetCalled(): boolean {
		return this.resetCalls > 0;
	}
	get flushCalled(): boolean {
		return this.flushCalls > 0;
	}
	get closeCalled(): boolean {
		return this.closeCalls > 0;
	}

	#output: VideoFrameOutputCallback;
	#error: WebCodecsErrorCallback;

	constructor(init: VideoDecoderInit) {
		this.#output = init.output;
		this.#error = init.error;
		FakeVideoDecoder.lastCreated = this;
	}

	configure(config: VideoDecoderConfig): void {
		this.configureCalls.push([config]);
		this.state = "configured";
	}

	decode(chunk: EncodedVideoChunk): void {
		if (this.state !== "configured") return;
		this.decodeCalls.push([chunk]);
		this.decodeQueueSize++;

		queueMicrotask(() => {
			this.decodeQueueSize--;
			const frame = new FakeVideoFrame(
				(this.configureCalls.at(-1)?.[0] as VideoDecoderConfig | undefined)?.codedWidth ??
					640,
				(this.configureCalls.at(-1)?.[0] as VideoDecoderConfig | undefined)?.codedHeight ??
					480,
				chunk.timestamp,
			);
			this.#output(frame);
		});
	}

	/** Trigger the error callback — useful for testing error handling paths. */
	triggerError(error: DOMException): void {
		this.#error(error);
	}

	reset(): void {
		this.resetCalls++;
		this.state = "unconfigured";
		this.decodeQueueSize = 0;
	}

	flush(): Promise<void> {
		this.flushCalls++;
		return new Promise<void>((resolve) => queueMicrotask(resolve));
	}

	close(): void {
		this.closeCalls++;
		this.state = "closed";
	}
}

import { FakeEncodedVideoChunk } from "./fake_encodedvideochunk_test.ts";

/**
 * FakeVideoEncoder for Deno test environments.
 *
 * Behaves like the real VideoEncoder:
 * - configure() sets state to "configured"
 * - encode(frame) queues a microtask that calls init.output() with a FakeEncodedVideoChunk
 * - close() sets state to "closed"
 * - reset() returns to "unconfigured"
 * - isConfigSupported() returns based on codec prefix
 *
 * Call tracking arrays allow test assertions without spy API:
 *   encoder.configureCalls[0]
 *   encoder.encodeCalls[0]
 */
export class FakeVideoEncoder {
	/** The most recently constructed FakeVideoEncoder instance. Useful for tests that capture the encoder. */
	static lastCreated: FakeVideoEncoder | null = null;

	/** Codec prefixes that FakeVideoEncoder reports as supported. */
	static readonly supportedCodecs = ["avc1", "vp8", "vp09", "av01"] as const;

	// State
	state: CodecState = "unconfigured";
	encodeQueueSize = 0;

	// Call tracking
	configureCalls: VideoEncoderConfig[] = [];
	encodeCalls: [VideoFrame, VideoEncoderEncodeOptions | undefined][] = [];
	flushCalls = 0;
	closeCalls = 0;
	resetCalls = 0;

	get configureCalled(): boolean {
		return this.configureCalls.length > 0;
	}
	get encodeCalled(): boolean {
		return this.encodeCalls.length > 0;
	}
	get closeCalled(): boolean {
		return this.closeCalls > 0;
	}

	#output: EncodedVideoChunkOutputCallback;
	#error: WebCodecsErrorCallback;

	constructor(init: VideoEncoderInit) {
		this.#output = init.output;
		this.#error = init.error;
		FakeVideoEncoder.lastCreated = this;
	}

	configure(config: VideoEncoderConfig): void {
		this.configureCalls.push(config);
		this.state = "configured";
	}

	encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void {
		if (this.state !== "configured") return;
		this.encodeCalls.push([frame, options]);
		this.encodeQueueSize++;

		queueMicrotask(() => {
			this.encodeQueueSize--;
			const chunk = new FakeEncodedVideoChunk(
				options?.keyFrame ? "key" : "delta",
				frame.timestamp,
				frame.duration ?? 33000,
			);
			this.#output(chunk, {});
		});
	}

	/** Trigger the error callback — useful for testing error handling paths. */
	triggerError(error: DOMException): void {
		this.#error(error);
	}

	async flush(): Promise<void> {
		this.flushCalls++;
		// Drain pending microtasks so output callbacks fire before flush resolves
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	}

	close(): void {
		this.closeCalls++;
		this.state = "closed";
	}

	reset(): void {
		this.resetCalls++;
		this.state = "unconfigured";
		this.encodeQueueSize = 0;
	}

	static async isConfigSupported(config: VideoEncoderConfig): Promise<VideoEncoderSupport> {
		const supported = FakeVideoEncoder.supportedCodecs.some(
			(prefix) => config.codec.startsWith(prefix),
		);
		return { supported, config: supported ? config : undefined };
	}
}

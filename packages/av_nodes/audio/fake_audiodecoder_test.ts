import { FakeAudioData } from "./fake_audiodata_test.ts";

/**
 * FakeAudioDecoder for Deno test environments.
 *
 * Behaves like the real AudioDecoder:
 * - configure() sets state to "configured"
 * - decode(chunk) queues a microtask that calls init.output() with a FakeAudioData
 * - close() sets state to "closed"
 *
 * Extends EventTarget so dequeue events work correctly for backpressure tests.
 */
export class FakeAudioDecoder extends EventTarget {
	static lastCreated: FakeAudioDecoder | null = null;

	state: CodecState = "unconfigured";
	decodeQueueSize = 0;

	configureCalls: AudioDecoderConfig[] = [];
	decodeCalls: EncodedAudioChunk[][] = [];
	flushCalls = 0;
	closeCalls = 0;

	get configureCalled(): boolean {
		return this.configureCalls.length > 0;
	}
	get decodeCalled(): boolean {
		return this.decodeCalls.length > 0;
	}
	get flushCalled(): boolean {
		return this.flushCalls > 0;
	}
	get closeCalled(): boolean {
		return this.closeCalls > 0;
	}

	#output: (data: AudioData) => void;
	#error: WebCodecsErrorCallback;

	constructor(init: AudioDecoderInit) {
		super();
		this.#output = init.output;
		this.#error = init.error;
		FakeAudioDecoder.lastCreated = this;
	}

	configure(config: AudioDecoderConfig): void {
		this.configureCalls.push(config);
		this.state = "configured";
	}

	decode(chunk: EncodedAudioChunk): void {
		if (this.state !== "configured") return;
		this.decodeCalls.push([chunk]);
		this.decodeQueueSize++;

		queueMicrotask(() => {
			this.decodeQueueSize--;
			this.dispatchEvent(new Event("dequeue"));
			const frame = new FakeAudioData(1024, 2, 44100, chunk.timestamp);
			this.#output(frame);
		});
	}

	triggerError(error: DOMException): void {
		this.#error(error);
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

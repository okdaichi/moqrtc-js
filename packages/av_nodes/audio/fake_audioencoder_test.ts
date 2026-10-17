/**
 * FakeAudioEncoder for Deno test environments.
 *
 * Behaves like the real AudioEncoder:
 * - configure() sets state to "configured", or throws configureError when set
 * - encode(data) queues a microtask that calls init.output() with a fake EncodedAudioChunk,
 *   or, with holdOutput set, keeps it queued until release()
 * - close() sets state to "closed"
 * - flush() resolves after pending output microtasks drain
 *
 * Instance call tracking (no spy API required):
 *   encoder.configureCalls[0]
 *   encoder.encodeCalls[0]
 *
 * Static isConfigSupported records calls and returns real-like support decisions.
 * Tests can override the static property temporarily for specific scenarios:
 *   const orig = FakeAudioEncoder.isConfigSupported;
 *   FakeAudioEncoder.isConfigSupported = async (_cfg) => ({ supported: false });
 *   try { ... } finally { FakeAudioEncoder.isConfigSupported = orig; }
 *
 * Static lastCreated lets tests retrieve the most recently constructed encoder:
 *   const enc = FakeAudioEncoder.lastCreated!;
 */
export class FakeAudioEncoder extends EventTarget {
	/** Most recently constructed instance — useful in tests where the encoder is created inside production code. */
	static lastCreated: FakeAudioEncoder | null = null;

	/** Codecs reported as supported. Override in tests as needed. */
	static supportedCodecs = ["opus", "mp4a.40.2", "isac", "g722", "pcmu", "pcma"] as const;

	/** Accumulates every config passed to isConfigSupported. Reset between tests. */
	static isConfigSupportedCalls: AudioEncoderConfig[] = [];

	/** Assignable property so tests can override without `as any`. Set to `undefined` to simulate missing method. */
	static isConfigSupported: ((config: AudioEncoderConfig) => Promise<unknown>) | undefined =
		async (config) => {
			FakeAudioEncoder.isConfigSupportedCalls.push(config);
			const supported = (FakeAudioEncoder.supportedCodecs as readonly string[]).some(
				(c) => config.codec.startsWith(c),
			);
			return { supported, config: supported ? config : undefined };
		};

	// --- Instance ---

	state: CodecState = "unconfigured";

	#encodeQueueSize = 0;
	get encodeQueueSize(): number {
		return this.#encodeQueueSize;
	}
	set encodeQueueSize(v: number) {
		this.#encodeQueueSize = v;
	}

	configureCalls: AudioEncoderConfig[] = [];
	encodeCalls: AudioData[] = [];
	closeCalls = 0;
	/** For each flush() call, how many frames had been passed to encode() before it. */
	flushedAfter: number[] = [];

	/** Thrown by configure() instead of configuring, when set. */
	configureError: Error | null = null;

	/** When true, encode() keeps each frame queued until release() lets it out. */
	holdOutput = false;
	#held: AudioData[] = [];

	get configureCalled(): boolean {
		return this.configureCalls.length > 0;
	}
	get encodeCalled(): boolean {
		return this.encodeCalls.length > 0;
	}
	get closeCalled(): boolean {
		return this.closeCalls > 0;
	}

	#output: EncodedAudioChunkOutputCallback;
	#error: WebCodecsErrorCallback;

	constructor(init: AudioEncoderInit) {
		super();
		this.#output = init.output;
		this.#error = init.error;
		FakeAudioEncoder.lastCreated = this;
	}

	configure(config: AudioEncoderConfig): void {
		this.configureCalls.push(config);
		if (this.configureError !== null) throw this.configureError;
		this.state = "configured";
	}

	encode(data: AudioData): void {
		this.encodeCalls.push(data);
		this.#encodeQueueSize++;

		if (this.holdOutput) {
			this.#held.push(data);
			return;
		}
		queueMicrotask(() => this.#dequeue(data));
	}

	/** Lets the frames held by holdOutput out of the queue, oldest first. */
	release(): void {
		for (const data of this.#held.splice(0)) this.#dequeue(data);
	}

	#dequeue(data: AudioData): void {
		this.#encodeQueueSize--;
		this.dispatchEvent(new Event("dequeue"));
		const chunk = {
			type: "key" as EncodedAudioChunkType,
			timestamp: data.timestamp,
			duration: data.duration ?? null,
			byteLength: 1024,
			copyTo: (_dest: AllowSharedBufferSource) => {},
		} as EncodedAudioChunk;
		this.#output(chunk);
	}

	close(): void {
		this.closeCalls++;
		this.state = "closed";
	}

	async flush(): Promise<void> {
		this.flushedAfter.push(this.encodeCalls.length);
		if (this.state !== "configured") {
			throw new DOMException(
				"Failed to execute 'flush' on 'AudioEncoder': Cannot call 'flush' on an unconfigured codec.",
				"InvalidStateError",
			);
		}
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	}

	/** Trigger the error callback — useful for testing error handling paths. */
	triggerError(error: DOMException): void {
		this.#error(error);
	}
}

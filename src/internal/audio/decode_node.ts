import {
    importWorkletUrl as importOffloadWorkletUrl,
    workletName as offloadWorkletName,
} from "./audio_offload_worklet.ts";

const MAX_DECODE_QUEUE_SIZE = 3;

export class AudioDecodeNode implements AudioNode {
	#decoder: AudioDecoder;
	context: AudioContext;
	#worklet?: AudioWorkletNode;
	#disposed = false;

	constructor(context: AudioContext, init: { latency?: number } = {}) {
		this.context = context;

		context.audioWorklet.addModule(importOffloadWorkletUrl()).then(() => {
			// Create AudioWorkletNode
			this.#worklet = new AudioWorkletNode(
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
		}).catch((error) => {
			console.error("[AudioDecodeNode] failed to load AudioWorklet module:", error);
		});

		this.#decoder = new AudioDecoder({
			output: async (frame) => {
				// Pass audio frame to processing
				this.process(frame);

				// Close the decoded frame after processing
				frame.close();
			},
			error: (e) => {
				console.error("[AudioDecodeNode] decoder error:", e);
			},
		});
	}

	// Implement missing AudioNode methods
	disconnect(): void;
	disconnect(output: number): void;
	disconnect(destinationNode: AudioNode): void;
	disconnect(destinationNode: AudioNode, output: number): void;
	disconnect(destinationNode: AudioNode, output: number, input: number): void;
	disconnect(destinationParam: AudioParam): void;
	disconnect(destinationParam: AudioParam, output: number): void;
	disconnect(
		destinationOrOutput?: number | AudioNode | AudioParam,
		output?: number,
		input?: number,
	): void {
		if (arguments.length === 0) {
			this.#worklet?.disconnect();
		} else if (typeof destinationOrOutput === "number") {
			this.#worklet?.disconnect(destinationOrOutput);
		} else if (
			typeof window !== "undefined" &&
			typeof AudioNode !== "undefined" &&
			destinationOrOutput instanceof AudioNode
		) {
			if (output !== undefined && input !== undefined) {
				this.#worklet?.disconnect(destinationOrOutput, output, input);
			} else if (output !== undefined) {
				this.#worklet?.disconnect(destinationOrOutput, output);
			} else {
				this.#worklet?.disconnect(destinationOrOutput);
			}
		} else if (
			typeof globalThis !== "undefined" &&
			typeof AudioParam !== "undefined" &&
			destinationOrOutput instanceof AudioParam
		) {
			if (output !== undefined) {
				this.#worklet?.disconnect(destinationOrOutput, output);
			} else {
				this.#worklet?.disconnect(destinationOrOutput);
			}
		} else {
			this.#worklet?.disconnect();
		}
	}

	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): void {
		this.#worklet?.addEventListener(type, listener, options);
	}

	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions,
	): void {
		this.#worklet?.removeEventListener(type, listener, options);
	}

	dispatchEvent(event: Event): boolean {
		return this.#worklet?.dispatchEvent(event) || false;
	}

	get numberOfInputs(): number {
		return this.#worklet?.numberOfInputs || 1;
	}

	get numberOfOutputs(): number {
		return this.#worklet?.numberOfOutputs || 1;
	}

	get channelCount(): number {
		return this.#worklet?.channelCount || 1;
	}

	get channelCountMode(): ChannelCountMode {
		return "explicit";
	}

	get channelInterpretation(): ChannelInterpretation {
		return "speakers";
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

	connect(destinationNode: AudioNode, output?: number, input?: number): AudioNode;
	connect(destinationParam: AudioParam, output?: number): void;
	connect(
		destination: AudioNode | AudioParam,
		output?: number,
		input?: number,
	): AudioNode | void {
		if (
			(globalThis.AudioNode && destination instanceof globalThis.AudioNode) ||
			(typeof AudioNode !== "undefined" && destination instanceof AudioNode)
		) {
			// Connect to another AudioNode
			this.#worklet?.connect(destination, output, input);
			return destination as AudioNode;
		} else if (
			(globalThis.AudioParam && destination instanceof globalThis.AudioParam) ||
			(typeof AudioParam !== "undefined" && destination instanceof AudioParam)
		) {
			// Connect to an AudioParam
			this.#worklet?.connect(destination, output);
			return;
		} else {
			throw new TypeError("Invalid destination for connect()");
		}
	}

	configure(config: AudioDecoderConfig): void {
		this.#decoder.configure(config);
	}

	async decodeFrom(stream: ReadableStream<EncodedAudioChunk>): Promise<void> {
		try {
			const reader = stream.getReader();

			const { done, value: chunk } = await reader.read();
			if (done) {
				reader.releaseLock();
				return;
			}

			// Backpressure: Drop chunk if queue is overloaded
			if (this.decodeQueueSize > MAX_DECODE_QUEUE_SIZE) {
				console.warn(`[AudioDecodeNode] Dropping chunk, queue size: ${this.decodeQueueSize}`);
				return;
			}

			this.#decoder.decode(chunk);
		} catch (e) {
			console.error("[AudioDecodeNode] decodeFrom error:", e);
		}
	}

	process(input: AudioData): void {
		if (this.#disposed) return;

		// Ownership: Caller (decoder callback) owns input
		// No longer drops frames when muted; gain handles silence for continuity.
		const channels: Float32Array[] = [];
		for (let i = 0; i < input.numberOfChannels; i++) {
			const data = new Float32Array(input.numberOfFrames);
			input.copyTo(data, { format: "f32-planar", planeIndex: i });
			channels.push(data);
		}

		// Send AudioData to the worklet
		// Ownership: Transfer buffer ownership to worklet
		this.#worklet?.port.postMessage(
			{
				channels: channels,
				timestamp: input.timestamp,
			},
			channels.map((d) => d.buffer), // Transfer ownership of the buffers
		);
	}

	async flush(): Promise<void> {
		try {
			await this.#decoder.flush();
		} catch (e) {
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

		// Flush and close decoder
		try {
			this.#decoder.flush();
		} catch (_) {
			/* ignore */
		}

		try {
			this.#decoder.close();
		} catch (_) {
			/* ignore */
		}

		// Disconnect worklet
		if (this.#worklet) {
			try {
				this.#worklet.disconnect();
			} catch (_) {
				/* ignore */
			}
		}
	}
}
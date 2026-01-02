// Audio node API: AudioNode, AudioEncodeNode, AudioDecodeNode
// Based on VideoEncodeNode and VideoDecodeNode patterns
// Uses Web Audio API AudioEncoder/AudioDecoder for encoding/decoding
import {
	importWorkletUrl as importHijackWorkletUrl,
	workletName as hijackWorkletName,
} from "./audio_hijack_worklet.ts";

// Backpressure management: Maximum queue size before dropping frames
const MAX_ENCODE_QUEUE_SIZE = 2;

export class AudioEncodeNode implements AudioNode {
	#encoder: AudioEncoder;
	context: AudioContext;
	#worklet?: AudioWorkletNode;
	#disposed = false;

	#dests: Set<AudioEncodeDestination> = new Set();

	// Event listeners storage
	#eventListeners: Map<string, Set<EventListenerOrEventListenerObject>> = new Map();

	constructor(context: AudioContext) {
		this.context = context;

		this.#encoder = new AudioEncoder({
			output: async (chunk) => {
				// Use allSettled to ensure one destination error doesn't affect others
				await Promise.allSettled(
					Array.from(this.#dests, (dest) => dest.output(chunk)),
				);
			},
			error: (e) => {
				console.error("[AudioEncodeNode] encoder error:", e);
			},
		});

		const readable = new ReadableStream<AudioData>({
			start: async (controller) => {
				await context.audioWorklet.addModule(importHijackWorkletUrl());

				const worklet = new AudioWorkletNode(
					context,
					hijackWorkletName,
					{
						numberOfInputs: 1,
						numberOfOutputs: 0,
						channelCount: context.destination.channelCount,
						processorOptions: {
							sampleRate: context.sampleRate,
							targetChannels: context.destination.channelCount || 1,
						},
					},
				);
				this.#worklet = worklet;

				worklet.port.onmessage = ({ data }: { data: AudioDataInit }) => {
					const frame = new AudioData(data);
					controller.enqueue(frame);
				};
			},
			cancel() {
				// TODO: Clean up worklet if needed
			},
		});

		queueMicrotask(() => this.#next(readable.getReader()));
	}

	// Dummy AudioNode methods for interface compatibility
	connect(destinationNode: AudioNode, output?: number, input?: number): AudioNode;
	connect(destinationParam: AudioParam, output?: number): void;
	connect(
		_destination: AudioNode | AudioParam,
		_output?: number,
		_input?: number,
	): AudioNode | void {
		// This node does not output audio to the graph, so connections are not supported
		throw new Error("AudioEncodeNode does not support connections as it does not output audio");
	}

	disconnect(): void;
	disconnect(output: number): void;
	disconnect(destinationNode: AudioNode): void;
	disconnect(destinationNode: AudioNode, output: number): void;
	disconnect(destinationNode: AudioNode, output: number, input: number): void;
	disconnect(destinationParam: AudioParam): void;
	disconnect(destinationParam: AudioParam, output: number): void;
	disconnect(
		_destinationOrOutput?: number | AudioNode | AudioParam,
		_output?: number,
		_input?: number,
	): void {
		// No-op
	}

	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		_options?: boolean | AddEventListenerOptions,
	): void {
		if (!this.#eventListeners.has(type)) {
			this.#eventListeners.set(type, new Set());
		}
		this.#eventListeners.get(type)!.add(listener);
	}

	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		_options?: boolean | EventListenerOptions,
	): void {
		const listeners = this.#eventListeners.get(type);
		if (listeners) {
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.#eventListeners.delete(type);
			}
		}
	}

	dispatchEvent(event: Event): boolean {
		const listeners = this.#eventListeners.get(event.type);
		if (listeners) {
			for (const listener of listeners) {
				if (typeof listener === "function") {
					listener(event);
				} else {
					listener.handleEvent(event);
				}
			}
		}
		return !event.defaultPrevented;
	}

	configure(config: AudioEncoderConfig): void {
		this.#encoder.configure(config);
	}

	async #next(stream: ReadableStreamDefaultReader<AudioData>): Promise<void> {
		const { done, value } = await stream.read();
		if (done) {
			stream.releaseLock();
			return;
		}

		// Backpressure: Drop frame if queue is overloaded
		if (this.encodeQueueSize > MAX_ENCODE_QUEUE_SIZE) {
			console.warn(`[AudioEncodeNode] Dropping frame, queue size: ${this.encodeQueueSize}`);
			queueMicrotask(() => this.#next(stream));
			return;
		}

		// Ownership: Stream owns value, so we clone for our use
		const clonedData = value.clone();

		try {
			this.#encoder.encode(clonedData);
		} catch (e) {
			console.error("[AudioEncodeNode] encode error:", e);
		}

		// Ownership: We own the clone, so we close it
		clonedData.close();

		queueMicrotask(() => this.#next(stream));
	}

	process(input: AudioData): void {
		if (this.#disposed) return;

		// Backpressure: Drop frame if queue is overloaded
		if (this.encodeQueueSize > MAX_ENCODE_QUEUE_SIZE) {
			console.warn(`[AudioEncodeNode] Dropping frame, queue size: ${this.encodeQueueSize}`);
			return; // Drop frame without encoding
		}

		// Ownership: Caller owns input, so we clone for our use
		const clonedData = input.clone();

		// Encode the audio data
		try {
			this.#encoder.encode(clonedData);
		} catch (e) {
			console.error("[AudioEncodeNode] encode error:", e);
		}

		// Ownership: We own the clone, so we close it
		clonedData.close();
	}

	async close(): Promise<void> {
		try {
			this.#encoder.close();
		} catch (_) {
			/* ignore */
		}
	}

	// Unified disposal pattern following video pattern
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;

		// Clean up encoder
		try {
			this.#encoder.close();
		} catch (_) {
			/* ignore */
		}

		// Clean up worklet
		if (this.#worklet) {
			try {
				this.#worklet.disconnect();
			} catch (_) {
				/* ignore */
			}
		}

		// Clear destinations
		this.#dests.clear();
		this.#eventListeners.clear();
	}

	// Implement required AudioNode properties for compatibility
	get channelCount(): number {
		return this.#worklet?.channelCount || 1;
	}

	get channelCountMode(): ChannelCountMode {
		return this.#worklet?.channelCountMode || "explicit";
	}

	get channelInterpretation(): ChannelInterpretation {
		return this.#worklet?.channelInterpretation || "speakers";
	}

	get numberOfInputs(): number {
		return this.#worklet?.numberOfInputs || 1;
	}

	get numberOfOutputs(): number {
		return this.#worklet?.numberOfOutputs || 0;
	}

	// Codec state monitoring
	get encoderState(): CodecState {
		return this.#encoder.state;
	}

	// Queue size monitoring for backpressure management
	get encodeQueueSize(): number {
		try {
			return this.#encoder.encodeQueueSize;
		} catch (_) {
			return 0; // Graceful fallback if encoder not ready
		}
	}

	encodeTo(dest: AudioEncodeDestination): { done: Promise<void> } {
		this.#dests.add(dest);

		const done = dest.done.finally(() => {
			this.#dests.delete(dest);
		});

		return { done };
	}
}

export interface AudioEncodeDestination {
	output: (chunk: EncodedAudioChunk) => Promise<Error | undefined>;
	done: Promise<void>;
}

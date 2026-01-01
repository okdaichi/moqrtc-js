// Video node API: VideoContext, VideoNode, VideoSourceNode, VideoEncodeNode, VideoSender
// Based on Web Audio API structure: https://developer.mozilla.org/en-US/docs/Web/API/AudioNode
// https://developer.mozilla.org/en-US/docs/Web/API/AudioContext
// https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode

export abstract class VideoNode {
	readonly numberOfInputs: number;
	readonly numberOfOutputs: number;
	#inputs: Set<VideoNode> = new Set();
	#outputs: Set<VideoNode> = new Set();
	#disposed: boolean = false;

	constructor(
		options?: { numberOfInputs?: number; numberOfOutputs?: number },
	) {
		this.numberOfInputs = options?.numberOfInputs ?? 1;
		this.numberOfOutputs = options?.numberOfOutputs ?? 1;
	}

	/** Connected input nodes (read-only view) */
	get inputs(): ReadonlySet<VideoNode> {
		return this.#inputs;
	}

	/** Connected output nodes (read-only view) */
	get outputs(): ReadonlySet<VideoNode> {
		return this.#outputs;
	}

	/** Whether this node has been disposed */
	get disposed(): boolean {
		return this.#disposed;
	}

	connect(destination: VideoNode): VideoNode {
		if (this.#disposed) {
			console.warn("[VideoNode] Cannot connect: node is disposed");
			return destination;
		}
		if (destination === this) return destination;
		this.#outputs.add(destination);
		destination.#inputs.add(this);
		return destination;
	}

	disconnect(destination?: VideoNode): void {
		if (destination) {
			this.#outputs.delete(destination);
			destination.#inputs.delete(this);
		} else {
			for (const output of this.#outputs) {
				this.#outputs.delete(output);
				output.#inputs.delete(this);
			}
		}
	}

	abstract process(input?: VideoFrame): void;

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.disconnect();
	}
}












// Loading a worklet module into an audio context, and stopping its processors.
import type { StopMessage } from "./audio_worklet_protocol.ts";

/** What loading a worklet module needs of an audio context. */
export interface AudioWorkletHost {
	readonly audioWorklet: { addModule(moduleUrl: string): Promise<void> };
}

/** What stopping a processor needs of its node. */
export interface ProcessorNode {
	readonly port: {
		postMessage(message: StopMessage): void;
		close(): void;
	};
	disconnect(): void;
}

const STOP: StopMessage = { type: "stop" };

/**
 * A worklet module given as source code. It is added to each context once,
 * however many nodes use it there, from one Blob URL made when it is first
 * needed.
 */
export class AudioWorkletModule {
	readonly #code: string;
	#url: string | null = null;
	readonly #loads = new WeakMap<AudioWorkletHost, Promise<void>>();

	constructor(code: string) {
		this.#code = code;
	}

	/**
	 * Adds the module to `context`, or returns the load already started there.
	 * A load that fails is started again by the next call.
	 */
	load(context: AudioWorkletHost): Promise<void> {
		const loading = this.#loads.get(context);
		if (loading !== undefined) return loading;
		this.#url ??= URL.createObjectURL(
			new Blob([this.#code], { type: "application/javascript" }),
		);
		const load = context.audioWorklet.addModule(this.#url).catch((e: unknown) => {
			this.#loads.delete(context);
			throw e;
		});
		this.#loads.set(context, load);
		return load;
	}
}

/**
 * Tells `node`'s processor to stop, then closes the node's port and takes it
 * out of the graph.
 */
export function stopProcessor(node: ProcessorNode): void {
	try {
		node.port.postMessage(STOP);
	} catch (_) {
		// reason: a port that cannot be posted to has no processor left to stop.
	}
	node.port.close();
	node.disconnect();
}

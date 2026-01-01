import { VideoDestinationNode } from "./destination_node.ts";
import type { VideoNode } from "./video_node.ts";

export type VideoContextState = "running" | "suspended" | "closed";
export type VideoContextStateChangeCallback = (
	state: VideoContextState,
) => void;

export class VideoContext {
	readonly frameRate: number;
	readonly destination: VideoDestinationNode;
	#nodes: Set<VideoNode> = new Set();
	#state: VideoContextState = "running";
	#currentTime: number = 0;
	#startTime: number = 0;
	#pausedTime: number = 0;
	#onstatechange?: VideoContextStateChangeCallback;

	constructor(options?: { frameRate?: number; canvas?: HTMLCanvasElement }) {
		this.frameRate = options?.frameRate ?? 30;
		this.#startTime = performance.now() / 1000;

		this.destination = new VideoDestinationNode(
			this,
			options?.canvas ?? document.createElement("canvas"),
		);
	}

	get state(): VideoContextState {
		return this.#state;
	}

	get currentTime(): number {
		if (this.#state === "running") {
			return performance.now() / 1000 - this.#startTime -
				this.#pausedTime;
		}
		return this.#currentTime;
	}

	get onstatechange(): VideoContextStateChangeCallback | undefined {
		return this.#onstatechange;
	}

	set onstatechange(callback: VideoContextStateChangeCallback | undefined) {
		this.#onstatechange = callback;
	}

	/** @internal */
	_register(node: VideoNode): void {
		this.#nodes.add(node);
	}

	/** @internal */
	_unregister(node: VideoNode): void {
		this.#nodes.delete(node);
	}

	#setState(newState: VideoContextState): void {
		const oldState = this.#state;
		if (oldState === newState) return;
		this.#state = newState;
		try {
			this.#onstatechange?.(newState);
		} catch (e) {
			console.error("[VideoContext] onstatechange error:", e);
		}
	}

	resume(): Promise<void> {
		if (this.#state === "closed") return Promise.resolve();
		if (this.#state === "suspended") {
			// Adjust for paused duration
			this.#pausedTime += performance.now() / 1000 - this.#currentTime -
				this.#startTime;
		}
		this.#setState("running");
		return Promise.resolve();
	}

	suspend(): Promise<void> {
		if (this.#state === "closed") return Promise.resolve();
		if (this.#state === "running") {
			// Store current time when suspending
			this.#currentTime = this.currentTime;
		}
		this.#setState("suspended");
		return Promise.resolve();
	}

	close(): Promise<void> {
		if (this.#state === "closed") return Promise.resolve();
		this.#setState("closed");

		// Dispose all registered nodes
		for (const node of this.#nodes) {
			try {
				node.dispose();
			} catch (_) {
				/* ignore */
			}
		}

		this.#nodes.clear();
		return Promise.resolve();
	}
}
import { VideoDestinationNode } from "./destination_node.ts";
import type { VideoNode } from "./video_node.ts";

export type VideoContextState = "running" | "suspended" | "closed";
export type VideoContextStateChangeCallback = (
	state: VideoContextState,
) => void;

export class VideoContext {
	readonly frameRate: number;
	readonly destination: VideoDestinationNode;
	readonly baseTimestamp: number; // μs - VideoFrame timestamp base
	readonly startTime: number; // performance.now() at creation
	#nodes: Set<VideoNode> = new Set();
	#state: VideoContextState = "running";
	#currentTime: number = 0;
	#pausedTime: number = 0;
	#suspendTime: number = 0; // performance.now() when suspended
	#nextFrameTime: number = 0; // For frame pacing
	#onstatechange?: VideoContextStateChangeCallback;

	constructor(options?: { frameRate?: number; canvas?: HTMLCanvasElement }) {
		this.frameRate = options?.frameRate ?? 30;
		this.startTime = performance.now();
		this.baseTimestamp = 0; // μs origin point

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
			return (performance.now() - this.startTime) / 1000 - this.#pausedTime;
		}
		return this.#currentTime;
	}

	/**
	 * Current timestamp in microseconds (μs) - for VideoFrame compatibility
	 * This is the single source of truth for all video timestamps in this context
	 */
	get currentTimestamp(): number {
		return this.baseTimestamp + this.currentTime * 1_000_000;
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

	/**
	 * Wait for next frame timing (frame pacing)
	 * This ensures consistent frame rate regardless of source
	 * Similar to sample-accurate clock in AudioContext
	 * @internal
	 */
	async _waitNextFrame(): Promise<number> {
		if (this.#state !== "running") {
			return this.currentTimestamp;
		}

		const intervalMs = 1000 / this.frameRate;

		// Initialize next frame time on first call
		if (this.#nextFrameTime === 0) {
			this.#nextFrameTime = performance.now();
		}

		this.#nextFrameTime += intervalMs;

		const delay = this.#nextFrameTime - performance.now();
		if (delay > 0) {
			await new Promise((resolve) => setTimeout(resolve, delay));
		}

		return this.currentTimestamp;
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
			// Add the suspended duration to pausedTime
			const suspendedDuration = (performance.now() - this.#suspendTime) / 1000;
			this.#pausedTime += suspendedDuration;
			// Reset frame timing for fresh start
			this.#nextFrameTime = 0;
		}
		this.#setState("running");
		return Promise.resolve();
	}

	suspend(): Promise<void> {
		if (this.#state === "closed") return Promise.resolve();
		if (this.#state === "running") {
			// Store current logical time and real time when suspending
			this.#currentTime = this.currentTime;
			this.#suspendTime = performance.now();
			// Reset frame timing for next resume
			this.#nextFrameTime = 0;
		}
		this.#setState("suspended");
		return Promise.resolve();
	}

	close(): Promise<void> {
		if (this.#state === "closed") return Promise.resolve();
		this.#setState("closed");

		// Reset frame timing
		this.#nextFrameTime = 0;

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

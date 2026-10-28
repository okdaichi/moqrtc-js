import type { CanvasLike } from "./destination_node.ts";
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
	#nextFrameTime: number = Number.NEGATIVE_INFINITY; // For frame pacing (ms)
	#onstatechange?: VideoContextStateChangeCallback;

	constructor(options?: { frameRate?: number; canvas?: CanvasLike }) {
		this.frameRate = options?.frameRate ?? 30;
		this.startTime = performance.now();
		this.baseTimestamp = 0; // μs origin point

		this.destination = new VideoDestinationNode(
			this,
			options?.canvas ??
				(typeof document !== "undefined" ? document.createElement("canvas") : {
					width: 0,
					height: 0,
					getContext: () => null,
				}),
		);
	}

	get state(): VideoContextState {
		return this.#state;
	}

	get currentTime(): number {
		if (this.#state === "running") {
			return (performance.now() - this.startTime) / 1000 -
				this.#pausedTime;
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
	 * Frame pacing: whether a frame read at `now` (ms, performance.now()) should
	 * pass, holding the stream to `frameRate`.
	 *
	 * Sources are read as their frames arrive, not on a timer: a timer wakes a
	 * few ms late, and a source that runs ahead of it queues frames, so the
	 * frame a timer reads can be hundreds of ms old. Half a frame of slack lets
	 * a jittery source keep its own rate; over time it averages `frameRate`, so
	 * a faster source is thinned to it.
	 * @internal
	 */
	_admitFrame(now: number = performance.now()): boolean {
		if (this.#state !== "running") return false;
		const intervalMs = 1000 / this.frameRate;
		if (now + intervalMs / 2 < this.#nextFrameTime) return false;
		this.#nextFrameTime = Math.max(this.#nextFrameTime, now - intervalMs / 2) + intervalMs;
		return true;
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
			const suspendedDuration = (performance.now() - this.#suspendTime) /
				1000;
			this.#pausedTime += suspendedDuration;
			// Reset frame timing for fresh start
			this.#nextFrameTime = Number.NEGATIVE_INFINITY;
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
			this.#nextFrameTime = Number.NEGATIVE_INFINITY;
		}
		this.#setState("suspended");
		return Promise.resolve();
	}

	close(): Promise<void> {
		if (this.#state === "closed") return Promise.resolve();
		this.#setState("closed");

		// Reset frame timing
		this.#nextFrameTime = Number.NEGATIVE_INFINITY;

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

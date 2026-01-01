import type { VideoContext } from "./context.ts";
import { VideoNode } from "./video_node.ts";

export class VideoObserveNode extends VideoNode {
	readonly context: VideoContext;
	#observer?: IntersectionObserver;
	#isVisible: boolean = true;

	constructor(
		context: VideoContext,
		options?: { threshold?: number; enableBackground?: boolean },
	) {
		super({ numberOfInputs: 1, numberOfOutputs: 1 });
		this.context = context;
		const threshold = options?.threshold ?? 0.01;
		const enableBackground = options?.enableBackground ?? false;

		if (!enableBackground) {
			this.#observer = new IntersectionObserver(
				(entries) => {
					const entry = entries[0];
					if (entry) {
						this.#isVisible = entry.isIntersecting;
					}
				},
				{ threshold },
			);
		} else {
			this.#isVisible = true;
		}

		this.context._register(this);
	}

	observe(element: Element): void {
		this.#observer?.observe(element);
	}

	unobserve(element: Element): void {
		this.#observer?.unobserve(element);
	}

	get isVisible(): boolean {
		return this.#isVisible;
	}

	process(input: VideoFrame): void {
		if (this.disposed) {
			return;
		}

		// Only pass to next nodes if visible
		if (!this.#isVisible) {
			return;
		}

		const clonedFrame = input.clone();
		for (const output of Array.from(this.outputs)) {
			try {
				void output.process(clonedFrame);
			} catch (e) {
				console.error("[VideoObserveNode] process error:", e);
			}
		}

		clonedFrame.close();
	}

	override dispose(): void {
		if (this.disposed) return;
		this.#observer?.disconnect();
		this.context._unregister(this);
		super.dispose();
	}
}

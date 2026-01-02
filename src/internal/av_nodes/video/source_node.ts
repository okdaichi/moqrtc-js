import { VideoContext } from "./context.ts";
import { VideoNode } from "./video_node.ts";

export class VideoSourceNode extends VideoNode {
	readonly context: VideoContext;
	#stream: ReadableStream<VideoFrame>;
	#running: boolean = false;
	#reader?: ReadableStreamDefaultReader<VideoFrame>;

	constructor(context: VideoContext, stream: ReadableStream<VideoFrame>) {
		super({ numberOfInputs: 0, numberOfOutputs: 1 });
		this.context = context;
		this.#stream = stream;
		this.context._register(this);
	}

	get running(): boolean {
		return this.#running;
	}

	process(input: VideoFrame): void {
		if (this.disposed) return;

		// Ownership: Caller owns input, outputs will clone if needed
		for (const output of this.outputs) {
			try {
				output.process(input);
			} catch (e) {
				// Handle case where frame is already closed or clone fails
				if (e instanceof DOMException && e.name === "InvalidStateError") {
					console.warn("[VideoSourceNode] Cannot clone closed frame");
				} else {
					console.error("[VideoSourceNode] process error:", e);
				}
			}
		}
	}

	start(): { done: Promise<void> } {
		const done = (async () => {
			if (this.#running || this.disposed) return;
			this.#running = true;

			try {
				this.#reader = this.#stream.getReader();

				while (this.#running && this.context.state === "running") {
					const { done, value: frame } = await this.#reader.read();
					if (done) break;

					// Pass frame to outputs (they will clone if needed)
					this.process(frame);

					// Ownership: We own the frame from stream, so we close it
					frame.close();
				}
			} catch (e) {
				console.error("[VideoSourceNode] read error:", e);
			} finally {
				this.#running = false;
				this.#releaseReader();
			}
		})();

		return { done };
	}

	stop(): void {
		this.#running = false;
		this.#releaseReader(); // Release reader immediately
	}

	#releaseReader(): void {
		if (this.#reader) {
			try {
				this.#reader.releaseLock();
			} catch (_) {
				/* ignore */
			}
		}
	}

	override dispose(): void {
		if (this.disposed) return;
		this.stop();
		this.#releaseReader(); // Release reader immediately
		this.#reader = undefined; // Clear reader reference
		this.context._unregister(this);
		super.dispose();
	}
}

export class MediaStreamVideoSourceNode extends VideoSourceNode {
	readonly track: MediaStreamTrack;
	#stream: ReadableStream<VideoFrame>;

	constructor(track: MediaStreamTrack, context?: VideoContext) {
		const settings = track.getSettings();
		const frameRate = settings?.frameRate ?? 30;

		// Use provided context or create new one
		const videoContext = context ?? new VideoContext({ frameRate });

		let stream: ReadableStream<VideoFrame>;

		if ("MediaStreamTrackProcessor" in globalThis) {
			// deno-lint-ignore no-explicit-any
			stream = new (globalThis as any).MediaStreamTrackProcessor({ track }).readable;
		} else {
			console.warn(
				"[MediaStreamVideoSourceNode] MediaStreamTrackProcessor not available; using polyfill",
			);

			if (!settings) {
				throw new Error("[MediaStreamVideoSourceNode] track has no settings");
			}

			const video = document.createElement("video");
			let lastTimestamp: DOMHighResTimeStamp = performance.now();

			stream = new ReadableStream<VideoFrame>({
				async start() {
					video.srcObject = new MediaStream([track]);
					await Promise.all([
						video.play(),
						new Promise<void>((resolve) => {
							video.onloadedmetadata = () => resolve();
						}),
					]);
					lastTimestamp = performance.now();
				},
				async pull(controller) {
					const frameInterval = 1000 / frameRate;
					while (performance.now() - lastTimestamp < frameInterval) {
						await new Promise((resolve) => requestAnimationFrame(resolve));
					}
					lastTimestamp = performance.now();
					controller.enqueue(
						new VideoFrame(video, {
							timestamp: lastTimestamp * 1000,
						}),
					);
				},
				cancel() {
					video.srcObject = null;
				},
			});
		}

		super(videoContext, stream);
		this.track = track;
		this.#stream = stream;
	}

	override dispose(): void {
		if (this.disposed) return;
		this.stop();
		this.track.stop();
		try {
			void this.#stream.cancel();
		} catch (_) {
			/* ignore */
		}
		super.dispose();
	}
}

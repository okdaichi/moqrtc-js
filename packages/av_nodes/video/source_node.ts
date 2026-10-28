import type { VideoContext } from "./context.ts";
import { VideoNode } from "./video_node.ts";

/** MediaStreamTrackProcessor is not yet in lib.dom.d.ts. */
interface MediaStreamTrackProcessorInit {
	track: MediaStreamTrack;
}
interface MediaStreamTrackProcessorLike {
	readable: ReadableStream<VideoFrame>;
}

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
				if (
					e instanceof DOMException && e.name === "InvalidStateError"
				) {
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
					// Frames are read as they arrive; the context's pacing decides
					// which pass (see VideoContext._admitFrame).
					const { done, value: frame } = await this.#reader.read();
					if (done) break;

					try {
						// Stopped while waiting, or ahead of the frame rate: dropped
						// (the finally closes it).
						if (!this.#running || !this.context._admitFrame()) continue;

						// Create new frame with context's timestamp (single source of truth)
						const retimedFrame = new VideoFrame(frame, {
							timestamp: this.context.currentTimestamp, // context's μs timestamp
						});

						// Pass retimedFrame to outputs (they will clone if needed)
						this.process(retimedFrame);

						// Ownership: We own the retimedFrame, so we close it
						retimedFrame.close();
					} finally {
						// Close the original frame on every path — if the VideoFrame
						// constructor throws (unsupported format / closed source
						// frame) it would otherwise leak.
						frame.close();
					}
				}
			} catch (e) {
				// Ignore expected errors during shutdown
				if (!this.#running || this.disposed) return;
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

	constructor(context: VideoContext, options: { mediaStream: MediaStream }) {
		const { mediaStream } = options;
		const track = mediaStream.getVideoTracks()[0];
		if (!track) {
			throw new Error(
				"[MediaStreamVideoSourceNode] No video track in MediaStream",
			);
		}

		let stream: ReadableStream<VideoFrame>;

		if ("MediaStreamTrackProcessor" in globalThis) {
			const Ctor = (globalThis as unknown as {
				MediaStreamTrackProcessor: new (
					init: MediaStreamTrackProcessorInit,
				) => MediaStreamTrackProcessorLike;
			}).MediaStreamTrackProcessor;
			stream = new Ctor({ track }).readable;
		} else {
			console.warn(
				"[MediaStreamVideoSourceNode] MediaStreamTrackProcessor not available; using polyfill",
			);

			const video = document.createElement("video");

			stream = new ReadableStream<VideoFrame>({
				async start() {
					video.srcObject = new MediaStream([track]);
					await Promise.all([
						video.play(),
						new Promise<void>((resolve) => {
							video.onloadedmetadata = () => resolve();
						}),
					]);
				},
				async pull(controller) {
					// VideoSourceNode.start() reads frames as they come, so this
					// stream paces itself: one frame per frame the video presents,
					// or per frame interval where requestVideoFrameCallback is
					// missing. The context's pacing still caps the rate.
					await new Promise<void>((resolve) => {
						if (typeof video.requestVideoFrameCallback === "function") {
							video.requestVideoFrameCallback(() => resolve());
						} else {
							setTimeout(resolve, 1000 / context.frameRate);
						}
					});
					controller.enqueue(
						new VideoFrame(video, {
							timestamp: context.currentTimestamp, // μs from context
						}),
					);
				},
				cancel() {
					video.srcObject = null;
				},
			});
		}

		super(context, stream);
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

declare const MediaStreamTrackProcessor: {
	new (
		options: { track: MediaStreamTrack },
	): { readable: ReadableStream<VideoFrame> };
};

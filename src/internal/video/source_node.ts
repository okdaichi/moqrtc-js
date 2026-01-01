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

    /** @internal Accessor for subclasses */
    protected get _stream(): ReadableStream<VideoFrame> {
        return this.#stream;
    }

    get running(): boolean {
        return this.#running;
    }

    process(input: VideoFrame): void {
        if (this.disposed) return;

        // Pass the same cloned frame to all outputs (they will clone it themselves)
        for (const output of Array.from(this.outputs)) {
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

    async start(): Promise<void> {
        if (this.#running || this.disposed) return;
        this.#running = true;

        try {
            this.#reader = this.#stream.getReader();

            while (this.#running && this.context.state === "running") {
                const { done, value: frame } = await this.#reader.read();
                if (done) break;
                this.process(frame);

                frame.close();
            }
        } catch (e) {
            console.error("[VideoSourceNode] read error:", e);
        } finally {
            this.#running = false;
            this.#releaseReader();
        }
    }

    stop(): void {
        this.#running = false;
    }

    #releaseReader(): void {
        if (this.#reader) {
            try {
                this.#reader.releaseLock();
            } catch (_) {
                /* ignore */
            }
            this.#reader = undefined;
        }
    }

    override dispose(): void {
        if (this.disposed) return;
        this.stop();
        this.#releaseReader();
        this.context._unregister(this);
        super.dispose();
    }
}


export class MediaStreamVideoSourceNode extends VideoSourceNode {
	readonly track: MediaStreamTrack;

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
	}

	override dispose(): void {
		if (this.disposed) return;
		this.stop();
		this.track.stop();
		try {
			void this._stream.cancel();
		} catch (_) {
			/* ignore */
		}
		super.dispose();
	}
}



// VoiceActivityNode: whether the audio passing through carries a voice.
// Extends GainNode so it connects like any node, inline or as a tap.
import { AudioWorkletModule, stopProcessor } from "./audio_worklet_module.ts";
import { VAD_PROCESSOR_NAME } from "./audio_worklet_protocol.ts";
import { DEFAULT_VOICE_WINDOW_MS, isSpeakingMessage } from "./voice_activity_protocol.ts";
import {
	DEFAULT_VOICE_DETECTOR_OPTIONS,
	isVoiceDetectorOptions,
	type VoiceDetectorOptions,
} from "./voice_detector.ts";
import { VoiceActivityCode } from "./voice_activity_worklet_inline.ts";

const voiceActivityWorklet = new AudioWorkletModule(VoiceActivityCode);

/** What a VoiceActivityNode needs of its audio context. */
export interface VoiceActivityContextLike {
	readonly sampleRate: number;
	readonly audioWorklet: { addModule(moduleUrl: string): Promise<void> };
	readonly state?: AudioContextState;
}

/** How a VoiceActivityNode judges its input. */
export interface VoiceActivityNodeInit {
	/** The detector's thresholds; each one left out keeps its default. */
	readonly detector?: Partial<VoiceDetectorOptions>;
	/** How long each measured level covers, in ms (default 20). */
	readonly windowMs?: number;
}

/** Thrown by the constructor for options no detector can work with. */
export class VoiceActivityNodeOptionError extends RangeError {
	constructor(message: string) {
		super(message);
		this.name = "VoiceActivityNodeOptionError";
	}
}

/**
 * Fired when the input starts or stops carrying a voice. `time` is how much
 * input (ms) the node had measured by then, on the audio thread's own clock,
 * or NaN for the last event `dispose()` fires, which no measurement made.
 */
export class VoiceActivityEvent extends Event {
	readonly speaking: boolean;
	readonly time: number;

	constructor(speaking: boolean, time: number) {
		super("speakingchange");
		this.speaking = speaking;
		this.time = time;
	}
}

/**
 * VoiceActivityNode tells whether the audio passing through it carries a
 * voice. Its input is measured on the audio thread: mixed to mono, filtered to
 * the voice band (300–3400 Hz), and judged by a {@link VoiceDetector} against
 * its own noise floor, so a fan or music does not count, a quiet speaker does,
 * and the result does not flicker. The main thread only hears of a change.
 *
 * The audio passes through unchanged, so the node can sit in a chain or hang
 * off a source as a tap.
 *
 * ```ts
 * const vad = new VoiceActivityNode(context);
 * microphone.connect(vad);
 * vad.addEventListener("speakingchange", (e) => ring.lit = e.speaking);
 * // later
 * vad.dispose();
 * ```
 */
export class VoiceActivityNode extends GainNode {
	#worklet: AudioWorkletNode | null = null;
	#speaking = false;
	#disposed = false;
	readonly #context: VoiceActivityContextLike;
	readonly #detector: VoiceDetectorOptions;
	readonly #windowMs: number;

	/** Called on each {@link VoiceActivityEvent}, as a listener would be. */
	onspeakingchange: ((event: VoiceActivityEvent) => void) | null = null;

	/**
	 * @throws {VoiceActivityNodeOptionError} if the detector's options cannot
	 * work (non-finite, a stop threshold above the start one, a negative hold
	 * or floor rise) or `windowMs` is not a positive finite number.
	 */
	constructor(context: VoiceActivityContextLike, init: VoiceActivityNodeInit = {}) {
		const detector = { ...DEFAULT_VOICE_DETECTOR_OPTIONS, ...init.detector };
		if (!isVoiceDetectorOptions(detector)) {
			throw new VoiceActivityNodeOptionError(
				"detector options must be finite, with offDb <= onDb and holdMs, floorRiseDbPerSec >= 0",
			);
		}
		const windowMs = init.windowMs ?? DEFAULT_VOICE_WINDOW_MS;
		if (!Number.isFinite(windowMs) || windowMs <= 0) {
			throw new VoiceActivityNodeOptionError("windowMs must be a positive finite number");
		}
		super(context as unknown as BaseAudioContext, { gain: 1 });
		this.#context = context;
		this.#detector = detector;
		this.#windowMs = windowMs;

		voiceActivityWorklet.load(context).then(() => {
			// Disposed while the module was loading: measure nothing.
			if (this.#disposed) return;
			this.#attachWorklet();
		}).catch((e: unknown) => {
			if (
				(this.#disposed || context.state === "closed") &&
				e instanceof DOMException && e.name === "AbortError"
			) {
				return;
			}
			console.error("[VoiceActivityNode] Failed to initialize worklet:", e);
		});
	}

	/** Whether the input carries a voice, as of the last change. */
	get speaking(): boolean {
		return this.#speaking;
	}

	/**
	 * Stops measuring and takes the node out of the graph. A voice heard until
	 * now ends with a last `speakingchange`, so nothing stays lit.
	 */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#worklet !== null) {
			stopProcessor(this.#worklet);
			this.#worklet = null;
		}
		try {
			super.disconnect();
		} catch (_) {
			// reason: a node never connected has nothing to disconnect.
		}
		if (this.#speaking) this.#change(false, Number.NaN);
	}

	#attachWorklet(): void {
		const worklet = new AudioWorkletNode(
			this.#context as unknown as BaseAudioContext,
			VAD_PROCESSOR_NAME,
			{
				numberOfInputs: 1,
				numberOfOutputs: 1,
				processorOptions: {
					sampleRate: this.#context.sampleRate,
					windowMs: this.#windowMs,
					detector: this.#detector,
				},
			},
		);
		worklet.port.onmessage = ({ data }: MessageEvent<unknown>) => {
			if (this.#disposed || !isSpeakingMessage(data)) return;
			if (data.speaking !== this.#speaking) this.#change(data.speaking, data.time);
		};
		this.#worklet = worklet;
		super.connect(worklet);
	}

	#change(speaking: boolean, time: number): void {
		this.#speaking = speaking;
		const event = new VoiceActivityEvent(speaking, time);
		this.onspeakingchange?.(event);
		this.dispatchEvent(event);
	}
}

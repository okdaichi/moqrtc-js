import {
	DEFAULT_VOICE_WINDOW_MS,
	isVoiceActivityControlMessage,
	type SpeakingMessage,
} from "./voice_activity_protocol.ts";
import {
	DEFAULT_VOICE_DETECTOR_OPTIONS,
	isVoiceDetectorOptions,
	VoiceDetector,
} from "./voice_detector.ts";
import { VoiceBandFilter } from "./voice_band.ts";
import { VOICE_ACTIVITY_PROCESSOR_NAME } from "./audio_worklet_names.ts";

// URL getter function for main thread import
export function importWorkletUrl(): string {
	return new URL("./voice_activity_worklet.js", import.meta.url).href;
}

// Check if we're in a worklet context
if (typeof AudioWorkletProcessor !== "undefined") {
	// Measures whether its input carries a voice, on the audio thread: the
	// input is mixed to mono, filtered to the voice band, and its level taken
	// over each window (20 ms unless the node says otherwise) for a
	// VoiceDetector. Only a change is posted, so the main thread hears from it
	// a few times a second at most, and never while nothing changes.
	//
	// Time is the input's own: windows of samples measured, so a suspended
	// context or a slow main thread cannot make a pause look longer. A render
	// quantum with no input (a disconnected source) is measured as silence, so
	// a voice cut off stops being heard after the hold.
	class VoiceActivityProcessor extends AudioWorkletProcessor {
		readonly #detector: VoiceDetector;
		readonly #filter: VoiceBandFilter;
		readonly #windowFrames: number;
		readonly #msPerFrame: number;
		#mono = new Float32Array(128);
		#sum = 0;
		#count = 0;
		#frames = 0;
		#speaking = false;
		// Set by a stop message: process() then returns false, so the
		// processor can be collected.
		#stopped = false;

		constructor(options: AudioWorkletNodeOptions) {
			super();
			const rate: unknown = options.processorOptions?.sampleRate;
			const sampleRate = typeof rate === "number" && rate > 0 ? rate : globalThis.sampleRate;
			const window: unknown = options.processorOptions?.windowMs;
			const windowMs = typeof window === "number" && window > 0
				? window
				: DEFAULT_VOICE_WINDOW_MS;
			const detector: unknown = options.processorOptions?.detector;
			this.#detector = new VoiceDetector(
				isVoiceDetectorOptions(detector) ? detector : DEFAULT_VOICE_DETECTOR_OPTIONS,
			);
			this.#filter = new VoiceBandFilter(sampleRate);
			this.#windowFrames = Math.max(1, Math.round(sampleRate * windowMs / 1000));
			this.#msPerFrame = 1000 / sampleRate;

			this.port.onmessage = ({ data }: MessageEvent<unknown>) => {
				if (!isVoiceActivityControlMessage(data)) return;
				this.#stopped = true;
				this.port.close();
			};
		}

		process(inputs: Float32Array[][]): boolean {
			if (this.#stopped) return false;
			const channels = inputs[0] ?? [];
			const length = channels[0]?.length ?? 128;
			if (this.#mono.length !== length) this.#mono = new Float32Array(length);
			this.#mixToMono(channels);
			this.#filter.process(this.#mono, this.#mono);

			for (let i = 0; i < length; i++) {
				const s = this.#mono[i] ?? 0;
				this.#sum += s * s;
				this.#count++;
				this.#frames++;
				if (this.#count === this.#windowFrames) this.#measure();
			}
			return true;
		}

		#mixToMono(channels: Float32Array[]): void {
			const mono = this.#mono;
			mono.fill(0);
			if (channels.length === 0) return;
			const scale = 1 / channels.length;
			for (const channel of channels) {
				for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) * scale;
			}
		}

		#measure(): void {
			const mean = this.#sum / this.#count;
			const level = mean > 0 ? 10 * Math.log10(mean) : -Infinity;
			this.#sum = 0;
			this.#count = 0;
			const time = this.#frames * this.#msPerFrame;
			const speaking = this.#detector.update(level, time);
			if (speaking === this.#speaking) return;
			this.#speaking = speaking;
			const message: SpeakingMessage = { type: "speaking", speaking, time };
			this.port.postMessage(message);
		}
	}

	registerProcessor(VOICE_ACTIVITY_PROCESSOR_NAME, VoiceActivityProcessor);
}

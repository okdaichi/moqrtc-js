/**
 * The band a voice's loudness is measured in, so hum and rumble below it and
 * hiss above it do not count as speech. Plain biquad filters (the RBJ audio
 * EQ cookbook's high-pass and low-pass, Q = 1/√2), as an AudioWorklet has no
 * BiquadFilterNode of its own.
 */

/** Below this (Hz) is hum and rumble. */
export const VOICE_LOW_HZ = 300;
/** Above this (Hz) is hiss. */
export const VOICE_HIGH_HZ = 3400;

const BUTTERWORTH_Q = Math.SQRT1_2;

/** One second-order section, direct form I, coefficients normalised by a0. */
class Biquad {
	readonly #b0: number;
	readonly #b1: number;
	readonly #b2: number;
	readonly #a1: number;
	readonly #a2: number;
	#x1 = 0;
	#x2 = 0;
	#y1 = 0;
	#y2 = 0;

	constructor(kind: "highpass" | "lowpass", frequency: number, sampleRate: number) {
		const w0 = 2 * Math.PI * Math.min(frequency, sampleRate * 0.49) / sampleRate;
		const cos = Math.cos(w0);
		const alpha = Math.sin(w0) / (2 * BUTTERWORTH_Q);
		const a0 = 1 + alpha;
		const b1 = kind === "highpass" ? -(1 + cos) : 1 - cos;
		const b0 = kind === "highpass" ? (1 + cos) / 2 : (1 - cos) / 2;
		this.#b0 = b0 / a0;
		this.#b1 = b1 / a0;
		this.#b2 = b0 / a0;
		this.#a1 = -2 * cos / a0;
		this.#a2 = (1 - alpha) / a0;
	}

	next(x: number): number {
		const y = this.#b0 * x + this.#b1 * this.#x1 + this.#b2 * this.#x2 -
			this.#a1 * this.#y1 - this.#a2 * this.#y2;
		this.#x2 = this.#x1;
		this.#x1 = x;
		this.#y2 = this.#y1;
		this.#y1 = y;
		return y;
	}
}

/**
 * VoiceBandFilter keeps the voice band of a signal, one sample at a time, with
 * its own state: use one per voice.
 */
export class VoiceBandFilter {
	readonly #low: Biquad;
	readonly #high: Biquad;

	constructor(sampleRate: number, lowHz = VOICE_LOW_HZ, highHz = VOICE_HIGH_HZ) {
		this.#low = new Biquad("highpass", lowHz, sampleRate);
		this.#high = new Biquad("lowpass", highHz, sampleRate);
	}

	/**
	 * Filters `input` into `output` (the same length; may be the same array).
	 * Writing into the caller's buffer is the point: on the audio thread a
	 * render quantum must not allocate.
	 */
	process(input: ArrayLike<number>, output: Float32Array): void {
		for (let i = 0; i < output.length; i++) {
			output[i] = this.#high.next(this.#low.next(input[i] ?? 0));
		}
	}
}

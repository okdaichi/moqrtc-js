/**
 * Volume module with explicit constructor injection for runtime defaults.
 *
 * `VolumeController` wraps a GainNode and drives smooth fade and mute behavior.
 * Optional defaults are passed through constructor options instead of build-time globals.
 */

export interface VolumeControllerOptions extends GainOptions {
	initialVolume?: number;
	defaultVolume?: number;
	minGain?: number;
	fadeTimeMs?: number;
}

export class VolumeController extends GainNode {
	static readonly DEFAULT_VOLUME = 0.5;
	static readonly DEFAULT_MIN_GAIN = 0.001;
	static readonly DEFAULT_FADE_TIME_MS = 80;

	#muted = false;
	#unmuteVolume: number;
	#defaultVolume: number;
	#minGain: number;
	#fadeTimeMs: number;

	constructor(audioContext: AudioContext, options?: VolumeControllerOptions) {
		const {
			initialVolume,
			defaultVolume,
			minGain,
			fadeTimeMs,
			...gainOptions
		} = options ?? {};

		const normalizedDefaultVolume = VolumeController.normalizeNumber(
			defaultVolume ?? VolumeController.DEFAULT_VOLUME,
			VolumeController.DEFAULT_VOLUME,
			(value) => value >= 0 && value <= 1,
		);

		const normalizedMinGain = VolumeController.normalizeNumber(
			minGain ?? VolumeController.DEFAULT_MIN_GAIN,
			VolumeController.DEFAULT_MIN_GAIN,
			(value) => value > 0 && value < 0.01,
		);

		const normalizedFadeTimeMs = VolumeController.normalizeNumber(
			fadeTimeMs ?? VolumeController.DEFAULT_FADE_TIME_MS,
			VolumeController.DEFAULT_FADE_TIME_MS,
			(value) => value > 0.01 && value < 1.0,
		);

		const initialVolumeValue = initialVolume ?? normalizedDefaultVolume;
		const clampedInitial = Math.min(
			1,
			Math.max(0, isFinite(initialVolumeValue) ? initialVolumeValue : 1),
		);

		super(audioContext, { ...gainOptions, gain: clampedInitial });

		this.#defaultVolume = normalizedDefaultVolume;
		this.#minGain = normalizedMinGain;
		this.#fadeTimeMs = normalizedFadeTimeMs;
		this.#unmuteVolume = clampedInitial === 0 ? normalizedDefaultVolume : clampedInitial;
	}

	static normalizeNumber(
		value: unknown,
		fallback: number,
		validator: (value: number) => boolean,
	): number {
		return typeof value === "number" && Number.isFinite(value) && validator(value)
			? value
			: fallback;
	}

	#clamp(v: number): number {
		return Math.min(1, Math.max(0, isFinite(v) ? v : 1));
	}

	setVolume(v: number) {
		const clamped = this.#clamp(v);
		const now = this.context.currentTime;
		const gainParam = this.gain;

		gainParam.cancelScheduledValues(now);
		gainParam.setValueAtTime(gainParam.value, now);

		if (clamped < this.#minGain) {
			gainParam.exponentialRampToValueAtTime(this.#minGain, now + this.#fadeTimeMs);
			gainParam.setValueAtTime(0, now + this.#fadeTimeMs + 0.01);
		} else {
			gainParam.exponentialRampToValueAtTime(clamped, now + this.#fadeTimeMs);
		}

		if (clamped > 0) {
			this.#unmuteVolume = clamped;
		}
	}

	mute(m: boolean) {
		if (m === this.#muted) return;
		this.#muted = m;

		const now = this.context.currentTime;
		const gainParam = this.gain;
		gainParam.cancelScheduledValues(now);
		gainParam.setValueAtTime(gainParam.value, now);

		if (m) {
			const current = gainParam.value;
			if (current > 0.0001) {
				this.#unmuteVolume = current;
			}
			if (current < this.#minGain) {
				gainParam.exponentialRampToValueAtTime(this.#minGain, now + this.#fadeTimeMs);
				gainParam.setValueAtTime(0, now + this.#fadeTimeMs + 0.01);
			} else {
				gainParam.exponentialRampToValueAtTime(0, now + this.#fadeTimeMs);
			}
		} else {
			const restore = this.#unmuteVolume <= 0 ? this.#defaultVolume : this.#unmuteVolume;
			gainParam.exponentialRampToValueAtTime(this.#clamp(restore), now + this.#fadeTimeMs);
		}
	}

	get muted(): boolean {
		return this.#muted;
	}

	get volume(): number {
		return this.gain.value;
	}
}

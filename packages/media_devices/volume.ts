/**
 * Volume module with explicit constructor injection for runtime defaults.
 *
 * `VolumeController` wraps a GainNode and drives smooth fade and mute behavior.
 * Optional defaults are passed through constructor options instead of build-time globals.
 */

export interface VolumeControllerOptions {
	initialVolume?: number;
	defaultVolume?: number;
	minGain?: number;
	fadeTimeMs?: number;
}

type VolumeGainNode = {
	readonly context: AudioContext;
	readonly gain: AudioParam;
};

export class VolumeController {
	static readonly DEFAULT_VOLUME = 0.5;
	static readonly DEFAULT_MIN_GAIN = 0.001;
	static readonly DEFAULT_FADE_TIME_MS = 80;

	readonly gainNode: VolumeGainNode;
	#muted = false;
	#unmuteVolume: number;
	#defaultVolume: number;
	#minGain: number;
	#fadeTimeMs: number;

	constructor(gainNode: VolumeGainNode, options?: VolumeControllerOptions) {
		this.gainNode = gainNode;

		const {
			initialVolume,
			defaultVolume,
			minGain,
			fadeTimeMs,
		} = options ?? {};

		const normalizedDefaultVolume =
			defaultVolume != undefined && defaultVolume >= 0 && defaultVolume <= 1
				? defaultVolume
				: VolumeController.DEFAULT_VOLUME;

		const normalizedMinGain = minGain != undefined && minGain > 0 && minGain < 0.01
			? minGain
			: VolumeController.DEFAULT_MIN_GAIN;

		const normalizedFadeTimeMs =
			fadeTimeMs != undefined && fadeTimeMs > 0.01 && fadeTimeMs < 1.0
				? fadeTimeMs
				: VolumeController.DEFAULT_FADE_TIME_MS;

		const initialVolumeValue = initialVolume ?? normalizedDefaultVolume;
		const clampedInitial = Math.min(
			1,
			Math.max(0, isFinite(initialVolumeValue) ? initialVolumeValue : 1),
		);

		const now = this.gainNode.context.currentTime;
		const gainParam = this.gainNode.gain;
		gainParam.cancelScheduledValues(now);
		gainParam.setValueAtTime(clampedInitial, now);

		this.#defaultVolume = normalizedDefaultVolume;
		this.#minGain = normalizedMinGain;
		this.#fadeTimeMs = normalizedFadeTimeMs;
		this.#unmuteVolume = clampedInitial === 0 ? normalizedDefaultVolume : clampedInitial;
	}

	#clamp(v: number): number {
		return Math.min(1, Math.max(0, isFinite(v) ? v : 1));
	}

	setVolume(v: number) {
		const clamped = this.#clamp(v);
		const now = this.gainNode.context.currentTime;
		const gainParam = this.gainNode.gain;

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

		const now = this.gainNode.context.currentTime;
		const gainParam = this.gainNode.gain;
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
		return this.gainNode.gain.value;
	}
}

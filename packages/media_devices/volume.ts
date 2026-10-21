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
	/** How long a volume change or mute fades, in milliseconds. */
	fadeTimeMs?: number;
}

/** The part of an AudioParam the controller schedules: a GainNode's `gain`. */
export interface VolumeParam {
	readonly value: number;
	cancelScheduledValues(cancelTime: number): unknown;
	setValueAtTime(value: number, startTime: number): unknown;
	exponentialRampToValueAtTime(value: number, endTime: number): unknown;
}

/** The part of a GainNode the controller drives: its gain, on its context's clock. */
export interface VolumeGainNode {
	readonly context: { readonly currentTime: number };
	readonly gain: VolumeParam;
}

const MS_PER_SECOND = 1000;

export class VolumeController {
	static readonly DEFAULT_VOLUME = 0.5;
	static readonly DEFAULT_MIN_GAIN = 0.001;
	static readonly DEFAULT_FADE_TIME_MS = 80;

	readonly gainNode: VolumeGainNode;
	#muted = false;
	#unmuteVolume: number;
	#defaultVolume: number;
	#minGain: number;
	/** The fade time in seconds, the unit of the audio clock. */
	#fadeSeconds: number;

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
			fadeTimeMs != undefined && Number.isFinite(fadeTimeMs) && fadeTimeMs > 0
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
		this.#fadeSeconds = normalizedFadeTimeMs / MS_PER_SECOND;
		this.#unmuteVolume = clampedInitial === 0 ? normalizedDefaultVolume : clampedInitial;
	}

	#clamp(v: number): number {
		return Math.min(1, Math.max(0, isFinite(v) ? v : 1));
	}

	/**
	 * rampTo fades the gain from where it is to target over the fade time.
	 * An exponential ramp can neither start nor end at 0, so a fade out of
	 * silence starts at minGain, and a fade into silence ends at minGain and
	 * then drops to 0.
	 */
	#rampTo(target: number): void {
		const gainParam = this.gainNode.gain;
		const now = this.gainNode.context.currentTime;
		const end = now + this.#fadeSeconds;
		const from = gainParam.value;

		gainParam.cancelScheduledValues(now);
		if (from < this.#minGain && target < this.#minGain) {
			gainParam.setValueAtTime(0, now);
			return;
		}

		gainParam.setValueAtTime(Math.max(from, this.#minGain), now);
		if (target < this.#minGain) {
			gainParam.exponentialRampToValueAtTime(this.#minGain, end);
			gainParam.setValueAtTime(0, end);
		} else {
			gainParam.exponentialRampToValueAtTime(target, end);
		}
	}

	setVolume(v: number) {
		const clamped = this.#clamp(v);
		this.#rampTo(clamped);

		if (clamped > 0) {
			this.#unmuteVolume = clamped;
		}
	}

	mute(m: boolean) {
		if (m === this.#muted) return;
		this.#muted = m;

		if (m) {
			const current = this.gainNode.gain.value;
			if (current > 0.0001) {
				this.#unmuteVolume = current;
			}
			this.#rampTo(0);
		} else {
			const restore = this.#unmuteVolume <= 0 ? this.#defaultVolume : this.#unmuteVolume;
			this.#rampTo(this.#clamp(restore));
		}
	}

	get muted(): boolean {
		return this.#muted;
	}

	get volume(): number {
		return this.gainNode.gain.value;
	}
}

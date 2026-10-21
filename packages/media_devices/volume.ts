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

/**
 * Fade is the gain curve the controller last scheduled: an exponential ramp
 * from `from` at `start` to `ramp` at `end`, after which the gain is
 * `settled` (0 for a fade into silence, which ramps only to minGain).
 */
interface Fade {
	readonly start: number;
	readonly end: number;
	readonly from: number;
	readonly ramp: number;
	readonly settled: number;
}

/** steady is a gain held at value from time on. */
function steady(value: number, time: number): Fade {
	return { start: time, end: time, from: value, ramp: value, settled: value };
}

/** gainAt is the gain fade gives at time t. */
function gainAt(fade: Fade, t: number): number {
	if (t >= fade.end) return fade.settled;
	if (t <= fade.start) return fade.from;
	const progress = (t - fade.start) / (fade.end - fade.start);
	return fade.from * (fade.ramp / fade.from) ** progress;
}

export class VolumeController {
	static readonly DEFAULT_VOLUME = 0.5;
	static readonly DEFAULT_MIN_GAIN = 0.001;
	static readonly DEFAULT_FADE_TIME_MS = 80;

	readonly gainNode: VolumeGainNode;
	#muted = false;
	/**
	 * The curve last scheduled. A fade starts from the gain this curve gives
	 * now, not from `gain.value`, which a browser updates only as it renders
	 * (right after scheduling it can still read the param's default, 1).
	 */
	#fade: Fade;
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
		this.#fade = steady(clampedInitial, now);
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
		const current = gainAt(this.#fade, now);

		gainParam.cancelScheduledValues(now);
		if (current < this.#minGain && target < this.#minGain) {
			gainParam.setValueAtTime(0, now);
			this.#fade = steady(0, now);
			return;
		}

		const from = Math.max(current, this.#minGain);
		const ramp = Math.max(target, this.#minGain);
		gainParam.setValueAtTime(from, now);
		gainParam.exponentialRampToValueAtTime(ramp, end);
		const settled = target < this.#minGain ? 0 : target;
		if (settled === 0) gainParam.setValueAtTime(0, end);
		this.#fade = { start: now, end, from, ramp, settled };
	}

	/**
	 * setVolume fades to v. While muted, the gain stays silent and v is only
	 * kept, to be restored on unmute.
	 */
	setVolume(v: number) {
		const clamped = this.#clamp(v);
		if (clamped > 0) {
			this.#unmuteVolume = clamped;
		}
		if (this.#muted) return;
		this.#rampTo(clamped);
	}

	mute(m: boolean) {
		if (m === this.#muted) return;
		this.#muted = m;

		if (m) {
			// The volume faded to, not the gain mid-fade, is what unmuting restores.
			if (this.#fade.settled > 0) {
				this.#unmuteVolume = this.#fade.settled;
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

	/** The gain asked for: where a fade is heading, and 0 while muted. */
	get volume(): number {
		return this.#fade.settled;
	}
}

/**
 * Deciding from a voice's loudness whether someone is talking, the same way in
 * a quiet room and a noisy one. Each voice keeps its own noise floor: the level
 * it falls back to between words. A voice is heard while it stands clearly
 * above that floor, and stays heard through the short gaps between words.
 * Separate thresholds to start and to stop keep it from flickering around a
 * single line.
 *
 * Pure and clock-free (the caller passes the time), so the same logic runs in
 * the VoiceActivityNode's worklet and wherever else levels are measured.
 */

/** How a VoiceDetector judges a voice. */
export interface VoiceDetectorOptions {
	/** Above the floor by this many dB, a voice starts being heard. */
	readonly onDb: number;
	/** Below the floor plus this many dB, a heard voice starts to fade. */
	readonly offDb: number;
	/** A heard voice stays heard this long after it last stood out (ms). */
	readonly holdMs: number;
	/** How fast the floor rises toward a louder level, in dB per second. */
	readonly floorRiseDbPerSec: number;
	/** Quieter than this (dBFS), nothing is ever heard: near-silence. */
	readonly minDb: number;
}

/** Defaults tuned on speech over a quiet room and over a fan. */
export const DEFAULT_VOICE_DETECTOR_OPTIONS: VoiceDetectorOptions = {
	onDb: 9,
	offDb: 5,
	holdMs: 350,
	floorRiseDbPerSec: 4,
	minDb: -50,
};

/** The lowest the floor goes: digital silence would otherwise pin it. */
const LOWEST_FLOOR_DB = -90;

/** The loudness of `samples` in dB relative to full scale (-Infinity for silence). */
export function levelDb(samples: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < samples.length; i++) {
		const s = samples[i] ?? 0;
		sum += s * s;
	}
	const rms = Math.sqrt(sum / Math.max(1, samples.length));
	return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * Whether `options` describes a detector that can work: finite numbers, a
 * start threshold at or above the stop one, and no negative durations or rates.
 */
export function isVoiceDetectorOptions(options: unknown): options is VoiceDetectorOptions {
	if (typeof options !== "object" || options === null) return false;
	const o = options as Record<string, unknown>;
	const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
	return finite(o.onDb) && finite(o.offDb) && finite(o.holdMs) &&
		finite(o.floorRiseDbPerSec) && finite(o.minDb) &&
		o.onDb >= o.offDb && o.holdMs >= 0 && o.floorRiseDbPerSec >= 0;
}

/**
 * VoiceDetector follows one voice's loudness over time and says whether it is
 * heard. The floor falls at once to anything quieter and rises slowly toward
 * anything louder, so speech, with its pauses, barely lifts it, while a fan or
 * music running for seconds becomes the floor.
 */
export class VoiceDetector {
	// The first level measured: the room as the voice joins it. Someone already
	// talking then lifts it, and their first pause brings it down again.
	#floor: number | null = null;
	#heard = false;
	#lastLoud = -Infinity;
	#lastAt: number | null = null;
	readonly #o: VoiceDetectorOptions;

	constructor(options: VoiceDetectorOptions = DEFAULT_VOICE_DETECTOR_OPTIONS) {
		this.#o = options;
	}

	/** The noise floor the voice is measured against, in dBFS. */
	get floorDb(): number {
		return this.#floor ?? LOWEST_FLOOR_DB;
	}

	/** Whether the voice is heard, as of the last update. */
	get heard(): boolean {
		return this.#heard;
	}

	/**
	 * Forgets what was measured: the voice is not heard, and the floor is
	 * measured afresh from the next level.
	 */
	reset(): void {
		this.#floor = null;
		this.#heard = false;
		this.#lastLoud = -Infinity;
		this.#lastAt = null;
	}

	/** Takes the level measured at `now` (ms) and says whether the voice is heard. */
	update(level: number, now: number): boolean {
		const db = Number.isFinite(level) ? level : -Infinity;
		const elapsed = this.#lastAt === null ? 0 : Math.max(0, now - this.#lastAt) / 1000;
		this.#lastAt = now;
		const floor = this.#followFloor(db, elapsed);

		const audible = db >= this.#o.minDb;
		if (audible && db >= floor + this.#o.onDb) {
			this.#heard = true;
			this.#lastLoud = now;
		} else if (this.#heard && audible && db >= floor + this.#o.offDb) {
			this.#lastLoud = now;
		} else if (this.#heard && now - this.#lastLoud > this.#o.holdMs) {
			this.#heard = false;
		}
		return this.#heard;
	}

	#followFloor(db: number, elapsed: number): number {
		const quiet = Math.max(db, LOWEST_FLOOR_DB);
		if (this.#floor === null || quiet <= this.#floor) {
			this.#floor = quiet;
		} else {
			const rise = this.#o.floorRiseDbPerSec * elapsed;
			this.#floor = Math.min(quiet, this.#floor + rise);
		}
		return this.#floor;
	}
}

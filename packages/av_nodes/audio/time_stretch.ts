// Waveform-similarity overlap-add (WSOLA) time-scale modification for the
// playback worklet: it lengthens or shortens audio by a whole period of the
// signal, found by normalized cross-correlation, so a tone or voiced speech
// goes on without a discontinuity.
//
// The functions work in place on a buffer indexed modulo its length, so the
// worklet's ring and a plain array (indices below its length) both work.
// Positions are non-negative frame numbers. Nothing allocates after
// construction.

// Shortest and longest segment (ms) added or removed: a pitch period from
// 400 Hz down to 67 Hz, or a few periods of a higher voice or tone.
const MIN_LAG_MS = 2.5;
const MAX_LAG_MS = 15;

// Length (ms) of the stretch compared to find the lag, which is also the
// crossfade between the audio either side of the seam.
const OVERLAP_MS = 10;

// The lag is first searched on the signal averaged down to about this rate
// (Hz), then refined at full rate around the best few coarse peaks: at most
// this many, scoring at least this share of the best. Each whole number of
// periods makes a peak, and the coarse grid can favour a multiple whose full
// rate match is worse (5 periods of 440 Hz, 545.45 frames, against 1 period,
// 109.09), so the peaks are compared at full rate. This bounds the work per
// search to about a hundred thousand multiply-adds at 48 kHz.
const SEARCH_RATE_HZ = 8000;
const REFINED_PEAKS = 8;
const PEAK_SHARE = 0.9;

/** Finds the lag at which a signal repeats, for a sample rate. */
export class TimeStretcher {
	/** Shortest lag (frames) searched. */
	readonly minLag: number;
	/** Longest lag (frames) searched. */
	readonly maxLag: number;
	/** Longest stretch (frames) compared and crossfaded. */
	readonly overlap: number;

	readonly #decimation: number;
	// The searched span averaged over #decimation frames per sample, the
	// score per coarse lag, and whether a coarse lag has been refined.
	readonly #coarse: Float32Array;
	readonly #scores: Float32Array;
	readonly #refined: Uint8Array;

	constructor(sampleRate: number) {
		this.minLag = Math.max(1, Math.round(sampleRate * MIN_LAG_MS / 1000));
		this.maxLag = Math.max(this.minLag, Math.round(sampleRate * MAX_LAG_MS / 1000));
		this.overlap = Math.max(1, Math.round(sampleRate * OVERLAP_MS / 1000));
		this.#decimation = Math.max(1, Math.floor(sampleRate / SEARCH_RATE_HZ));
		this.#coarse = new Float32Array(
			Math.ceil((this.maxLag + this.overlap) / this.#decimation) + 1,
		);
		this.#scores = new Float32Array(Math.floor(this.maxLag / this.#decimation) + 2);
		this.#refined = new Uint8Array(this.#scores.length);
	}

	/**
	 * The lag in [minLag, `maxLag`] at which the `overlap` frames of `signal`
	 * from `at + direction * lag` best match the `overlap` frames from `at`,
	 * by normalized cross-correlation. Of lags matching equally, the longest.
	 * Where nothing correlates (silence), `maxLag`. `maxLag` and `overlap` are
	 * capped at the stretcher's.
	 */
	findLag(
		signal: Float32Array,
		at: number,
		direction: 1 | -1,
		maxLag: number,
		overlap: number,
	): number {
		const longest = Math.min(maxLag, this.maxLag);
		const window = Math.min(overlap, this.overlap);
		const step = this.#decimation;
		const len = signal.length;

		// Coarse search over lags that are multiples of the decimation. The
		// averaged span starts at `at` searching forwards, or at the longest
		// coarse lag before it searching backwards.
		const coarseWindow = Math.max(1, Math.floor(window / step));
		const coarseMax = Math.floor(longest / step);
		const coarseMin = Math.max(1, Math.ceil(this.minLag / step));
		const fixed = direction > 0 ? 0 : coarseMax;
		const base = at - fixed * step;
		const span = coarseMax + coarseWindow;
		for (let k = 0; k < span; k++) {
			let sum = 0;
			const from = base + k * step;
			for (let j = 0; j < step; j++) sum += signal[(from + j) % len] ?? 0;
			this.#coarse[k] = sum / step;
		}

		let bestScore = 0;
		for (let lag = coarseMin; lag <= coarseMax; lag++) {
			const score = this.#coarseScore(fixed, fixed + direction * lag, coarseWindow);
			this.#scores[lag] = score;
			this.#refined[lag] = 0;
			bestScore = Math.max(bestScore, score);
		}
		if (bestScore <= 0) return longest;

		let refined = longest;
		let refinedScore = -Infinity;
		for (let peak = 0; peak < REFINED_PEAKS; peak++) {
			const center = this.#nextPeak(coarseMin, coarseMax, PEAK_SHARE * bestScore);
			if (center < 0) break;
			// Within one coarse step of the peak, longest first, so the longest
			// of lags matching equally wins.
			const lowest = Math.max(this.minLag, center * step - step + 1);
			for (let lag = Math.min(longest, center * step + step - 1); lag >= lowest; lag--) {
				const score = correlation(signal, at, at + direction * lag, window);
				if (score > refinedScore) {
					refinedScore = score;
					refined = lag;
				}
			}
		}
		return refined;
	}

	// The unrefined coarse peak (a lag scoring at least its neighbours) with
	// the highest score of at least `floor`, the longest of equal ones, marked
	// refined; -1 when none is left.
	#nextPeak(coarseMin: number, coarseMax: number, floor: number): number {
		let best = -1;
		let bestScore = floor;
		for (let lag = coarseMax; lag >= coarseMin; lag--) {
			const score = this.#scores[lag] ?? 0;
			if (this.#refined[lag] === 1 || score < bestScore) continue;
			const before = lag > coarseMin ? (this.#scores[lag - 1] ?? 0) : -Infinity;
			const after = lag < coarseMax ? (this.#scores[lag + 1] ?? 0) : -Infinity;
			if (score < before || score < after || (score === bestScore && best >= 0)) continue;
			best = lag;
			bestScore = score;
		}
		if (best >= 0) this.#refined[best] = 1;
		return best;
	}

	// Cross-correlation of the averaged samples from `a` and from `b`,
	// normalized by the energy at `b` (the energy at `a` is common to all
	// lags).
	#coarseScore(a: number, b: number, window: number): number {
		let xy = 0;
		let yy = 0;
		for (let i = 0; i < window; i++) {
			const y = this.#coarse[b + i] ?? 0;
			xy += (this.#coarse[a + i] ?? 0) * y;
			yy += y * y;
		}
		return yy > 0 ? xy / Math.sqrt(yy) : 0;
	}
}

// Cross-correlation of `signal` from `a` and from `b`, normalized by the
// energy at `b`.
function correlation(signal: Float32Array, a: number, b: number, window: number): number {
	const len = signal.length;
	let xy = 0;
	let yy = 0;
	for (let i = 0; i < window; i++) {
		const y = signal[(b + i) % len] ?? 0;
		xy += (signal[(a + i) % len] ?? 0) * y;
		yy += y * y;
	}
	return yy > 0 ? xy / Math.sqrt(yy) : 0;
}

/**
 * Shortens the audio [`at`, `end`) by `lag` frames: crossfades the `overlap`
 * frames from `at` into those from `at + lag`, and moves the rest up by `lag`.
 * The audio then ends at `end - lag`. Needs `at + lag + overlap <= end`.
 */
export function removeSegment(
	signal: Float32Array,
	at: number,
	lag: number,
	overlap: number,
	end: number,
): void {
	const len = signal.length;
	// Each source lies after the frame written, so it is still unchanged.
	for (let i = 0; i < overlap; i++) {
		const g = (i + 1) / (overlap + 1);
		const p = (at + i) % len;
		signal[p] = (signal[p] ?? 0) * (1 - g) + (signal[(at + lag + i) % len] ?? 0) * g;
	}
	for (let f = at + overlap; f < end - lag; f++) {
		signal[f % len] = signal[(f + lag) % len] ?? 0;
	}
}

/**
 * Lengthens the audio ending at `end` by `lag` frames: the `lag` frames
 * before `end` are repeated after it, and the `overlap` frames before `end`
 * crossfade into the copy of them `lag` frames earlier, so the audio leads
 * into the repetition without a seam. The audio then ends at `end + lag`,
 * where its continuation follows on. Reads from `end - overlap - lag`.
 */
export function insertSegment(
	signal: Float32Array,
	end: number,
	lag: number,
	overlap: number,
): void {
	const len = signal.length;
	for (let i = 0; i < lag; i++) {
		signal[(end + i) % len] = signal[(end - lag + i) % len] ?? 0;
	}
	// Backwards, so each source, before the frame written, is still unchanged.
	for (let i = overlap - 1; i >= 0; i--) {
		const g = (i + 1) / (overlap + 1);
		const p = (end - overlap + i) % len;
		signal[p] = (signal[p] ?? 0) * (1 - g) + (signal[(end - overlap - lag + i) % len] ?? 0) * g;
	}
}

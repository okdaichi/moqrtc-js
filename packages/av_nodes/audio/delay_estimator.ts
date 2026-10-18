// Playout-delay statistics for the playback worklet, after WebRTC's NetEQ.
//
// The caller reports each block's delay: the playback frame at its arrival
// minus the frame its timestamp maps to. The delay floor is the fastest recent
// arrival; a block's relative delay is how far it came after that floor. A
// decaying histogram of relative delays gives the target cushion as a high
// quantile, and a peak detector raises it at once when a block comes later
// than any recent one (fast attack). Release is slow: a peak is held at full
// height for 20 to 40 s, so delay spikes recurring within that keep the
// target where they put it instead of letting it sag between them, and only
// then decays; the histogram forgets over a similar time. All values are in
// frames.

// Relative-delay histogram: bucket width (ms), the quantile the target covers,
// and the time constant (s) over which old arrivals are forgotten. Forty
// seconds keeps the share of blocks that came late on a link that is often
// bad, rather than of the last few seconds.
const DELAY_BUCKET_MS = 10;
const DELAY_QUANTILE = 0.97;
const HISTOGRAM_TIME_CONSTANT_S = 40;

// Fast attack: the largest recent relative delay plus this margin (ms) is
// covered at once.
const PEAK_MARGIN_MS = 20;

// Slow release: the peak is the largest relative delay of the current and the
// previous window of this length (s), so it is held for one to two windows; a
// peak older than that decays with the release time constant (s). A link that
// stalls every ten or twenty seconds (2.4 GHz Wi-Fi) keeps its target; one
// that stays clean for 40 s or more falls back within about a minute.
const PEAK_WINDOW_S = 20;
const PEAK_RELEASE_TIME_CONSTANT_S = 20;

// The floor is the minimum over the last one to two windows of this length
// (s), so it follows a slowly drifting clock.
const FLOOR_WINDOW_S = 2;

/** Bounds of the cushion over the delay floor. */
export interface DelayEstimatorOptions {
	readonly sampleRate: number;
	/** Smallest target cushion (frames). */
	readonly minCushion: number;
	/** Largest target cushion (frames); larger relative delays are not counted. */
	readonly maxCushion: number;
}

/** Tracks arrival delays and the cushion they call for. */
export class DelayEstimator {
	readonly #sampleRate: number;
	readonly #minCushion: number;
	readonly #maxCushion: number;
	readonly #bucketFrames: number;
	readonly #peakMargin: number;
	readonly #floorWindow: number;
	readonly #peakWindow: number;

	// Weight per relative-delay bucket, summing to 1. It starts with all
	// weight on no jitter, so a few early outliers do not set the target
	// before the stream has shown its jitter.
	readonly #histogram: Float64Array;

	#floorCurrent = 0;
	#floorPrevious = 0;
	#floorWindowStart = 0;
	// Largest relative delay of the current and the previous peak window, and
	// the decaying peak of the windows before them.
	#peakCurrent = 0;
	#peakPrevious = 0;
	#peakReleased = 0;
	#peakWindowStart = 0;

	constructor(options: DelayEstimatorOptions) {
		this.#sampleRate = options.sampleRate;
		this.#minCushion = options.minCushion;
		this.#maxCushion = Math.max(options.minCushion, options.maxCushion);
		this.#bucketFrames = Math.max(1, this.#frames(DELAY_BUCKET_MS));
		this.#peakMargin = this.#frames(PEAK_MARGIN_MS);
		this.#floorWindow = this.#frames(FLOOR_WINDOW_S * 1000);
		this.#peakWindow = this.#frames(PEAK_WINDOW_S * 1000);
		this.#histogram = new Float64Array(Math.ceil(this.#maxCushion / this.#bucketFrames) + 1);
		this.#histogram[0] = 1;
	}

	#frames(ms: number): number {
		return Math.ceil(this.#sampleRate * ms / 1000);
	}

	/** The fastest recent delay. */
	floor(): number {
		return Math.min(this.#floorCurrent, this.#floorPrevious);
	}

	/**
	 * Starts measuring from `delay` as the floor, at playback frame `now`,
	 * forgetting the peak. The histogram of relative delays is kept.
	 */
	reset(delay: number, now: number): void {
		this.#floorCurrent = delay;
		this.#floorPrevious = delay;
		this.#floorWindowStart = now;
		this.#peakCurrent = 0;
		this.#peakPrevious = 0;
		this.#peakReleased = 0;
		this.#peakWindowStart = now;
	}

	/** Records the delay of a block `numberOfFrames` long, arrived at playback frame `now`. */
	observe(delay: number, numberOfFrames: number, now: number): void {
		if (now - this.#floorWindowStart >= this.#floorWindow) {
			this.#floorPrevious = this.#floorCurrent;
			this.#floorCurrent = delay;
			this.#floorWindowStart = now;
		} else if (delay < this.#floorCurrent) {
			this.#floorCurrent = delay;
		}

		const relative = Math.max(0, delay - this.floor());
		const seconds = numberOfFrames / this.#sampleRate;
		this.#rollPeakWindow(now);
		this.#peakReleased *= Math.exp(-seconds / PEAK_RELEASE_TIME_CONSTANT_S);

		// A relative delay beyond the maximum cushion cannot be absorbed: it is a
		// straggler or a stream that fell behind, not jitter to cover.
		if (relative > this.#maxCushion) return;

		const keep = Math.exp(-seconds / HISTOGRAM_TIME_CONSTANT_S);
		const bucket = Math.min(
			this.#histogram.length - 1,
			Math.floor(relative / this.#bucketFrames),
		);
		for (let i = 0; i < this.#histogram.length; i++) {
			const weight = (this.#histogram[i] ?? 0) * keep;
			this.#histogram[i] = i === bucket ? weight + (1 - keep) : weight;
		}

		if (relative > this.#peakCurrent) {
			this.#peakCurrent = relative;
		}
	}

	// Starts a new peak window once the current one is over: its peak becomes
	// the previous one, and the previous one is released. When two windows
	// have passed without a block, both are released.
	#rollPeakWindow(now: number): void {
		const elapsed = now - this.#peakWindowStart;
		if (elapsed < this.#peakWindow) return;
		const both = elapsed >= 2 * this.#peakWindow;
		const released = both
			? Math.max(this.#peakCurrent, this.#peakPrevious)
			: this.#peakPrevious;
		this.#peakReleased = Math.max(this.#peakReleased, released);
		this.#peakPrevious = both ? 0 : this.#peakCurrent;
		this.#peakCurrent = 0;
		this.#peakWindowStart = now;
	}

	/** The cushion over the floor that the statistics ask for. */
	targetCushion(): number {
		const largest = Math.max(this.#peakCurrent, this.#peakPrevious, this.#peakReleased);
		const peak = largest > 0 ? largest + this.#peakMargin : 0;
		const cushion = Math.round(Math.max(this.#quantile(), peak));
		return Math.min(this.#maxCushion, Math.max(this.#minCushion, cushion));
	}

	// Upper edge of the bucket holding the DELAY_QUANTILE of the weight.
	#quantile(): number {
		let sum = 0;
		for (let i = 0; i < this.#histogram.length; i++) {
			sum += this.#histogram[i] ?? 0;
			if (sum >= DELAY_QUANTILE) return (i + 1) * this.#bucketFrames;
		}
		return this.#histogram.length * this.#bucketFrames;
	}
}

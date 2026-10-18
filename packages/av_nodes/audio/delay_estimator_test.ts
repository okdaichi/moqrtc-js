import { assertAlmostEquals, assertEquals } from "@std/assert";
import { DelayEstimator } from "./delay_estimator.ts";

const SAMPLE_RATE = 48000;
const BLOCK = 960; // 20 ms
const MIN_CUSHION = 960; // 20 ms
const MAX_CUSHION = 19200; // 400 ms
const PEAK_MARGIN = 960; // 20 ms
const BUCKET = 480; // 10 ms
const PEAK_WINDOW_BLOCKS = 1000; // 20 s

function createEstimator(): DelayEstimator {
	const estimator = new DelayEstimator({
		sampleRate: SAMPLE_RATE,
		minCushion: MIN_CUSHION,
		maxCushion: MAX_CUSHION,
	});
	estimator.reset(0, 0);
	return estimator;
}

// Observes one block per BLOCK frames from `from`, with delay(i) for the i-th.
// Returns the frame after the last block.
function observeBlocks(
	estimator: DelayEstimator,
	count: number,
	from: number,
	delay: (i: number) => number,
): number {
	let now = from;
	for (let i = 0; i < count; i++) {
		estimator.observe(delay(i), BLOCK, now);
		now += BLOCK;
	}
	return now;
}

Deno.test("DelayEstimator", async (t) => {
	await t.step("targets the minimum cushion before any jitter", () => {
		const estimator = createEstimator();

		const target = estimator.targetCushion();

		assertEquals(target, MIN_CUSHION);
	});

	await t.step("covers a late arrival at once, plus the margin", () => {
		const estimator = createEstimator();
		estimator.observe(0, BLOCK, 0);

		estimator.observe(4800, BLOCK, BLOCK);

		assertEquals(estimator.targetCushion(), 4800 + PEAK_MARGIN);
	});

	await t.step("caps the target at the maximum cushion", () => {
		const estimator = createEstimator();

		estimator.observe(MAX_CUSHION, BLOCK, 0);

		assertEquals(estimator.targetCushion(), MAX_CUSHION);
	});

	await t.step("ignores a delay beyond the maximum cushion", () => {
		const estimator = createEstimator();

		estimator.observe(MAX_CUSHION + 1, BLOCK, 0);

		assertEquals(estimator.targetCushion(), MIN_CUSHION);
	});

	await t.step("holds a late arrival at full height for two peak windows", () => {
		const estimator = createEstimator();
		estimator.observe(4800, BLOCK, 0);

		// On-time blocks up to just before 40 s.
		observeBlocks(estimator, 2 * PEAK_WINDOW_BLOCKS - 1, BLOCK, () => 0);

		assertEquals(estimator.targetCushion(), 4800 + PEAK_MARGIN);
	});

	await t.step("releases a late arrival over 20 s once two peak windows have passed", () => {
		const estimator = createEstimator();
		estimator.observe(4800, BLOCK, 0);
		const now = observeBlocks(estimator, 2 * PEAK_WINDOW_BLOCKS - 1, BLOCK, () => 0);

		// Twenty seconds more on time: the released peak decays by e.
		observeBlocks(estimator, PEAK_WINDOW_BLOCKS, now, () => 0);

		assertAlmostEquals(estimator.targetCushion(), 4800 * Math.exp(-1) + PEAK_MARGIN, 1);
	});

	await t.step("keeps the target of a late arrival recurring every 12 s", () => {
		const estimator = createEstimator();
		const every = 600; // blocks: 12 s
		const targets: number[] = [];

		let now = 0;
		for (let i = 0; i < 10 * every; i++) {
			estimator.observe(i % every === 0 ? 4800 : 0, BLOCK, now);
			targets.push(estimator.targetCushion());
			now += BLOCK;
		}

		assertEquals(Math.min(...targets), 4800 + PEAK_MARGIN);
	});

	await t.step("holds a delay seen in more than 3% of recent blocks", () => {
		const estimator = createEstimator();
		// Twenty seconds where every other block is 50 ms late...
		const now = observeBlocks(estimator, 1000, 0, (i) => i % 2 === 0 ? 0 : 2400);

		// ...then thirty seconds on time: the peak is releasing, and the
		// histogram still holds the late bucket above the 97th percentile.
		observeBlocks(estimator, 1500, now, () => 0);

		assertEquals(estimator.targetCushion(), (2400 / BUCKET + 1) * BUCKET);
	});

	await t.step("measures delays from the fastest recent arrival", () => {
		const estimator = createEstimator();
		estimator.reset(1000, 0);

		estimator.observe(3000, BLOCK, BLOCK);

		assertEquals(estimator.targetCushion(), 2000 + PEAK_MARGIN);
	});

	await t.step("keeps the floor for up to two windows", () => {
		const estimator = createEstimator();
		estimator.reset(1000, 0);

		estimator.observe(5000, BLOCK, 2 * SAMPLE_RATE);

		assertEquals(estimator.floor(), 1000);
	});

	await t.step("moves the floor up after two windows without faster arrivals", () => {
		const estimator = createEstimator();
		estimator.reset(1000, 0);
		estimator.observe(5000, BLOCK, 2 * SAMPLE_RATE);

		estimator.observe(5000, BLOCK, 4 * SAMPLE_RATE);

		assertEquals(estimator.floor(), 5000);
	});

	await t.step("moves the floor down at once on a faster arrival", () => {
		const estimator = createEstimator();
		estimator.reset(1000, 0);

		estimator.observe(-500, BLOCK, BLOCK);

		assertEquals(estimator.floor(), -500);
	});

	await t.step("forgets the peak on reset", () => {
		const estimator = createEstimator();
		estimator.observe(4800, BLOCK, 0);

		estimator.reset(0, BLOCK);

		assertEquals(estimator.targetCushion(), MIN_CUSHION);
	});
});

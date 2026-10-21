import { assertAlmostEquals, assertEquals } from "@std/assert";
import { VolumeController, type VolumeGainNode, type VolumeParam } from "./volume.ts";

/** A value the fake param was told to reach: at once ("set") or by a ramp. */
interface ScheduledValue {
	kind: "set" | "ramp";
	value: number;
	time: number;
}

/**
 * FakeAudioParam records the values scheduled on it. Like a browser's, its
 * value changes only as audio renders: it reads the param's default (1)
 * until render() is called, which takes the value reached by the clock's
 * current time — a set value from its time on, a ramp's target only from its
 * end time on (the ramp itself is not interpolated). Like a browser, it
 * rejects an exponential ramp to a value that is not positive.
 */
class FakeAudioParam implements VolumeParam {
	/** Every value scheduled, in order, including ones cancelled since. */
	scheduled: ScheduledValue[] = [];
	readonly #clock: { readonly currentTime: number };
	#timeline: ScheduledValue[] = [];
	#base: number;
	#rendered: number;

	constructor(clock: { readonly currentTime: number }, defaultValue = 1.0) {
		this.#clock = clock;
		this.#base = defaultValue;
		this.#rendered = defaultValue;
	}

	get value(): number {
		return this.#rendered;
	}

	/** render brings value up to the clock's current time, as rendering audio does. */
	render(): void {
		this.#rendered = this.#reached();
	}

	#reached(): number {
		const reached = this.#timeline.filter((s) => s.time <= this.#clock.currentTime);
		return reached.at(-1)?.value ?? this.#base;
	}

	cancelScheduledValues(cancelTime: number): this {
		this.#base = this.#reached();
		this.#timeline = this.#timeline.filter((s) => s.time < cancelTime);
		return this;
	}

	setValueAtTime(value: number, time: number): this {
		this.#schedule({ kind: "set", value, time });
		return this;
	}

	exponentialRampToValueAtTime(value: number, time: number): this {
		if (!(value > 0)) {
			throw new RangeError(`exponential ramp to ${value}, which is not positive`);
		}
		this.#schedule({ kind: "ramp", value, time });
		return this;
	}

	#schedule(event: ScheduledValue): void {
		this.scheduled.push(event);
		this.#timeline.push(event);
	}
}

class FakeGainNode implements VolumeGainNode {
	readonly context = { currentTime: 0 };
	readonly gain = new FakeAudioParam(this.context);
}

/** controllerOn makes a controller on a fresh fake gain node. */
function controllerOn(options?: {
	initialVolume?: number;
	defaultVolume?: number;
	minGain?: number;
	fadeTimeMs?: number;
}): { controller: VolumeController; node: FakeGainNode } {
	const node = new FakeGainNode();
	return { controller: new VolumeController(node, options), node };
}

/** The values scheduled from the last ramp's start on. */
function lastFade(param: FakeAudioParam): ScheduledValue[] {
	const ramp = param.scheduled.findLastIndex((s) => s.kind === "ramp");
	return param.scheduled.slice(Math.max(0, ramp - 1));
}

Deno.test("VolumeController", async (t) => {
	await t.step("constructor", async (t) => {
		await t.step("creates with default volume", () => {
			const { controller } = controllerOn();
			assertEquals(controller.volume, 0.5);
			assertEquals(controller.muted, false);
		});

		await t.step("creates with custom initial volume", () => {
			const { controller } = controllerOn({ initialVolume: 0.8 });
			assertEquals(controller.volume, 0.8);
		});

		await t.step("creates with custom default volume", () => {
			const { controller } = controllerOn({ defaultVolume: 0.7 });
			assertEquals(controller.volume, 0.7);
		});
	});

	await t.step("fade time", async (t) => {
		await t.step("ends a fade the default 80 ms later on the audio clock", () => {
			const { controller, node } = controllerOn();
			node.context.currentTime = 10;

			controller.setVolume(0.3);

			assertEquals(lastFade(node.gain), [
				{ kind: "set", value: 0.5, time: 10 },
				{ kind: "ramp", value: 0.3, time: 10.08 },
			]);
		});

		await t.step("starts the first fade from the initial volume before any render", () => {
			const { controller, node } = controllerOn();

			controller.setVolume(0.8);

			assertEquals(lastFade(node.gain)[0], { kind: "set", value: 0.5, time: 0 });
		});

		await t.step("starts a fade mid-fade from the gain the curve has reached", () => {
			const { controller, node } = controllerOn();
			controller.setVolume(0.8);
			node.context.currentTime = 0.04;
			node.gain.render();

			controller.setVolume(0.2);

			// Halfway along the exponential ramp from 0.5 to 0.8.
			assertAlmostEquals(lastFade(node.gain)[0]?.value ?? NaN, Math.sqrt(0.5 * 0.8));
		});

		await t.step("takes the fade time in milliseconds", () => {
			const { controller, node } = controllerOn({ fadeTimeMs: 250 });

			controller.setVolume(0.3);

			assertEquals(lastFade(node.gain).at(-1), { kind: "ramp", value: 0.3, time: 0.25 });
		});

		const unusable = [
			{ name: "zero", fadeTimeMs: 0 },
			{ name: "negative", fadeTimeMs: -5 },
			{ name: "NaN", fadeTimeMs: NaN },
			{ name: "infinite", fadeTimeMs: Infinity },
		];
		for (const c of unusable) {
			await t.step(`falls back to the default fade when the fade time is ${c.name}`, () => {
				const { controller, node } = controllerOn({ fadeTimeMs: c.fadeTimeMs });

				controller.setVolume(0.3);

				assertEquals(lastFade(node.gain).at(-1), {
					kind: "ramp",
					value: 0.3,
					time: 0.08,
				});
			});
		}
	});

	await t.step("setVolume", async (t) => {
		await t.step("sets volume with fade", () => {
			const { controller } = controllerOn();
			controller.setVolume(0.8);
			assertEquals(controller.volume, 0.8);
		});

		await t.step("clamps volume to valid range", () => {
			const { controller } = controllerOn();
			controller.setVolume(-0.1);
			assertEquals(controller.volume, 0);

			controller.setVolume(1.5);
			assertEquals(controller.volume, 1);

			controller.setVolume(NaN);
			assertEquals(controller.volume, 1);

			controller.setVolume(Infinity);
			assertEquals(controller.volume, 1);
		});

		await t.step("fades below the smallest gain to minGain, then to silence", () => {
			const { controller, node } = controllerOn();

			controller.setVolume(0.0005);

			assertEquals(lastFade(node.gain), [
				{ kind: "set", value: 0.5, time: 0 },
				{ kind: "ramp", value: 0.001, time: 0.08 },
				{ kind: "set", value: 0, time: 0.08 },
			]);
		});

		await t.step("fades up out of silence from minGain", () => {
			const { controller, node } = controllerOn({ initialVolume: 0 });

			controller.setVolume(0.6);

			assertEquals(lastFade(node.gain), [
				{ kind: "set", value: 0.001, time: 0 },
				{ kind: "ramp", value: 0.6, time: 0.08 },
			]);
		});
	});

	await t.step("mute", async (t) => {
		await t.step("mutes and unmutes", () => {
			const { controller } = controllerOn();
			controller.setVolume(0.7);
			assertEquals(controller.muted, false);

			controller.mute(true);
			assertEquals(controller.muted, true);

			controller.mute(false);
			assertEquals(controller.muted, false);
		});

		await t.step("mutes by fading to minGain and then to silence", () => {
			const { controller, node } = controllerOn();
			controller.setVolume(0.7);
			node.context.currentTime = 1;

			controller.mute(true);

			assertEquals(lastFade(node.gain), [
				{ kind: "set", value: 0.7, time: 1 },
				{ kind: "ramp", value: 0.001, time: 1.08 },
				{ kind: "set", value: 0, time: 1.08 },
			]);
		});

		await t.step("restores the volume being faded to when muted mid-fade", () => {
			const { controller, node } = controllerOn();
			controller.setVolume(0.8);
			node.context.currentTime = 0.04;
			controller.mute(true);

			controller.mute(false);

			assertEquals(lastFade(node.gain).at(-1), { kind: "ramp", value: 0.8, time: 0.12 });
		});

		await t.step("reports the volume being faded to", () => {
			const { controller, node } = controllerOn();
			controller.setVolume(0.8);

			node.context.currentTime = 0.04;

			assertEquals(controller.volume, 0.8);
		});

		await t.step("keeps the gain silent when the volume is set while muted", () => {
			const { controller, node } = controllerOn();
			controller.mute(true);
			controller.setVolume(0.8);

			node.context.currentTime = 1;
			node.gain.render();

			assertEquals(node.gain.value, 0);
		});

		await t.step("reports no volume while muted after the volume is set", () => {
			const { controller } = controllerOn();
			controller.mute(true);

			controller.setVolume(0.8);

			assertEquals(controller.volume, 0);
		});

		await t.step("restores the volume set while muted on unmute", () => {
			const { controller, node } = controllerOn();
			controller.mute(true);
			controller.setVolume(0.8);
			node.context.currentTime = 1;

			controller.mute(false);

			assertEquals(lastFade(node.gain).at(-1), { kind: "ramp", value: 0.8, time: 1.08 });
		});

		await t.step("mutes low volume correctly", () => {
			const { controller } = controllerOn();
			controller.setVolume(0.0005);
			controller.mute(true);
			assertEquals(controller.volume, 0);
		});

		await t.step("restores previous volume when unmuting", () => {
			const { controller } = controllerOn();
			controller.setVolume(0.6);
			controller.mute(true);
			assertEquals(controller.volume, 0);

			controller.mute(false);
			assertEquals(controller.volume, 0.6);
		});

		await t.step("uses default volume if unmuting with zero volume", () => {
			const { controller } = controllerOn();
			controller.setVolume(0);
			controller.mute(true);
			controller.mute(false);
			assertEquals(controller.volume, 0.5);
		});
	});

	await t.step("getters", async (t) => {
		await t.step("volume getter returns current gain value", () => {
			const { controller } = controllerOn();
			controller.setVolume(0.4);
			assertEquals(controller.volume, 0.4);
		});

		await t.step("muted getter returns mute state", () => {
			const { controller } = controllerOn();
			assertEquals(controller.muted, false);
			controller.mute(true);
			assertEquals(controller.muted, true);
		});
	});
});

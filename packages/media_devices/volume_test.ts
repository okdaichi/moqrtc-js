import { assertEquals } from "@std/assert";
import { VolumeController, type VolumeGainNode, type VolumeParam } from "./volume.ts";

/** A value the fake param was told to reach: at once ("set") or by a ramp. */
interface ScheduledValue {
	kind: "set" | "ramp";
	value: number;
	time: number;
}

/**
 * FakeAudioParam records the values scheduled on it and takes each one at
 * once. Like a browser, it rejects an exponential ramp to a value that is
 * not positive.
 */
class FakeAudioParam implements VolumeParam {
	value: number;
	scheduled: ScheduledValue[] = [];

	constructor(initialValue = 1.0) {
		this.value = initialValue;
	}

	cancelScheduledValues(_cancelTime: number): this {
		return this;
	}

	setValueAtTime(value: number, time: number): this {
		this.scheduled.push({ kind: "set", value, time });
		this.value = value;
		return this;
	}

	exponentialRampToValueAtTime(value: number, time: number): this {
		if (!(value > 0)) {
			throw new RangeError(`exponential ramp to ${value}, which is not positive`);
		}
		this.scheduled.push({ kind: "ramp", value, time });
		this.value = value;
		return this;
	}
}

class FakeGainNode implements VolumeGainNode {
	readonly context = { currentTime: 0 };
	readonly gain = new FakeAudioParam();
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

			controller.mute(true);

			assertEquals(lastFade(node.gain), [
				{ kind: "set", value: 0.7, time: 0 },
				{ kind: "ramp", value: 0.001, time: 0.08 },
				{ kind: "set", value: 0, time: 0.08 },
			]);
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

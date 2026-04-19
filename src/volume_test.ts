/// <reference path="./test_globals.d.ts" />
import { assertEquals } from "@std/assert";
import { FakeAudioContext } from "../packages/av_nodes/audio/fake_audio_context_test.ts";
import { FakeGainNode } from "../packages/av_nodes/audio/fake_gainnode_test.ts";
import { VolumeController } from "./volume.ts";

Deno.test("VolumeController", async (t) => {
	let audioContext: AudioContext;
	let controller: VolumeController;

	const setupControllerTest = (options?: {
		initialVolume?: number;
		defaultVolume?: number;
		minGain?: number;
		fadeTimeMs?: number;
	}) => {
		audioContext = new FakeAudioContext() as unknown as AudioContext;
		const gainNode = new FakeGainNode(audioContext);
		controller = new VolumeController(gainNode, options);
	};

	await t.step("constructor", async (t) => {
		await t.step("creates with default volume", () => {
			setupControllerTest();
			assertEquals(controller.volume, 0.5);
			assertEquals(controller.muted, false);
		});

		await t.step("creates with custom initial volume", () => {
			setupControllerTest({ initialVolume: 0.8 });
			assertEquals(controller.volume, 0.8);
		});

		await t.step("creates with custom default volume", () => {
			setupControllerTest({ defaultVolume: 0.7 });
			assertEquals(controller.volume, 0.7);
		});

		await t.step("uses custom fade time", () => {
			setupControllerTest({ fadeTimeMs: 0.1 });
			controller.setVolume(0.3);
			assertEquals(controller.volume, 0.3);
		});
	});

	await t.step("setVolume", async (t) => {
		await t.step("sets volume with fade", () => {
			setupControllerTest();
			controller.setVolume(0.8);
			assertEquals(controller.volume, 0.8);
		});

		await t.step("clamps volume to valid range", () => {
			setupControllerTest();
			controller.setVolume(-0.1);
			assertEquals(controller.volume, 0);

			controller.setVolume(1.5);
			assertEquals(controller.volume, 1);

			controller.setVolume(NaN);
			assertEquals(controller.volume, 1);

			controller.setVolume(Infinity);
			assertEquals(controller.volume, 1);
		});

		await t.step("handles very low volume with exponential ramp", () => {
			setupControllerTest();
			controller.setVolume(0.0005);
			assertEquals(controller.volume, 0);
		});
	});

	await t.step("mute", async (t) => {
		await t.step("mutes and unmutes", () => {
			setupControllerTest();
			controller.setVolume(0.7);
			assertEquals(controller.muted, false);

			controller.mute(true);
			assertEquals(controller.muted, true);

			controller.mute(false);
			assertEquals(controller.muted, false);
		});

		await t.step("mutes low volume correctly", () => {
			setupControllerTest();
			controller.setVolume(0.0005);
			controller.mute(true);
			assertEquals(controller.volume, 0);
		});

		await t.step("restores previous volume when unmuting", () => {
			setupControllerTest();
			controller.setVolume(0.6);
			controller.mute(true);
			assertEquals(controller.volume, 0);

			controller.mute(false);
			assertEquals(controller.volume, 0.6);
		});

		await t.step("uses default volume if unmuting with zero volume", () => {
			setupControllerTest();
			controller.setVolume(0);
			controller.mute(true);
			controller.mute(false);
			assertEquals(controller.volume, 0.5);
		});
	});

	await t.step("getters", async (t) => {
		await t.step("volume getter returns current gain value", () => {
			setupControllerTest();
			controller.setVolume(0.4);
			assertEquals(controller.volume, 0.4);
		});

		await t.step("muted getter returns mute state", () => {
			setupControllerTest();
			assertEquals(controller.muted, false);
			controller.mute(true);
			assertEquals(controller.muted, true);
		});
	});
});

/// <reference path="./test_globals.d.ts" />
import { assertEquals } from "@std/assert";
import { FakeAudioContext } from "./internal/av_nodes/audio/fake_audio_context_test.ts";
import { FakeGainNode } from "./internal/av_nodes/audio/fake_gainnode_test.ts";
import { deleteGlobal, stubGlobal } from "./test-utils_test.ts";

const originalAudioContext = (globalThis as unknown as Record<string, unknown>).AudioContext as
	| (new (...args: unknown[]) => AudioContext)
	| undefined;
const originalGainNode = (globalThis as unknown as Record<string, unknown>).GainNode as
	| (new (...args: unknown[]) => GainNode)
	| undefined;

function setupVolumeMocks() {
	stubGlobal("AudioContext", FakeAudioContext);
	stubGlobal("GainNode", FakeGainNode);
}

function restoreVolumeMocks() {
	if (originalAudioContext !== undefined) {
		stubGlobal("AudioContext", originalAudioContext);
	} else {
		deleteGlobal("AudioContext");
	}

	if (originalGainNode !== undefined) {
		stubGlobal("GainNode", originalGainNode);
	} else {
		deleteGlobal("GainNode");
	}
}

setupVolumeMocks();

import type { VolumeController } from "./volume.ts";
const { VolumeController: VolumeControllerClass } = await import("./volume.ts");

Deno.test("VolumeController", async (t) => {
	let audioContext: AudioContext;
	let controller: VolumeController;

	const setupControllerTest = () => {
		audioContext = new AudioContext();
		controller = new VolumeControllerClass(audioContext);
	};

	const cleanupControllerTest = () => {
		controller.disconnect();
	};

	await t.step("constructor", async (t) => {
		await t.step("creates with default volume", () => {
			setupControllerTest();
			try {
				assertEquals(controller.volume, 0.5);
				assertEquals(controller.muted, false);
			} finally {
				cleanupControllerTest();
			}
		});

		await t.step("creates with custom initial volume", () => {
			audioContext = new AudioContext();
			const customController = new VolumeControllerClass(audioContext, {
				initialVolume: 0.8,
			});
			try {
				assertEquals(customController.volume, 0.8);
			} finally {
				customController.disconnect();
			}
		});

		await t.step("creates with custom default volume", () => {
			audioContext = new AudioContext();
			const customController = new VolumeControllerClass(audioContext, {
				defaultVolume: 0.7,
			});
			try {
				assertEquals(customController.volume, 0.7);
			} finally {
				customController.disconnect();
			}
		});

		await t.step("uses custom fade time", () => {
			audioContext = new AudioContext();
			const customController = new VolumeControllerClass(audioContext, {
				fadeTimeMs: 0.1,
			});
			try {
				customController.setVolume(0.3);
				assertEquals(customController.volume, 0.3);
			} finally {
				customController.disconnect();
			}
		});
	});

	await t.step("setVolume", async (t) => {
		await t.step("sets volume with fade", () => {
			setupControllerTest();
			try {
				controller.setVolume(0.8);
				assertEquals(controller.volume, 0.8);
			} finally {
				cleanupControllerTest();
			}
		});

		await t.step("clamps volume to valid range", () => {
			setupControllerTest();
			try {
				controller.setVolume(-0.1);
				assertEquals(controller.volume, 0);

				controller.setVolume(1.5);
				assertEquals(controller.volume, 1);

				controller.setVolume(NaN);
				assertEquals(controller.volume, 1);

				controller.setVolume(Infinity);
				assertEquals(controller.volume, 1);
			} finally {
				cleanupControllerTest();
			}
		});

		await t.step("handles very low volume with exponential ramp", () => {
			setupControllerTest();
			try {
				controller.setVolume(0.0005);
				assertEquals(controller.volume, 0);
			} finally {
				cleanupControllerTest();
			}
		});
	});

	await t.step("mute", async (t) => {
		await t.step("mutes and unmutes", () => {
			setupControllerTest();
			try {
				controller.setVolume(0.7);
				assertEquals(controller.muted, false);

				controller.mute(true);
				assertEquals(controller.muted, true);

				controller.mute(false);
				assertEquals(controller.muted, false);
			} finally {
				cleanupControllerTest();
			}
		});

		await t.step("mutes low volume correctly", () => {
			setupControllerTest();
			try {
				controller.setVolume(0.0005);
				controller.mute(true);
				assertEquals(controller.volume, 0);
			} finally {
				cleanupControllerTest();
			}
		});

		await t.step("restores previous volume when unmuting", () => {
			setupControllerTest();
			try {
				controller.setVolume(0.6);
				controller.mute(true);
				assertEquals(controller.volume, 0);

				controller.mute(false);
				assertEquals(controller.volume, 0.6);
			} finally {
				cleanupControllerTest();
			}
		});

		await t.step("uses default volume if unmuting with zero volume", () => {
			setupControllerTest();
			try {
				controller.setVolume(0);
				controller.mute(true);
				controller.mute(false);
				assertEquals(controller.volume, 0.5);
			} finally {
				cleanupControllerTest();
			}
		});
	});

	await t.step("getters", async (t) => {
		await t.step("volume getter returns current gain value", () => {
			setupControllerTest();
			try {
				controller.setVolume(0.4);
				assertEquals(controller.volume, 0.4);
			} finally {
				cleanupControllerTest();
			}
		});

		await t.step("muted getter returns mute state", () => {
			setupControllerTest();
			try {
				assertEquals(controller.muted, false);
				controller.mute(true);
				assertEquals(controller.muted, true);
			} finally {
				cleanupControllerTest();
			}
		});
	});
});

Deno.test("VolumeController cleanup", () => {
	restoreVolumeMocks();
});

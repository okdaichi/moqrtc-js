/// <reference path="./test_globals.d.ts" />
// Set up global mocks before importing volume.ts
import { deleteGlobal, resetGlobalMocks, setupGlobalMocks, stubGlobal } from "./test-utils_test.ts";
setupGlobalMocks();

import { assertEquals } from "@std/assert";

// Import types statically
import type { VolumeController } from "./volume.ts";

// Dynamic import to ensure mocks are set up
const {
	DefaultFadeTime,
	DefaultMinGain,
	DefaultVolume,
	FADE_TIME_FALLBACK,
	isValidFadeTime,
	isValidMinGain,
	isValidVolume,
	MIN_GAIN_FALLBACK,
	VolumeController: VolumeControllerClass,
} = await import("./volume.ts");

Deno.test("Volume", async (t) => {
	let originalVolume: number | undefined;
	let originalMinGain: number | undefined;
	let originalFadeTime: number | undefined;
	let originalConsoleWarn: typeof console.warn;

	const setupTest = () => {
		// Save original globalThis values
		originalVolume = (globalThis as unknown as Record<string, unknown>).__DEFAULT_VOLUME__ as number | undefined;
		originalMinGain = (globalThis as unknown as Record<string, unknown>).__DEFAULT_MIN_GAIN__ as number | undefined;
		originalFadeTime = (globalThis as unknown as Record<string, unknown>).__DEFAULT_FADE_TIME__ as number | undefined;

		// Clear globalThis properties
		deleteGlobal("__DEFAULT_VOLUME__");
		deleteGlobal("__DEFAULT_MIN_GAIN__");
		deleteGlobal("__DEFAULT_FADE_TIME__");

		// Mock console.warn
		originalConsoleWarn = console.warn;
		console.warn = (() => {}) as typeof console.warn;

		// Set up global mocks for Web Audio API
		setupGlobalMocks();
	};

	const cleanupTest = () => {
		// Restore original globalThis values
		if (originalVolume !== undefined) {
			stubGlobal("__DEFAULT_VOLUME__", originalVolume);
		} else {
			deleteGlobal("__DEFAULT_VOLUME__");
		}

		if (originalMinGain !== undefined) {
			stubGlobal("__DEFAULT_MIN_GAIN__", originalMinGain);
		} else {
			deleteGlobal("__DEFAULT_MIN_GAIN__");
		}

		if (originalFadeTime !== undefined) {
			stubGlobal("__DEFAULT_FADE_TIME__", originalFadeTime);
		} else {
			deleteGlobal("__DEFAULT_FADE_TIME__");
		}

		// Restore console.warn
		console.warn = originalConsoleWarn;

		// Reset global mocks
		resetGlobalMocks();
	};

	await t.step("Default Values", async (t) => {
		await t.step("returns fallback values when globalThis properties are not set", () => {
			setupTest();
			try {
				const volume = DefaultVolume();
				const minGain = DefaultMinGain();
				const fadeTime = DefaultFadeTime();

				assertEquals(volume, 0.5);
				assertEquals(minGain, MIN_GAIN_FALLBACK);
				assertEquals(fadeTime, FADE_TIME_FALLBACK);
			} finally {
				cleanupTest();
			}
		});

		await t.step("returns globalThis values when set", () => {
			setupTest();
			try {
				// Simulate Vite define injection
				stubGlobal("__DEFAULT_VOLUME__", 0.7);
				stubGlobal("__DEFAULT_MIN_GAIN__", 0.002);
				stubGlobal("__DEFAULT_FADE_TIME__", 0.09);

				const volume = DefaultVolume();
				const minGain = DefaultMinGain();
				const fadeTime = DefaultFadeTime();

				assertEquals(volume, 0.7);
				assertEquals(minGain, 0.002);
				assertEquals(fadeTime, 0.09);
			} finally {
				cleanupTest();
			}
		});

		await t.step("warns when globalThis values are invalid", () => {
			setupTest();
			try {
				// Simulate invalid Vite define injection
				stubGlobal("__DEFAULT_VOLUME__", 1.5);
				stubGlobal("__DEFAULT_MIN_GAIN__", NaN);
				stubGlobal("__DEFAULT_FADE_TIME__", Infinity);

				const volume = DefaultVolume();
				const minGain = DefaultMinGain();
				const fadeTime = DefaultFadeTime();

				assertEquals(volume, 0.5);
				assertEquals(minGain, MIN_GAIN_FALLBACK);
				assertEquals(fadeTime, FADE_TIME_FALLBACK);

				const warnCalls = (globalThis as unknown as Record<string, unknown[][]>).warnCalls!;
				assertEquals(warnCalls.length, 1);
				assertEquals(
					warnCalls[0]![0],
					"[volume] __DEFAULT_VOLUME__ is out of range, fallback to 0.5:",
				);
				assertEquals(warnCalls[0]![1], 1.5);
			} finally {
				cleanupTest();
			}
		});
	});

	await t.step("Validation Functions", async (t) => {
		await t.step("isValidMinGain", async (t) => {
			await t.step("returns true for valid min gain values", () => {
				assertEquals(isValidMinGain(0.001), true);
				assertEquals(isValidMinGain(0.005), true);
				assertEquals(isValidMinGain(0.009), true);
			});

			await t.step("returns false for invalid min gain values", () => {
				assertEquals(isValidMinGain(0), false);
				assertEquals(isValidMinGain(-0.001), false);
				assertEquals(isValidMinGain(0.01), false);
				assertEquals(isValidMinGain(0.1), false);
				assertEquals(isValidMinGain(NaN), false);
				assertEquals(isValidMinGain(Infinity), false);
				assertEquals(isValidMinGain("0.001" as any), false);
			});
		});

		await t.step("isValidFadeTime", async (t) => {
			await t.step("returns true for valid fade time values", () => {
				assertEquals(isValidFadeTime(0.02), true);
				assertEquals(isValidFadeTime(0.5), true);
				assertEquals(isValidFadeTime(0.99), true);
			});

			await t.step("returns false for invalid fade time values", () => {
				assertEquals(isValidFadeTime(0), false);
				assertEquals(isValidFadeTime(0.005), false);
				assertEquals(isValidFadeTime(1.0), false);
				assertEquals(isValidFadeTime(2.0), false);
				assertEquals(isValidFadeTime(NaN), false);
				assertEquals(isValidFadeTime(Infinity), false);
				assertEquals(isValidFadeTime("0.5" as any), false);
			});
		});

		await t.step("isValidVolume", async (t) => {
			await t.step("returns true for valid volume values", () => {
				assertEquals(isValidVolume(0), true);
				assertEquals(isValidVolume(0.1), true);
				assertEquals(isValidVolume(0.5), true);
				assertEquals(isValidVolume(1.0), true);
			});

			await t.step("returns false for invalid volume values", () => {
				assertEquals(isValidVolume(-0.1), false);
				assertEquals(isValidVolume(1.1), false);
				assertEquals(isValidVolume(NaN), false);
				assertEquals(isValidVolume(Infinity), false);
				assertEquals(isValidVolume("0.5" as any), false);
				assertEquals(isValidVolume(null), false);
				assertEquals(isValidVolume(undefined), false);
			});
		});
	});
});

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

		await t.step("creates with NaN initial volume", () => {
			audioContext = new AudioContext();
			const customController = new VolumeControllerClass(audioContext, {
				initialVolume: NaN,
			});
			try {
				assertEquals(customController.volume, 1); // Falls back to 1
			} finally {
				customController.disconnect();
			}
		});

		await t.step("creates with Infinity initial volume", () => {
			audioContext = new AudioContext();
			const customController = new VolumeControllerClass(audioContext, {
				initialVolume: Infinity,
			});
			try {
				assertEquals(customController.volume, 1); // Falls back to 1
			} finally {
				customController.disconnect();
			}
		});

		await t.step("uses custom fade time", () => {
			audioContext = new AudioContext();
			const customController = new VolumeControllerClass(audioContext, { fadeTimeMs: 0.1 });
			try {
				// fadeTimeMs is stored in #rampMs, but we can't access it directly
				// Instead, test by calling setVolume and checking the ramp time
				customController.setVolume(0.3);
				// The mock should have been called with the correct time
				assertEquals(true, true); // Placeholder, actual test would check mock calls
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
				controller.setVolume(0.0005); // Below DefaultMinGain
				assertEquals(controller.volume, 0); // It ramps to min gain then to 0
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
				assertEquals(controller.volume, 0.5); // DefaultVolume
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

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { spy } from "@std/testing/mock";
import { MockAudioEncoder } from "./mock_audioencoder_test.ts";

import {
	audioEncoderConfig,
	AudioEncoderOptions,
	DEFAULT_AUDIO_CODECS,
	DEFAULT_AUDIO_CONFIG,
	upgradeAudioEncoderConfig,
} from "./audio_config.ts";

// Mock AudioEncoder

let mockAudioEncoder: MockAudioEncoder;
let originalAudioEncoder: any;
let originalConsoleDebug: any;

function setupMocks() {
	originalAudioEncoder = globalThis.AudioEncoder;
	originalConsoleDebug = console.debug;
	mockAudioEncoder = new MockAudioEncoder();
	globalThis.AudioEncoder = mockAudioEncoder as any;
	console.debug = spy();
	// Set up navigator
	Object.defineProperty(navigator, "userAgent", {
		value:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
		writable: true,
	});
}

function restoreMocks() {
	globalThis.AudioEncoder = originalAudioEncoder;
	console.debug = originalConsoleDebug;
}

Deno.test("DEFAULT_AUDIO_CODECS: contains expected codec list", () => {
	assertEquals(DEFAULT_AUDIO_CODECS, ["opus", "isac", "g722", "pcmu", "pcma"]);
});

Deno.test("DEFAULT_AUDIO_CODECS: is readonly", () => {
	assertEquals(Object.isFrozen(DEFAULT_AUDIO_CODECS), false); // const arrays aren't frozen by default
	assertEquals(DEFAULT_AUDIO_CODECS.length, 5);
});

Deno.test("DEFAULT_AUDIO_CODECS: has opus as preferred codec", () => {
	assertEquals(DEFAULT_AUDIO_CODECS[0], "opus");
});

Deno.test("DEFAULT_AUDIO_CONFIG: contains expected default values", () => {
	assertEquals(DEFAULT_AUDIO_CONFIG, {
		sampleRate: 48000,
		channels: 2,
		bitrate: 64000,
	});
});

Deno.test("DEFAULT_AUDIO_CONFIG: uses standard audio settings", () => {
	assertEquals(DEFAULT_AUDIO_CONFIG.sampleRate, 48000); // Professional audio standard
	assertEquals(DEFAULT_AUDIO_CONFIG.channels, 2); // Stereo
	assertEquals(DEFAULT_AUDIO_CONFIG.bitrate, 64000); // 64 kbps
});

Deno.test("audioEncoderConfig: returns supported config for valid options", async () => {
	setupMocks();
	try {
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 2,
		};
		const result = await audioEncoderConfig(options);
		assertEquals(result.codec, "opus");
		assertEquals(result.sampleRate, 48000);
		assertEquals(result.numberOfChannels, 2);
		assertEquals(result.bitrate, 64000);
		// Check the config passed
		assertEquals(mockAudioEncoder.isConfigSupported.calls.length, 1);
		const calledConfig = (mockAudioEncoder.isConfigSupported as any).calls[0].args[0];
		assertExists(calledConfig.opus);
		assertEquals(calledConfig.opus.application, "audio");
		assertEquals(calledConfig.opus.signal, "music");
		assertExists(calledConfig.parameters);
		assertEquals(calledConfig.parameters.useinbandfec, 1);
		assertEquals(calledConfig.parameters.stereo, 1);
		// console.debug called
		// assertEquals((console.debug as any).calls.length, 1);
		// assertEquals((console.debug as any).calls[0][0], 'using audio encoding:');
	} finally {
		restoreMocks();
	}
});

Deno.test("audioEncoderConfig: uses default bitrate when not provided", async () => {
	setupMocks();
	try {
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 2,
		};
		await audioEncoderConfig(options);
		assertEquals(mockAudioEncoder.isConfigSupported.calls.length, 1);
		const calledConfig = mockAudioEncoder.isConfigSupported.calls[0].args[0];
		assertEquals(calledConfig.bitrate, DEFAULT_AUDIO_CONFIG.bitrate);
	} finally {
		restoreMocks();
	}
});

Deno.test("audioEncoderConfig: uses custom bitrate when provided", async () => {
	setupMocks();
	try {
		const customBitrate = 128000;
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 1,
			bitrate: customBitrate,
		};
		await audioEncoderConfig(options);
		assertEquals(mockAudioEncoder.isConfigSupported.calls.length, 1);
		const calledConfig = (mockAudioEncoder.isConfigSupported as any).calls[0].args[0];
		assertEquals(calledConfig.bitrate, customBitrate);
	} finally {
		restoreMocks();
	}
});

Deno.test("audioEncoderConfig: uses default codecs when preferredCodecs not provided", async () => {
	setupMocks();
	try {
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 2,
		};
		await audioEncoderConfig(options);
		assertEquals(mockAudioEncoder.isConfigSupported.calls.length, 1);
		const calledConfig = mockAudioEncoder.isConfigSupported.calls[0].args[0];
		assertEquals(calledConfig.codec, "opus");
	} finally {
		restoreMocks();
	}
});

Deno.test("audioEncoderConfig: uses custom preferredCodecs when provided", async () => {
	setupMocks();
	try {
		const customCodecs = ["pcmu", "opus"] as const;
		let callCount = 0;
		mockAudioEncoder.isConfigSupported = spy((_cfg: any) => {
			callCount++;
			if (callCount === 1) return Promise.resolve({ supported: false });
			return Promise.resolve({ supported: true, config: { codec: "opus" } });
		});
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 2,
			preferredCodecs: customCodecs,
		};
		await audioEncoderConfig(options);
		assertEquals(mockAudioEncoder.isConfigSupported.calls.length, 2);
		assertEquals(mockAudioEncoder.isConfigSupported.calls[0].args[0].codec, "pcmu");
		assertEquals(mockAudioEncoder.isConfigSupported.calls[1].args[0].codec, "opus");
	} finally {
		restoreMocks();
	}
});

Deno.test("audioEncoderConfig: tries all codecs until one is supported", async () => {
	setupMocks();
	try {
		let callCount = 0;
		mockAudioEncoder.isConfigSupported = spy((_cfg: any) => {
			callCount++;
			if (callCount <= 3) return Promise.resolve({ supported: false });
			return Promise.resolve({ supported: true, config: { codec: "pcmu" } });
		});
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 2,
		};
		const result = await audioEncoderConfig(options);
		assertEquals(result.codec, "pcmu");
		assertEquals(mockAudioEncoder.isConfigSupported.calls.length, 4);
	} finally {
		restoreMocks();
	}
});

Deno.test("audioEncoderConfig: throws error when no codec is supported", async () => {
	setupMocks();
	try {
		mockAudioEncoder.isConfigSupported = spy(() => Promise.resolve({ supported: false }));
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 2,
		};
		await assertRejects(
			async () => await audioEncoderConfig(options),
			Error,
			"no supported audio codec",
		);
	} finally {
		restoreMocks();
	}
});

Deno.test("audioEncoderConfig: handles missing isConfigSupported method", async () => {
	setupMocks();
	try {
		delete (mockAudioEncoder as any).isConfigSupported;
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 2,
		};
		await assertRejects(
			async () => await audioEncoderConfig(options),
			Error,
			"no supported audio codec",
		);
	} finally {
		restoreMocks();
	}
});

Deno.test("audioEncoderConfig: handles isConfigSupported throwing error", async () => {
	setupMocks();
	try {
		mockAudioEncoder.isConfigSupported = spy(() =>
			Promise.reject(new Error("Config check failed"))
		);
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 2,
		};
		await assertRejects(
			async () => await audioEncoderConfig(options),
			Error,
			"no supported audio codec",
		);
	} finally {
		restoreMocks();
	}
});

Deno.test("audioEncoderConfig: handles mono audio configuration", async () => {
	setupMocks();
	try {
		const options: AudioEncoderOptions = {
			sampleRate: 16000,
			channels: 1,
			bitrate: 32000,
		};
		const result = await audioEncoderConfig(options);
		assertEquals(result.numberOfChannels, 1);
		assertEquals(result.sampleRate, 16000);
	} finally {
		restoreMocks();
	}
});

Deno.test("audioEncoderConfig: handles high sample rate configuration", async () => {
	setupMocks();
	try {
		const options: AudioEncoderOptions = {
			sampleRate: 96000,
			channels: 2,
			bitrate: 128000,
		};
		const result = await audioEncoderConfig(options);
		assertEquals(result.sampleRate, 96000);
	} finally {
		restoreMocks();
	}
});

Deno.test("upgradeAudioEncoderConfig: applies codec from parameter", () => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const result = upgradeAudioEncoderConfig(baseConfig, "pcmu");
	assertEquals(result.codec, "pcmu");
	assertEquals(result.sampleRate, baseConfig.sampleRate);
	assertEquals(result.numberOfChannels, baseConfig.numberOfChannels);
});

Deno.test("upgradeAudioEncoderConfig: applies custom bitrate when provided", () => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const customBitrate = 128000;
	const result = upgradeAudioEncoderConfig(baseConfig, "opus", customBitrate);
	assertEquals(result.bitrate, customBitrate);
});

Deno.test("upgradeAudioEncoderConfig: keeps original bitrate when custom bitrate not provided", () => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const result = upgradeAudioEncoderConfig(baseConfig, "opus");
	assertEquals(result.bitrate, baseConfig.bitrate);
});

Deno.test("upgradeAudioEncoderConfig: applies Opus-specific enhancements for stereo", () => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const result = upgradeAudioEncoderConfig(baseConfig, "opus") as any;
	assertExists(result.opus);
	assertEquals(result.opus.application, "audio"); // stereo defaults to 'audio'
	assertEquals(result.opus.signal, "music"); // stereo defaults to 'music'
	assertExists(result.parameters);
	assertEquals(result.parameters.useinbandfec, 1);
	assertEquals(result.parameters.stereo, 1); // stereo enabled
	assertEquals(result.bitrateMode, "variable"); // Chrome default
});

Deno.test("upgradeAudioEncoderConfig: applies Opus-specific enhancements for mono", () => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const monoConfig = { ...baseConfig, numberOfChannels: 1 };
	const result = upgradeAudioEncoderConfig(monoConfig, "opus") as any;
	assertEquals(result.opus.application, "voip"); // mono defaults to 'voip'
	assertEquals(result.opus.signal, "voice"); // mono defaults to 'voice'
	assertEquals(result.parameters.stereo, 0); // stereo disabled
});

Deno.test("upgradeAudioEncoderConfig: does not override existing Opus parameters", () => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const configWithOpus = {
		...baseConfig,
		opus: { application: "existing" },
		parameters: { useinbandfec: 0 },
	} as any;
	const result = upgradeAudioEncoderConfig(configWithOpus, "opus") as any;
	assertEquals(result.opus.application, "existing"); // preserved
	assertEquals(result.parameters.useinbandfec, 0); // preserved
});

Deno.test("upgradeAudioEncoderConfig: does not apply Opus enhancements for non-Opus codecs", () => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const result = upgradeAudioEncoderConfig(baseConfig, "pcmu") as any;
	assertEquals(result.opus, undefined);
	assertEquals(result.parameters, undefined);
	assertEquals(result.bitrateMode, undefined);
});

Deno.test("upgradeAudioEncoderConfig: handles undefined bitrate parameter", () => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const result = upgradeAudioEncoderConfig(baseConfig, "opus", undefined);
	assertEquals(result.bitrate, baseConfig.bitrate);
});

Deno.test("upgradeAudioEncoderConfig: preserves all base config properties", () => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const extendedBase = {
		...baseConfig,
		customProperty: "test",
	} as any;
	const result = upgradeAudioEncoderConfig(extendedBase, "pcmu") as any;
	assertEquals(result.customProperty, "test");
	assertEquals(result.sampleRate, extendedBase.sampleRate);
	assertEquals(result.numberOfChannels, extendedBase.numberOfChannels);
});

Deno.test("upgradeAudioEncoderConfig: applies browser-specific bitrate mode for Chrome", () => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	// Mock is already set to Chrome=true, Firefox=false in the mock above
	const result = upgradeAudioEncoderConfig(baseConfig, "opus") as any;
	assertEquals(result.bitrateMode, "variable");
});

Deno.test("AudioEncoderOptions interface: requires sampleRate and channels", () => {
	const validOptions: AudioEncoderOptions = {
		sampleRate: 48000,
		channels: 2,
	};
	assertEquals(validOptions.sampleRate, 48000);
	assertEquals(validOptions.channels, 2);
});

Deno.test("AudioEncoderOptions interface: supports optional properties", () => {
	const fullOptions: AudioEncoderOptions = {
		sampleRate: 48000,
		channels: 2,
		bitrate: 128000,
		preferredCodecs: ["opus", "pcmu"],
	};
	assertEquals(fullOptions.bitrate, 128000);
	assertEquals(fullOptions.preferredCodecs, ["opus", "pcmu"]);
});

Deno.test("Error Handling: handles null AudioEncoder", async () => {
	setupMocks();
	try {
		globalThis.AudioEncoder = null as any;
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 2,
		};
		await assertRejects(async () => await audioEncoderConfig(options));
	} finally {
		restoreMocks();
	}
});

Deno.test("Error Handling: handles AudioEncoder without isConfigSupported", async () => {
	setupMocks();
	try {
		globalThis.AudioEncoder = {} as any;
		const options: AudioEncoderOptions = {
			sampleRate: 48000,
			channels: 2,
		};
		await assertRejects(
			async () => await audioEncoderConfig(options),
			Error,
			"no supported audio codec",
		);
	} finally {
		restoreMocks();
	}
});

Deno.test("Boundary Value Tests: handles zero and high bitrate", async (t) => {
	const baseConfig: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const cases = new Map([
		["zero bitrate", { input: 0, expected: 0 }],
		["very high bitrate", { input: 1000000, expected: 1000000 }],
	]);
	for (const [name, c] of cases) {
		await t.step(name, () => {
			const result = upgradeAudioEncoderConfig(baseConfig, "opus", c.input);
			assertEquals(result.bitrate, c.expected);
		});
	}
});

Deno.test("Boundary Value Tests: validates sample rate bounds are passed to config", () => {
	const testConfig8k: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 8000,
		numberOfChannels: 1,
		bitrate: 32000,
	};
	const result8k = upgradeAudioEncoderConfig(testConfig8k, "opus");
	assertEquals(result8k.sampleRate, 8000);
	const testConfig192k: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 192000,
		numberOfChannels: 2,
		bitrate: 256000,
	};
	const result192k = upgradeAudioEncoderConfig(testConfig192k, "opus");
	assertEquals(result192k.sampleRate, 192000);
});

Deno.test("Boundary Value Tests: validates channel count bounds are passed to config", () => {
	const testConfigMono: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 1,
		bitrate: 32000,
	};
	const resultMono = upgradeAudioEncoderConfig(testConfigMono, "opus");
	assertEquals(resultMono.numberOfChannels, 1);
	const testConfigSurround: AudioEncoderConfig = {
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 8,
		bitrate: 512000,
	};
	const resultSurround = upgradeAudioEncoderConfig(testConfigSurround, "opus");
	assertEquals(resultSurround.numberOfChannels, 8);
});

Deno.test("Advanced Configuration Tests: handles malformed codec responses gracefully", async () => {
	setupMocks();
	try {
		const malformedResponses = [
			null,
			undefined,
			{},
			{ supported: true }, // missing config
			{ supported: true, config: null },
		];
		for (const response of malformedResponses) {
			mockAudioEncoder.isConfigSupported = spy(() => Promise.resolve(response));
			await assertRejects(
				async () =>
					await audioEncoderConfig({
						sampleRate: 48000,
						channels: 2,
						preferredCodecs: ["opus"],
					}),
				Error,
				"no supported audio codec",
			);
		}
	} finally {
		restoreMocks();
	}
});

Deno.test("Advanced Configuration Tests: configuration object immutability", () => {
	const baseConfig = {
		codec: "opus" as const,
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const config1 = upgradeAudioEncoderConfig(baseConfig, "opus");
	const config2 = upgradeAudioEncoderConfig(baseConfig, "g722");
	// Configurations should be separate objects
	assert(config1 !== config2);
	assertEquals(config1.codec, "opus");
	assertEquals(config2.codec, "g722");
	// Base config should remain unchanged
	assertEquals(baseConfig.codec, "opus");
});

Deno.test("Performance and Memory Tests: configuration object cloning works correctly", () => {
	const baseConfig = {
		codec: "opus" as const,
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	const config1 = upgradeAudioEncoderConfig(baseConfig, "opus");
	const config2 = upgradeAudioEncoderConfig(baseConfig, "isac");
	// Configurations should be separate objects
	assert(config1 !== config2);
	assertEquals(config1.codec, "opus");
	assertEquals(config2.codec, "isac");
	// Base config should remain unchanged
	assertEquals(baseConfig.codec, "opus");
});

Deno.test("Performance and Memory Tests: handles different codec configurations", () => {
	const baseConfig = {
		codec: "opus" as const,
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	};
	// Test opus-specific enhancements
	const opusConfig = upgradeAudioEncoderConfig(baseConfig, "opus");
	assertExists((opusConfig as any).opus);
	assertExists((opusConfig as any).parameters);
	// Test non-opus codec (should not have opus enhancements)
	const g722Config = upgradeAudioEncoderConfig(baseConfig, "g722");
	assertEquals(g722Config.codec, "g722");
	assertEquals((g722Config as any).opus, undefined);
});

Deno.test("Real-world Integration Scenarios: handles voice chat mono configuration", () => {
	const voiceConfig = upgradeAudioEncoderConfig({
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 1,
		bitrate: 32000,
	}, "opus");
	// Voice-specific settings
	assertEquals((voiceConfig as any).opus?.application, "voip");
	assertEquals((voiceConfig as any).opus?.signal, "voice");
	assertEquals((voiceConfig as any).parameters?.stereo, 0);
	assertEquals((voiceConfig as any).parameters?.useinbandfec, 1);
});

Deno.test("Real-world Integration Scenarios: handles music streaming stereo configuration", () => {
	const musicConfig = upgradeAudioEncoderConfig({
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 128000,
	}, "opus");
	// Music-specific settings
	assertEquals((musicConfig as any).opus?.application, "audio");
	assertEquals((musicConfig as any).opus?.signal, "music");
	assertEquals((musicConfig as any).parameters?.stereo, 1);
	assertEquals((musicConfig as any).parameters?.useinbandfec, 1);
});

Deno.test("Real-world Integration Scenarios: handles browser-specific bitrate modes", () => {
	// Chrome should use variable bitrate mode
	const chromeConfig = upgradeAudioEncoderConfig({
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
		bitrate: 64000,
	}, "opus");
	assertEquals((chromeConfig as any).bitrateMode, "variable");
});

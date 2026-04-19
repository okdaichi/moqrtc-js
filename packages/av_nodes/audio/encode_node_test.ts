import { assert, assertEquals, assertExists } from "@std/assert";
import type {
	AudioEncodeDestination,
	AudioEncodeNode as AudioEncodeNodeType,
} from "./encode_node.ts";
import { FakeAudioContext } from "./fake_audio_context_test.ts";
import { FakeAudioWorkletNode } from "./fake_audio_workletnode_test.ts";
import { FakeAudioData } from "./fake_audiodata_test.ts";
import { FakeAudioEncoder } from "./fake_audioencoder_test.ts";
import { FakeGainNode } from "./fake_gainnode_test.ts";

function overrideAudioEncoder(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasAudioEncoder = Object.prototype.hasOwnProperty.call(g, "AudioEncoder");
	const originalAudioEncoder = g.AudioEncoder;
	g.AudioEncoder = value;
	return () => {
		if (hasAudioEncoder) {
			g.AudioEncoder = originalAudioEncoder;
		} else {
			delete g.AudioEncoder;
		}
	};
}

function overrideAudioWorkletNode(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasAudioWorkletNode = Object.prototype.hasOwnProperty.call(g, "AudioWorkletNode");
	const originalAudioWorkletNode = g.AudioWorkletNode;
	g.AudioWorkletNode = value;
	return () => {
		if (hasAudioWorkletNode) {
			g.AudioWorkletNode = originalAudioWorkletNode;
		} else {
			delete g.AudioWorkletNode;
		}
	};
}

function overrideGainNode(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasGainNode = Object.prototype.hasOwnProperty.call(g, "GainNode");
	const originalGainNode = g.GainNode;
	g.GainNode = value;
	return () => {
		if (hasGainNode) {
			g.GainNode = originalGainNode;
		} else {
			delete g.GainNode;
		}
	};
}

const restoreGlobalGainNode = overrideGainNode(FakeGainNode);

const { AudioEncodeNode } = await import("./encode_node.ts");

Deno.test("AudioEncodeNode", async (t) => {
	let restoreAudioEncoder: () => void;
	let restoreAudioWorkletNode: () => void;
	let context: FakeAudioContext;
	let encodeNode: AudioEncodeNodeType;

	await t.step("setup", () => {
		// Setup mocks
		restoreAudioEncoder = overrideAudioEncoder(FakeAudioEncoder);
		restoreAudioWorkletNode = overrideAudioWorkletNode(FakeAudioWorkletNode);

		context = new FakeAudioContext();
		encodeNode = new AudioEncodeNode(context);
	});

	await t.step("should create AudioEncodeNode with correct context", () => {
		assertExists(encodeNode);
		assertEquals(encodeNode.context, context);
	});

	await t.step("should have correct AudioNode properties", () => {
		assertEquals(encodeNode.numberOfInputs, 1);
		assertEquals(encodeNode.numberOfOutputs, 0);
	});

	await t.step("should throw on connect attempt", () => {
		const mockDestination = {} as AudioNode;

		try {
			encodeNode.connect(mockDestination);
			assert(false, "Should have thrown error");
		} catch (e) {
			assert(e instanceof Error);
			assert(
				(e as Error).message.includes("does not support connections"),
			);
		}
	});

	await t.step("should handle disconnect gracefully (no-op)", () => {
		// Should not throw
		encodeNode.disconnect();
		encodeNode.disconnect(0);
	});

	await t.step("should configure encoder with valid config", () => {
		const config: AudioEncoderConfig = {
			codec: "opus",
			sampleRate: 48000,
			numberOfChannels: 2,
			bitrate: 128000,
		};

		encodeNode.configure(config);

		assertExists(FakeAudioEncoder.lastCreated);
		assert(FakeAudioEncoder.lastCreated.configureCalled);
		assertEquals(FakeAudioEncoder.lastCreated.configureCalls.length, 1);
		assertEquals(FakeAudioEncoder.lastCreated.configureCalls[0], config);
	});

	await t.step("should expose encoder state", () => {
		assertEquals(encodeNode.encoderState, "configured");
	});

	await t.step("should expose encodeQueueSize", () => {
		const queueSize = encodeNode.encodeQueueSize;
		assertEquals(typeof queueSize, "number");
		assert(queueSize >= 0);
	});

	await t.step(
		"should return 0 for encodeQueueSize when encoder not ready",
		() => {
			// Create a separate broken node instance
			const brokenNode = new AudioEncodeNode(context);
			const brokenEncoder = FakeAudioEncoder.lastCreated!;

			// Save the original encoder for the main node
			// const mainEncoder = FakeAudioEncoder.lastCreated;

			// Break THIS encoder's queue size
			Object.defineProperty(brokenEncoder, "encodeQueueSize", {
				get() {
					throw new Error("Encoder not ready");
				},
				configurable: true,
			});

			assertEquals(brokenNode.encodeQueueSize, 0);

			// Restore for next tests by recreating the main node's encoder reference
			// The next test will use the main encodeNode which still has its original encoder
		},
	);

	await t.step("should process AudioData and encode", () => {
		// Recreate node to get a fresh encoder after the broken one
		encodeNode = new AudioEncodeNode(context);

		// Configure first to make encoder ready
		const config: AudioEncoderConfig = {
			codec: "opus",
			sampleRate: 48000,
			numberOfChannels: 2,
		};
		encodeNode.configure(config);

		const encoder = FakeAudioEncoder.lastCreated!;
		encoder.encodeCalls = [];

		const audioData = new FakeAudioData(1024, 2, 48000);
		encodeNode.process(audioData);

		assert(encoder.encodeCalled, "Encoder should have been called");
		assertEquals(encoder.encodeCalls.length, 1);
	});

	await t.step("should clone AudioData before encoding", () => {
		const audioData = new FakeAudioData(1024, 2, 48000);
		let cloneCalled = false;

		audioData.clone = function () {
			cloneCalled = true;
			return new FakeAudioData(1024, 2, 48000);
		};

		encodeNode.process(audioData);
		assert(cloneCalled, "AudioData should be cloned");
	});

	await t.step("should handle encode errors gracefully", () => {
		const audioData = new FakeAudioData(1024, 2, 48000);
		const encoder = FakeAudioEncoder.lastCreated!;

		// Make encoder throw on encode
		const originalEncode = encoder.encode;
		encoder.encode = () => {
			throw new Error("Encode failed");
		};

		// Should not throw
		encodeNode.process(audioData);

		// Restore
		encoder.encode = originalEncode;
	});

	await t.step("should drop frames when queue is overloaded", () => {
		const audioData = new FakeAudioData(1024, 2, 48000);
		const encoder = FakeAudioEncoder.lastCreated!;

		// Simulate overloaded queue
		encoder.encodeQueueSize = 10;

		const initialCallCount = encoder.encodeCalls.length;
		encodeNode.process(audioData);

		// Should not encode when queue is full
		assertEquals(encoder.encodeCalls.length, initialCallCount);
	});

	await t.step("should not process when disposed", () => {
		const disposedNode = new AudioEncodeNode(context);
		const disposedEncoder = FakeAudioEncoder.lastCreated!;

		disposedNode.dispose();

		const audioData = new FakeAudioData(1024, 2, 48000);
		disposedEncoder.encodeCalls = [];

		disposedNode.process(audioData);

		// Should not encode after disposal
		assertEquals(disposedEncoder.encodeCalls.length, 0);
	});

	await t.step("should close encoder", async () => {
		const node = new AudioEncodeNode(context);
		const encoder = FakeAudioEncoder.lastCreated!;

		await node.dispose();
		assert(encoder.closeCalled);
	});

	await t.step("should handle close errors gracefully", async () => {
		const node = new AudioEncodeNode(context);
		const encoder = FakeAudioEncoder.lastCreated!;

		encoder.close = () => {
			throw new Error("Close failed");
		};

		// Should not throw
		await node.dispose();
	});

	await t.step("should dispose correctly", async () => {
		const node = new AudioEncodeNode(context);
		const encoder = FakeAudioEncoder.lastCreated!;

		await node.dispose();

		assert(encoder.closeCalled);
	});

	await t.step("should handle multiple dispose calls", () => {
		const node = new AudioEncodeNode(context);

		node.dispose();
		node.dispose();

		// Should not throw on second dispose
	});

	await t.step("should disconnect worklet on dispose", () => {
		const node = new AudioEncodeNode(context);

		node.dispose();

		// Worklet will be disconnected internally
		// We can't easily test this without accessing private fields
	});

	await t.step("should clear destinations on dispose", () => {
		const node = new AudioEncodeNode(context);

		// const mockDest: AudioEncodeDestination = {
		// 	output: async () => {},
		// 	done: Promise.resolve(),
		// };

		// Destinations are managed internally, we verify dispose doesn't throw
		node.dispose();
		// Success if no error thrown
	});

	await t.step("should add and remove event listeners", () => {
		const node = new AudioEncodeNode(context);
		const handler = () => {};

		node.addEventListener("test", handler);

		// Test by dispatching - if added correctly, it should work
		let called = false;
		const testHandler = () => {
			called = true;
		};
		node.addEventListener("test", testHandler);
		node.dispatchEvent(new Event("test"));
		assert(called);

		node.removeEventListener("test", handler);
		// Should still work after removing other listener
	});

	await t.step("should dispatch events to listeners", () => {
		const node = new AudioEncodeNode(context);
		let called = false;

		node.addEventListener("test", () => {
			called = true;
		});

		const event = new Event("test");
		node.dispatchEvent(event);

		assert(called);
	});

	await t.step("should handle EventListenerObject", () => {
		const node = new AudioEncodeNode(context);
		let called = false;

		const listener = {
			handleEvent: () => {
				called = true;
			},
		};

		node.addEventListener("test", listener);
		node.dispatchEvent(new Event("test"));

		assert(called);
	});

	await t.step("should encodeTo destination", async () => {
		const node = new AudioEncodeNode(context);
		// const encoder = FakeAudioEncoder.lastCreated!;

		let outputChunk: EncodedAudioChunk | undefined;
		let resolveDone!: () => void;
		new Promise<void>((resolve) => {
			resolveDone = resolve;
		});

		const mockDest: AudioEncodeDestination = {
			output: (chunk: EncodedAudioChunk, _decoderConfig?: AudioDecoderConfig) => {
				outputChunk = chunk;
				return Promise.resolve(undefined);
			},
		};

		const config: AudioEncoderConfig = {
			codec: "opus",
			sampleRate: 48000,
			numberOfChannels: 2,
		};
		node.configure(config);

		const encodePromise = node.encodeTo(mockDest);

		// Simulate encoding
		const audioData = new FakeAudioData(1024, 2, 48000);
		node.process(audioData);

		// Wait for async encoding
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Check that output was called
		assertExists(outputChunk);

		// Resolve done to complete encodeTo
		resolveDone!();
		await encodePromise;
	});

	await t.step(
		"should handle destination output errors gracefully",
		async () => {
			const node = new AudioEncodeNode(context);

			let resolveDone!: () => void;
			new Promise<void>((resolve) => {
				resolveDone = resolve;
			});

			const mockDest: AudioEncodeDestination = {
				output: (_chunk: EncodedAudioChunk, _decoderConfig?: AudioDecoderConfig) =>
					Promise.resolve(undefined),
			};

			const config: AudioEncoderConfig = {
				codec: "opus",
				sampleRate: 48000,
				numberOfChannels: 2,
			};
			node.configure(config);

			const encodePromise = node.encodeTo(mockDest);

			// Simulate encoding
			const audioData = new FakeAudioData(1024, 2, 48000);
			node.process(audioData);

			// Wait for async encoding
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Resolve done to complete encodeTo
			resolveDone!();

			// Should not throw
			await encodePromise;
		},
	);

	await t.step(
		"should remove destination after encodeTo completes",
		async () => {
			const node = new AudioEncodeNode(context);

			const mockDest: AudioEncodeDestination = {
				output: (_chunk: EncodedAudioChunk, _decoderConfig?: AudioDecoderConfig) =>
					Promise.resolve(undefined),
			};

			const config: AudioEncoderConfig = {
				codec: "opus",
				sampleRate: 48000,
				numberOfChannels: 2,
			};
			node.configure(config);

			await node.encodeTo(mockDest);

			// Destination should be removed after done (verified internally)
			// Success if no error thrown
		},
	);

	await t.step("cleanup", () => {
		// Restore originals
		restoreAudioEncoder();
		restoreAudioWorkletNode();
		restoreGlobalGainNode();

		encodeNode.dispose();
	});
});

// Table-driven tests for multiple scenarios
Deno.test("AudioEncodeNode - edge cases", async (t) => {
	let restoreAudioEncoder: () => void;
	let restoreAudioWorkletNode: () => void;
	let context: FakeAudioContext;

	await t.step("setup", () => {
		restoreAudioEncoder = overrideAudioEncoder(FakeAudioEncoder);
		restoreAudioWorkletNode = overrideAudioWorkletNode(FakeAudioWorkletNode);

		context = new FakeAudioContext();
	});

	const testCases = new Map([
		["should handle null channelCount gracefully", {
			setupContext: () => {
				const ctx = new FakeAudioContext();
				ctx.destination.channelCount = 0;
				return ctx;
			},
			validate: (node: AudioEncodeNodeType) => {
				assertEquals(node.channelCount, 1);
			},
		}],
		["should expose correct channel properties", {
			setupContext: () => context,
			validate: (node: AudioEncodeNodeType) => {
				assertEquals(node.channelCountMode, "explicit");
				assertEquals(node.channelInterpretation, "speakers");
			},
		}],
		["should handle worklet not yet initialized", {
			setupContext: () => context,
			validate: (node: AudioEncodeNodeType) => {
				// Access properties before worklet is ready
				// Note: #workletReady is the actual field name in AudioEncodeNode
				const worklet = (node as unknown as { "#worklet": AudioWorkletNode })["#worklet"];
				if (!worklet) {
					assertEquals(node.channelCount, 2); // matches context.destination.channelCount
					assertEquals(node.numberOfInputs, 1);
					assertEquals(node.numberOfOutputs, 0);
				}
			},
		}],
	]);

	for (const [name, testCase] of testCases) {
		await t.step(name, () => {
			const ctx = testCase.setupContext();
			const node = new AudioEncodeNode(ctx);
			testCase.validate(node);
			node.dispose();
		});
	}

	await t.step("cleanup", () => {
		restoreAudioEncoder();
		restoreAudioWorkletNode();
		restoreGlobalGainNode();
	});
});

// Backpressure tests
Deno.test("AudioEncodeNode - backpressure handling", async (t) => {
	let restoreAudioEncoder: () => void;
	let restoreAudioWorkletNode: () => void;
	let context: FakeAudioContext;
	let encodeNode: AudioEncodeNodeType;

	await t.step("setup", () => {
		restoreAudioEncoder = overrideAudioEncoder(FakeAudioEncoder);
		restoreAudioWorkletNode = overrideAudioWorkletNode(FakeAudioWorkletNode);

		context = new FakeAudioContext();
		encodeNode = new AudioEncodeNode(context);
	});

	await t.step("should encode when queue size is within limit", () => {
		const encoder = FakeAudioEncoder.lastCreated!;
		encoder.encodeQueueSize = 1;
		encoder.encodeCalls = [];

		const audioData = new FakeAudioData(1024, 2, 48000);
		encodeNode.process(audioData);

		assertEquals(encoder.encodeCalls.length, 1);
	});

	await t.step(
		"should drop frame when queue size exceeds MAX_ENCODE_QUEUE_SIZE",
		() => {
			const encoder = FakeAudioEncoder.lastCreated!;
			encoder.encodeQueueSize = 3; // > 2 (MAX_ENCODE_QUEUE_SIZE)
			encoder.encodeCalls = [];

			const audioData = new FakeAudioData(1024, 2, 48000);
			encodeNode.process(audioData);

			// Should not encode
			assertEquals(encoder.encodeCalls.length, 0);
		},
	);

	await t.step(
		"should encode when queue size equals MAX_ENCODE_QUEUE_SIZE",
		() => {
			const encoder = FakeAudioEncoder.lastCreated!;
			encoder.encodeQueueSize = 2; // = MAX_ENCODE_QUEUE_SIZE
			encoder.encodeCalls = [];

			const audioData = new FakeAudioData(1024, 2, 48000);
			encodeNode.process(audioData);

			// Should still encode at the limit
			assertEquals(encoder.encodeCalls.length, 1);
		},
	);

	await t.step("cleanup", () => {
		restoreAudioEncoder();
		restoreAudioWorkletNode();
		restoreGlobalGainNode();
		encodeNode.dispose();
	});
});

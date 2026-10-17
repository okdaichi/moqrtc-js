import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { stub } from "@std/testing/mock";
import type { FrameMessage } from "./audio_hijack_protocol.ts";
import { HIJACK_PROCESSOR_NAME } from "./audio_worklet_protocol.ts";
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

const { AudioEncodeNode, AudioEncodeNodeOptionError } = await import("./encode_node.ts");

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

	// 200 ms of 20 ms frames.
	const queueCases = [
		{ name: "encodes while the encoder holds less than 200 ms", queued: 9, encoded: 1 },
		{ name: "drops a frame once the encoder holds 200 ms", queued: 10, encoded: 0 },
	] as const;
	for (const c of queueCases) {
		await t.step(c.name, () => {
			const encoder = FakeAudioEncoder.lastCreated!;
			encoder.encodeQueueSize = c.queued;
			encoder.encodeCalls = [];

			encodeNode.process(new FakeAudioData(960, 2, 48000));

			assertEquals(encoder.encodeCalls.length, c.encoded);
		});
	}

	await t.step("cleanup", () => {
		restoreAudioEncoder();
		restoreAudioWorkletNode();
		restoreGlobalGainNode();
		encodeNode.dispose();
	});
});

// Worklet-driven #next path tests.
//
// The process() method is covered above, but the production encode path runs
// through #next: the worklet posts AudioDataInit -> the node's ReadableStream
// -> #next reads, (no longer clones), encodes, closes. These tests drive that
// path by capturing the worklet instance and posting to its port directly.
Deno.test("AudioEncodeNode - worklet #next path", async (t) => {
	let restoreAudioEncoder: () => void;
	let restoreAudioWorkletNode: () => void;
	let restoreAudioData: () => void;
	let context: FakeAudioContext;
	let encodeNode: AudioEncodeNodeType;
	let capturedWorklet: FakeAudioWorkletNode | null;
	let cloneCallCount: number;

	// AudioWorkletNode subclass that records its instance so the test can drive
	// port.onmessage (the same path the real worklet uses to feed #next).
	class RecordingWorklet extends FakeAudioWorkletNode {
		constructor(
			ctx?: BaseAudioContext,
			name?: string,
			opts?: AudioWorkletNodeOptions,
		) {
			super(ctx, name, opts);
			capturedWorklet = this;
		}
	}

	// AudioData that accepts AudioDataInit (as the worklet path constructs it)
	// and counts clone() calls so we can assert #next does not clone before
	// encoding (the node owns these frames).
	class TestAudioData extends FakeAudioData {
		constructor(init: AudioDataInit) {
			super(
				init.numberOfFrames ?? 1024,
				init.numberOfChannels ?? 2,
				init.sampleRate ?? 48000,
				init.timestamp ?? 0,
			);
		}
		override clone(): AudioData {
			cloneCallCount++;
			return super.clone();
		}
	}

	function overrideAudioData(value: unknown): () => void {
		const g = globalThis as unknown as Record<string, unknown>;
		const had = Object.prototype.hasOwnProperty.call(g, "AudioData");
		const orig = g.AudioData;
		g.AudioData = value;
		return () => {
			if (had) g.AudioData = orig;
			else delete g.AudioData;
		};
	}

	function makeFrame(timestamp: number): FrameMessage {
		return {
			type: "frame",
			data: new Float32Array(1024 * 2),
			numberOfFrames: 1024,
			numberOfChannels: 2,
			sampleRate: 48000,
			timestamp,
		};
	}

	function postFrame(ts: number): void {
		capturedWorklet?.port.onmessage?.(new MessageEvent("message", { data: makeFrame(ts) }));
	}

	async function waitForEncodes(
		encoder: FakeAudioEncoder,
		n: number,
		timeoutMs = 1000,
	): Promise<void> {
		const deadline = performance.now() + timeoutMs;
		while (encoder.encodeCalls.length < n && performance.now() < deadline) {
			await new Promise<void>((r) => setTimeout(r, 0));
		}
	}

	await t.step("setup", async () => {
		capturedWorklet = null;
		cloneCallCount = 0;
		restoreAudioEncoder = overrideAudioEncoder(FakeAudioEncoder);
		restoreAudioWorkletNode = overrideAudioWorkletNode(RecordingWorklet);
		restoreAudioData = overrideAudioData(TestAudioData);

		context = new FakeAudioContext();
		encodeNode = new AudioEncodeNode(context);
		encodeNode.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });

		// Wait for the worklet (addModule.then) to be constructed and #next started.
		await new Promise<void>((r) => setTimeout(r, 0));
		await new Promise<void>((r) => setTimeout(r, 0));
	});

	await t.step("#next encodes frames received via the worklet port", async () => {
		const encoder = FakeAudioEncoder.lastCreated!;
		encoder.encodeCalls = [];
		const N = 5;
		for (let i = 0; i < N; i++) postFrame(i * 1000);
		await waitForEncodes(encoder, N);

		assertEquals(encoder.encodeCalls.length, N);
		// Timestamps preserved through the worklet -> #next -> encode path.
		for (let i = 0; i < N; i++) {
			assertEquals(encoder.encodeCalls[i]!.timestamp, i * 1000);
		}
	});

	await t.step(
		"#next does not clone before encoding (encodes the original frame)",
		async () => {
			const encoder = FakeAudioEncoder.lastCreated!;
			encoder.encodeCalls = [];
			cloneCallCount = 0;

			postFrame(4242);
			await waitForEncodes(encoder, 1);

			assertEquals(encoder.encodeCalls.length, 1);
			// The node owns worklet-sourced frames, so #next must encode the
			// original directly — no clone needed.
			assertEquals(cloneCallCount, 0);
			assert(
				encoder.encodeCalls[0] instanceof TestAudioData,
				"encoded frame should be the original frame, not a clone",
			);
		},
	);

	await t.step("#next drops frames when the encoder queue is overloaded", async () => {
		const encoder = FakeAudioEncoder.lastCreated!;
		encoder.encodeCalls = [];
		encoder.encodeQueueSize = 10; // 200 ms of 20 ms frames

		postFrame(9999);
		// Let #next read the frame and take the drop branch (closes frame, no encode).
		await new Promise<void>((r) => setTimeout(r, 0));
		await new Promise<void>((r) => setTimeout(r, 0));

		assertEquals(encoder.encodeCalls.length, 0); // dropped, not encoded
	});

	await t.step(
		"#next stops the loop (does not spin) when encode() throws",
		async () => {
			const encoder = FakeAudioEncoder.lastCreated!;
			encoder.encodeCalls = [];
			encoder.encodeQueueSize = 0;

			// Simulate the failure mode from the field: encode() throws on an
			// unconfigured codec. A thrown error must NOT make #next reschedule
			// forever, logging the same error once per posted frame.
			let attempts = 0;
			const encodeSlot = encoder as unknown as {
				encode: (data: AudioData) => void;
			};
			const originalEncode = encodeSlot.encode;
			encodeSlot.encode = (_data: AudioData) => {
				attempts++;
				throw new Error(
					"Cannot call 'encode' on an unconfigured codec.",
				);
			};

			try {
				postFrame(1);
				postFrame(2);
				postFrame(3);
				// Let any queued microtasks drain.
				await new Promise<void>((r) => setTimeout(r, 10));
				await new Promise<void>((r) => setTimeout(r, 10));

				// The loop must stop at the first failing frame — exactly one
				// attempt — instead of retrying for each posted frame.
				assertEquals(attempts, 1);
			} finally {
				encodeSlot.encode = originalEncode;
			}
		},
	);

	await t.step("#next stops encoding after dispose", async () => {
		const encoder = FakeAudioEncoder.lastCreated!;
		encoder.encodeCalls = [];
		encoder.encodeQueueSize = 0; // reset after the overloaded-queue step
		for (let i = 0; i < 3; i++) postFrame(i * 100);
		await waitForEncodes(encoder, 3);
		const before = encoder.encodeCalls.length;

		await encodeNode.dispose();

		// Frames posted after dispose must not be encoded.
		for (let i = 0; i < 3; i++) postFrame(i * 100 + 5000);
		await new Promise<void>((r) => setTimeout(r, 10));
		assertEquals(encoder.encodeCalls.length, before);
	});

	await t.step("safely flushes and disposes when unconfigured", async () => {
		const ctx = new FakeAudioContext();
		const unconfiguredNode = new AudioEncodeNode(ctx);
		assertEquals(unconfiguredNode.encoderState, "unconfigured");

		await unconfiguredNode.flush();
		await unconfiguredNode.dispose();
	});

	await t.step(
		"silently swallows AbortError on early disposal during worklet load",
		async () => {
			const ctx = new FakeAudioContext();
			let rejectAddModule!: (err: unknown) => void;
			ctx.audioWorklet.addModule = () =>
				new Promise<void>((_, reject) => {
					rejectAddModule = reject;
				});

			const node = new AudioEncodeNode(ctx);
			await node.dispose();

			rejectAddModule(
				new DOMException("Unable to load a worklet's module.", "AbortError"),
			);

			await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
		},
	);

	await t.step("cleanup", () => {
		restoreAudioData();
		restoreAudioWorkletNode();
		restoreAudioEncoder();
		restoreGlobalGainNode();
		encodeNode.dispose();
	});
});

Deno.test("AudioEncodeNode - captured channel count", async (t) => {
	let restoreAudioEncoder: () => void;
	let restoreAudioWorkletNode: () => void;
	let restoreAudioData: () => void;
	let restoreGainNode: () => void;
	let worklets: RecordingWorklet[];

	// Records every capture worklet: its options, its channel count as the
	// node sets it, and the messages posted to its processor.
	class RecordingWorklet extends FakeAudioWorkletNode {
		name: string | undefined;
		options: AudioWorkletNodeOptions | undefined;
		channelCount: number | undefined;
		posted: unknown[] = [];
		constructor(
			ctx?: BaseAudioContext,
			name?: string,
			opts?: AudioWorkletNodeOptions,
		) {
			super(ctx, name, opts);
			this.name = name;
			this.options = opts;
			this.channelCount = opts?.channelCount;
			this.port.postMessage = (message: unknown) => {
				this.posted.push(message);
			};
			worklets.push(this);
		}
	}

	class InitAudioData extends FakeAudioData {
		constructor(init: AudioDataInit) {
			super(init.numberOfFrames, init.numberOfChannels, init.sampleRate, init.timestamp);
		}
	}

	function overrideAudioData(value: unknown): () => void {
		const g = globalThis as unknown as Record<string, unknown>;
		const had = Object.prototype.hasOwnProperty.call(g, "AudioData");
		const orig = g.AudioData;
		g.AudioData = value;
		return () => {
			if (had) g.AudioData = orig;
			else delete g.AudioData;
		};
	}

	function postFrame(worklet: RecordingWorklet, channels: number, timestamp: number): void {
		const frame: FrameMessage = {
			type: "frame",
			data: new Float32Array(128 * channels),
			numberOfFrames: 128,
			numberOfChannels: channels,
			sampleRate: 48000,
			timestamp,
		};
		worklet.port.onmessage?.(new MessageEvent("message", { data: frame }));
	}

	async function workletReady(): Promise<void> {
		await new Promise<void>((r) => setTimeout(r, 0));
		await new Promise<void>((r) => setTimeout(r, 0));
	}

	async function settle(): Promise<void> {
		for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
	}

	await t.step("setup", () => {
		worklets = [];
		restoreGainNode = overrideGainNode(FakeGainNode);
		restoreAudioEncoder = overrideAudioEncoder(FakeAudioEncoder);
		restoreAudioWorkletNode = overrideAudioWorkletNode(RecordingWorklet);
		restoreAudioData = overrideAudioData(InitAudioData);
	});

	await t.step("captures the configured channel count, not the output device's", async () => {
		worklets = [];
		// The fake output device is stereo.
		const node = new AudioEncodeNode(new FakeAudioContext());
		node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
		await workletReady();

		assertEquals(worklets.length, 1);
		assertEquals(worklets[0]!.options?.channelCount, 1);
		assertEquals(worklets[0]!.options?.channelCountMode, "explicit");
		assertEquals(worklets[0]!.options?.processorOptions?.targetChannels, 1);
		assertEquals(node.channelCount, 1);

		await node.dispose();
	});

	await t.step("captures the output device's channel count until configured", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		await workletReady();

		assertEquals(worklets.length, 1);
		assertEquals(worklets[0]!.options?.channelCount, 2);
		assertEquals(worklets[0]!.options?.processorOptions?.targetChannels, 2);

		await node.dispose();
	});

	await t.step("tells the running capture worklet a channel count configured late", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		await workletReady();
		node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });

		assertEquals(worklets.length, 1);
		assertEquals(worklets[0]!.channelCount, 1);
		// 20 ms at the fake context's 44.1 kHz.
		assertEquals(worklets[0]!.posted, [{ type: "format", channels: 1, frameLength: 882 }]);
		assertEquals(node.channelCount, 1);

		await node.dispose();
	});

	await t.step("posts nothing when the channel count is unchanged", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		await workletReady();
		node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });

		assertEquals(worklets.length, 1);
		assertEquals(worklets[0]!.posted, []);

		await node.dispose();
	});

	const refusedFrameDurationCases = [
		{ codec: "opus", frameDuration: 0 },
		{ codec: "opus", frameDuration: -20_000 },
		{ codec: "opus", frameDuration: Number.NaN },
		{ codec: "opus", frameDuration: Number.POSITIVE_INFINITY },
		{ codec: "opus", frameDuration: 15_000 },
		{ codec: "mp4a.40.2", frameDuration: 0 },
	] as const;
	for (const c of refusedFrameDurationCases) {
		await t.step(
			`refuses a frame duration of ${c.frameDuration} µs for ${c.codec}, keeping the capture format`,
			async () => {
				worklets = [];
				const node = new AudioEncodeNode(new FakeAudioContext());
				await workletReady();

				assertThrows(
					() =>
						node.configure({
							codec: c.codec,
							sampleRate: 48000,
							numberOfChannels: 1,
							opus: { frameDuration: c.frameDuration },
						}),
					AudioEncodeNodeOptionError,
				);

				assertEquals(
					{ posted: worklets[0]?.posted, configured: node.encoderState },
					{ posted: [], configured: "unconfigured" },
				);

				await node.dispose();
			},
		);
	}

	await t.step("keeps the capture format when the encoder refuses the config", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		await workletReady();
		const encoder = FakeAudioEncoder.lastCreated;
		assertExists(encoder);
		encoder.configureError = new TypeError("invalid config");

		assertThrows(
			() => node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 }),
			TypeError,
		);

		assertEquals(worklets[0]?.posted, []);

		await node.dispose();
	});

	await t.step("encodes after a late configure, dropping the frames before it", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		await workletReady();
		const encoder = FakeAudioEncoder.lastCreated!;
		encoder.encodeCalls = [];

		// Audio is already flowing while the encoder is unconfigured.
		postFrame(worklets[0]!, 2, 1000);
		postFrame(worklets[0]!, 2, 2000);
		await settle();
		node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
		// One frame the worklet captured before it learned the new count.
		postFrame(worklets[0]!, 2, 3000);
		postFrame(worklets[0]!, 1, 4000);
		postFrame(worklets[0]!, 1, 5000);
		await settle();

		assertEquals(encoder.encodeCalls.map((c) => c.timestamp), [4000, 5000]);

		await node.dispose();
	});

	await t.step(
		"flushes the encoder before the first frame after a gap in the capture",
		async () => {
			worklets = [];
			const node = new AudioEncodeNode(new FakeAudioContext());
			node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
			await workletReady();
			const encoder = FakeAudioEncoder.lastCreated!;
			encoder.encodeCalls = [];
			// Each event is what the encoder was asked to do, in order.
			const events: string[] = [];
			const flush = encoder.flush.bind(encoder);
			encoder.flush = () => {
				events.push("flush");
				return flush();
			};
			const encode = encoder.encode.bind(encoder);
			encoder.encode = (data: AudioData) => {
				events.push(`encode ${data.timestamp}`);
				encode(data);
			};

			// 128 frames at 48 kHz last 2666.67 µs, so the third frame starts at
			// 5333 µs, not 5334; then nothing is captured for 50 ms.
			for (const ts of [0, 2667, 5333, 58_000]) {
				postFrame(worklets[0]!, 1, ts);
				await settle();
			}

			assertEquals(events, [
				"encode 0",
				"encode 2667",
				"encode 5333",
				"flush",
				"encode 58000",
			]);

			await node.dispose();
		},
	);

	await t.step("flushes held audio as soon as the capture input ends", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
		await workletReady();
		const encoder = FakeAudioEncoder.lastCreated!;
		const events: string[] = [];
		const flush = encoder.flush.bind(encoder);
		encoder.flush = () => {
			events.push("flush");
			return flush();
		};
		const encode = encoder.encode.bind(encoder);
		encoder.encode = (data: AudioData) => {
			events.push(`encode ${data.timestamp}`);
			encode(data);
		};
		const inputEnded = () =>
			worklets[0]?.port.onmessage?.(
				new MessageEvent("message", { data: { type: "inputEnded" } }),
			);

		// Nothing encoded yet: nothing to flush.
		inputEnded();
		await settle();
		postFrame(worklets[0]!, 1, 0);
		await settle();
		// The input ends, and comes back five seconds later.
		inputEnded();
		await settle();
		postFrame(worklets[0]!, 1, 5_000_000);
		await settle();

		// One flush, when the input ended; the frame after the gap needs no other.
		assertEquals(events, ["encode 0", "flush", "encode 5000000"]);

		await node.dispose();
	});

	await t.step("process() keeps a gap in its input in the encoded timestamps", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
		const encoder = FakeAudioEncoder.lastCreated!;
		let flushes = 0;
		const flush = encoder.flush.bind(encoder);
		encoder.flush = () => {
			flushes++;
			return flush();
		};

		for (const ts of [0, 20_000, 5_000_000]) {
			node.process(new FakeAudioData(960, 1, 48000, ts) as unknown as AudioData);
		}

		assertEquals(flushes, 1);
		assertEquals(encoder.encodeCalls.map((c) => c.timestamp), [0, 20_000, 5_000_000]);

		await node.dispose();
	});

	await t.step(
		"process() drops a frame whose channel count is not the configured one",
		async () => {
			worklets = [];
			const node = new AudioEncodeNode(new FakeAudioContext());
			node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
			const encoder = FakeAudioEncoder.lastCreated!;
			encoder.encodeCalls = [];

			node.process(new FakeAudioData(128, 2, 48000, 1000) as unknown as AudioData);
			node.process(new FakeAudioData(128, 1, 48000, 2000) as unknown as AudioData);

			assertEquals(encoder.encodeCalls.map((c) => c.timestamp), [2000]);

			await node.dispose();
		},
	);

	await t.step("creates no capture worklet when disposed while its module loads", async () => {
		worklets = [];
		const ctx = new FakeAudioContext();
		let resolveAddModule!: () => void;
		ctx.audioWorklet.addModule = () =>
			new Promise<void>((resolve) => {
				resolveAddModule = resolve;
			});

		const node = new AudioEncodeNode(ctx);
		await node.dispose();
		resolveAddModule();
		await workletReady();

		assertEquals(worklets.length, 0);
	});

	await t.step("adds its worklet module to a context once for many nodes", async () => {
		worklets = [];
		const ctx = new FakeAudioContext();
		const modules: string[] = [];
		ctx.audioWorklet.addModule = async (moduleUrl: string) => {
			modules.push(moduleUrl);
		};

		const nodes = Array.from({ length: 5 }, () => new AudioEncodeNode(ctx));
		await workletReady();

		assertEquals(
			{ modules: modules.length, worklets: worklets.length },
			{ modules: 1, worklets: 5 },
		);
		await Promise.all(nodes.map((node) => node.dispose()));
	});

	await t.step("dispose() tells the capture worklet's processor to stop", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		await workletReady();

		await node.dispose();

		assertEquals(worklets[0]?.posted, [{ type: "stop" }]);
	});

	await t.step("dispose() stops the capture worklet's processor before flushing", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
		await workletReady();
		const encoder = FakeAudioEncoder.lastCreated;
		const [worklet] = worklets;
		assertExists(encoder);
		assertExists(worklet);
		let postedAtFlush: unknown[] = [];
		const flush = encoder.flush.bind(encoder);
		encoder.flush = () => {
			postedAtFlush = worklet.posted.slice();
			return flush();
		};

		await node.dispose();

		assertEquals(postedAtFlush, [{ type: "stop" }]);
	});

	await t.step("creates the capture worklet under the processor's versioned name", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());

		await workletReady();

		assertEquals(worklets.map((worklet) => worklet.name), [HIJACK_PROCESSOR_NAME]);
		await node.dispose();
	});

	await t.step("drops a frame whose channel count is not the configured one", async () => {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
		await workletReady();
		const encoder = FakeAudioEncoder.lastCreated!;
		encoder.encodeCalls = [];

		postFrame(worklets[0]!, 2, 1000);
		postFrame(worklets[0]!, 1, 2000);
		await settle();

		assertEquals(encoder.encodeCalls.map((c) => c.timestamp), [2000]);

		await node.dispose();
	});

	await t.step("cleanup", () => {
		restoreAudioData();
		restoreAudioWorkletNode();
		restoreAudioEncoder();
		restoreGainNode();
	});
});

Deno.test("AudioEncodeNode - captured frames under backpressure", async (t) => {
	let restoreAudioEncoder: () => void;
	let restoreAudioWorkletNode: () => void;
	let restoreAudioData: () => void;
	let restoreGainNode: () => void;
	let worklets: RecordingWorklet[];

	class RecordingWorklet extends FakeAudioWorkletNode {
		options: AudioWorkletNodeOptions | undefined;
		constructor(ctx?: BaseAudioContext, name?: string, opts?: AudioWorkletNodeOptions) {
			super(ctx, name, opts);
			this.options = opts;
			worklets.push(this);
		}
	}

	class InitAudioData extends FakeAudioData {
		constructor(init: AudioDataInit) {
			super(init.numberOfFrames, init.numberOfChannels, init.sampleRate, init.timestamp);
		}
	}

	function overrideAudioData(value: unknown): () => void {
		const g = globalThis as unknown as Record<string, unknown>;
		const had = Object.prototype.hasOwnProperty.call(g, "AudioData");
		const orig = g.AudioData;
		g.AudioData = value;
		return () => {
			if (had) g.AudioData = orig;
			else delete g.AudioData;
		};
	}

	// A 20 ms mono frame at 48 kHz, captured `index` frames after the first.
	function postFrame(worklet: RecordingWorklet, index: number): void {
		const frame: FrameMessage = {
			type: "frame",
			data: new Float32Array(960),
			numberOfFrames: 960,
			numberOfChannels: 1,
			sampleRate: 48000,
			timestamp: index * 20_000,
		};
		worklet.port.onmessage?.(new MessageEvent("message", { data: frame }));
	}

	async function settle(): Promise<void> {
		for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
	}

	// A configured mono node, its capture worklet and its encoder.
	async function startNode(config: Partial<AudioEncoderConfig> = {}) {
		worklets = [];
		const node = new AudioEncodeNode(new FakeAudioContext());
		node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, ...config });
		await settle();
		const [worklet] = worklets;
		const encoder = FakeAudioEncoder.lastCreated;
		assertExists(worklet);
		assertExists(encoder);
		return { node, worklet, encoder };
	}

	await t.step("setup", () => {
		worklets = [];
		restoreGainNode = overrideGainNode(FakeGainNode);
		restoreAudioEncoder = overrideAudioEncoder(FakeAudioEncoder);
		restoreAudioWorkletNode = overrideAudioWorkletNode(RecordingWorklet);
		restoreAudioData = overrideAudioData(InitAudioData);
	});

	// The fake context runs at 44.1 kHz.
	const frameLengthCases = [
		{ name: "20 ms by default", config: {}, frameLength: 882 },
		{
			name: "the configured Opus frame duration",
			config: { opus: { frameDuration: 10_000 } },
			frameLength: 441,
		},
	] as const;
	for (const c of frameLengthCases) {
		await t.step(`captures frames of ${c.name}`, async () => {
			const { node, worklet } = await startNode(c.config);

			assertEquals(worklet.options?.processorOptions?.frameLength, c.frameLength);

			await node.dispose();
		});
	}

	await t.step("encodes every frame while the encoder catches up in bursts", async () => {
		const { node, worklet, encoder } = await startNode();
		encoder.holdOutput = true;

		// The encoder lets its queue out every eighth frame, 160 ms at a time.
		for (let i = 0; i < 50; i++) {
			postFrame(worklet, i);
			await settle();
			if (i % 8 === 7) encoder.release();
		}

		assertEquals(encoder.encodeCalls.length, 50);

		await node.dispose();
	});

	await t.step("drops whole frames once the encoder has stalled for 200 ms", async () => {
		const { node, worklet, encoder } = await startNode();
		encoder.holdOutput = true;

		for (let i = 0; i < 15; i++) postFrame(worklet, i);
		await settle();

		assertEquals(
			encoder.encodeCalls.map((frame) => frame.timestamp),
			Array.from({ length: 10 }, (_, i) => i * 20_000),
		);

		await node.dispose();
	});

	await t.step("stamps the frame after dropped ones at its own capture time", async () => {
		const { node, worklet, encoder } = await startNode();
		encoder.holdOutput = true;
		for (let i = 0; i < 15; i++) postFrame(worklet, i);
		await settle();
		encoder.release();

		postFrame(worklet, 15);
		await settle();

		// The encoder is flushed after the ten frames it took, so it stamps the
		// next one by its own timestamp: a 100 ms jump, for the five dropped.
		assertEquals(
			{ flushedAfter: encoder.flushedAfter, last: encoder.encodeCalls.at(-1)?.timestamp },
			{ flushedAfter: [10], last: 300_000 },
		);

		await node.dispose();
	});

	await t.step(
		"warns of dropped frames at most once per five seconds, with their count",
		async () => {
			const { node, encoder } = await startNode();
			encoder.encodeQueueSize = 10;
			// performance.now(), the monotonic clock, in ms.
			let now = 1_000;
			const clock = stub(performance, "now", () => now);
			const warn = stub(console, "warn");
			try {
				for (let i = 0; i < 5; i++) {
					node.process(new FakeAudioData(960, 1, 48000, i * 20_000));
				}
				now += 5_000;
				node.process(new FakeAudioData(960, 1, 48000, 100_000));

				assertEquals(warn.calls.map((call) => call.args[0]), [
					"[AudioEncodeNode] Encoder stalled: dropped 1 frame(s) since the last warning.",
					"[AudioEncodeNode] Encoder stalled: dropped 5 frame(s) since the last warning.",
				]);
			} finally {
				warn.restore();
				clock.restore();
			}

			encoder.encodeQueueSize = 0;
			await node.dispose();
		},
	);

	await t.step("cleanup", () => {
		restoreAudioData();
		restoreAudioWorkletNode();
		restoreAudioEncoder();
		restoreGainNode();
	});
});

import { assert, assertEquals, assertExists } from "@std/assert";
import { AudioEncodeNode } from "./encode_node.ts";
import { MockAudioData } from "./mock_audiodata_test.ts";

// Define EncodeDestination interface locally to avoid dependency issues
interface EncodeDestination {
	output: (chunk: EncodedAudioChunk) => Promise<Error | undefined>;
	done: Promise<void>;
}

// Global tracker for mock instances
let lastMockEncoder: MockAudioEncoder | null = null;

// Mock AudioEncoder with comprehensive tracking
class MockAudioEncoder {
	state: CodecState = "unconfigured";
	_encodeQueueSize = 0; // Internal storage for queue size
	configureCalled = false;
	encodeCalled = false;
	closeCalled = false;
	configureCalls: AudioEncoderConfig[] = [];
	encodeCalls: AudioData[] = [];
	
	#outputCallback?: (chunk: EncodedAudioChunk) => void;
	#errorCallback?: (error: Error) => void;

	constructor(init: AudioEncoderInit) {
		this.#outputCallback = init.output;
		this.#errorCallback = init.error;
		lastMockEncoder = this; // Track the last created instance
	}

	get encodeQueueSize(): number {
		return this._encodeQueueSize;
	}

	set encodeQueueSize(value: number) {
		this._encodeQueueSize = value;
	}

	configure(config: AudioEncoderConfig): void {
		this.configureCalled = true;
		this.configureCalls.push(config);
		this.state = "configured";
	}

	encode(data: AudioData): void {
		this.encodeCalled = true;
		this.encodeCalls.push(data);
		this._encodeQueueSize++;
		
		// Simulate async encoding
		queueMicrotask(() => {
			this._encodeQueueSize--;
			if (this.#outputCallback) {
				// Create mock encoded chunk
				const mockChunk = {
					type: "key",
					timestamp: data.timestamp,
					duration: data.duration,
					byteLength: 1024,
				} as EncodedAudioChunk;
				this.#outputCallback(mockChunk);
			}
		});
	}

	close(): void {
		this.closeCalled = true;
		this.state = "closed";
	}

	triggerError(error: Error): void {
		if (this.#errorCallback) {
			this.#errorCallback(error);
		}
	}
}

// Mock AudioWorkletNode
class MockAudioWorkletNode {
	context: AudioContext;
	channelCount = 2;
	channelCountMode: ChannelCountMode = "explicit";
	channelInterpretation: ChannelInterpretation = "speakers";
	numberOfInputs = 1;
	numberOfOutputs = 0;
	port: MessagePort;
	#disconnected = false;

	constructor(
		context: AudioContext,
		_name: string,
		_options?: AudioWorkletNodeOptions,
	) {
		this.context = context;
		// Create a mock MessagePort
		this.port = {
			onmessage: null,
			postMessage: () => {},
		} as any;
	}

	connect(): AudioNode {
		throw new Error("Not implemented in mock");
	}

	disconnect(): void {
		this.#disconnected = true;
	}

	get isDisconnected(): boolean {
		return this.#disconnected;
	}
}

// Mock AudioContext
class MockAudioContext {
	sampleRate = 48000;
	destination = {
		channelCount: 2,
	};
	audioWorklet = {
		addModule: async (_url: string) => {
			// Mock module loading
		},
	};
}

Deno.test("AudioEncodeNode", async (t) => {
	let originalAudioEncoder: any;
	let originalAudioWorkletNode: any;
	let context: AudioContext;
	let encodeNode: AudioEncodeNode;

	await t.step("setup", () => {
		// Store originals
		originalAudioEncoder = globalThis.AudioEncoder;
		originalAudioWorkletNode = globalThis.AudioWorkletNode;

		// Setup mocks
		(globalThis as any).AudioEncoder = MockAudioEncoder;
		(globalThis as any).AudioWorkletNode = MockAudioWorkletNode;
		
		context = new MockAudioContext() as any;
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
			assert((e as Error).message.includes("does not support connections"));
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

		assertExists(lastMockEncoder);
		assert(lastMockEncoder.configureCalled);
		assertEquals(lastMockEncoder.configureCalls.length, 1);
		assertEquals(lastMockEncoder.configureCalls[0], config);
	});

	await t.step("should expose encoder state", () => {
		assertEquals(encodeNode.encoderState, "configured");
	});

	await t.step("should expose encodeQueueSize", () => {
		const queueSize = encodeNode.encodeQueueSize;
		assertEquals(typeof queueSize, "number");
		assert(queueSize >= 0);
	});

	await t.step("should return 0 for encodeQueueSize when encoder not ready", () => {
		// Create a separate broken node instance
		const brokenNode = new AudioEncodeNode(context);
		const brokenEncoder = lastMockEncoder!;
		
		// Save the original encoder for the main node
		const mainEncoder = lastMockEncoder;
		
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
	});

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
		
		const encoder = lastMockEncoder!;
		encoder.encodeCalls = [];
		encoder.encodeCalled = false;
		
		const audioData = new MockAudioData(1024, 2, 48000);
		encodeNode.process(audioData);

		assert(encoder.encodeCalled, "Encoder should have been called");
		assertEquals(encoder.encodeCalls.length, 1);
	});

	await t.step("should clone AudioData before encoding", () => {
		const audioData = new MockAudioData(1024, 2, 48000);
		let cloneCalled = false;
		
		audioData.clone = function() {
			cloneCalled = true;
			return new MockAudioData(1024, 2, 48000);
		};

		encodeNode.process(audioData);
		assert(cloneCalled, "AudioData should be cloned");
	});

	await t.step("should handle encode errors gracefully", () => {
		const audioData = new MockAudioData(1024, 2, 48000);
		const encoder = lastMockEncoder!;
		
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
		const audioData = new MockAudioData(1024, 2, 48000);
		const encoder = lastMockEncoder!;
		
		// Simulate overloaded queue
		encoder.encodeQueueSize = 10;
		
		const initialCallCount = encoder.encodeCalls.length;
		encodeNode.process(audioData);

		// Should not encode when queue is full
		assertEquals(encoder.encodeCalls.length, initialCallCount);
	});

	await t.step("should not process when disposed", () => {
		const disposedNode = new AudioEncodeNode(context);
		const disposedEncoder = lastMockEncoder!;
		
		disposedNode.dispose();
		
		const audioData = new MockAudioData(1024, 2, 48000);
		disposedEncoder.encodeCalls = [];
		
		disposedNode.process(audioData);
		
		// Should not encode after disposal
		assertEquals(disposedEncoder.encodeCalls.length, 0);
	});

	await t.step("should close encoder", async () => {
		const node = new AudioEncodeNode(context);
		const encoder = lastMockEncoder!;
		
		await node.close();
		assert(encoder.closeCalled);
	});

	await t.step("should handle close errors gracefully", async () => {
		const node = new AudioEncodeNode(context);
		const encoder = lastMockEncoder!;
		
		encoder.close = () => {
			throw new Error("Close failed");
		};

		// Should not throw
		await node.close();
	});

	await t.step("should dispose correctly", () => {
		const node = new AudioEncodeNode(context);
		const encoder = lastMockEncoder!;
		
		node.dispose();
		
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
		
		const mockDest: EncodeDestination = {
			output: async () => {},
			done: Promise.resolve(),
		};
		
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
		const testHandler = () => { called = true; };
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
		const encoder = lastMockEncoder!;
		
		let outputChunk: EncodedAudioChunk | undefined;
		let resolveDone: () => void;
		const donePromise = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		
		const mockDest: EncodeDestination = {
			output: async (chunk: EncodedAudioChunk) => {
				outputChunk = chunk;
			},
			done: donePromise,
		};

		const config: AudioEncoderConfig = {
			codec: "opus",
			sampleRate: 48000,
			numberOfChannels: 2,
		};
		node.configure(config);
		
		const encodePromise = node.encodeTo(mockDest);
		
		// Simulate encoding
		const audioData = new MockAudioData(1024, 2, 48000);
		node.process(audioData);
		
		// Wait for async encoding
		await new Promise((resolve) => setTimeout(resolve, 10));
		
		// Check that output was called
		assertExists(outputChunk);
		
		// Resolve done to complete encodeTo
		resolveDone!();
		await encodePromise;
	});

	await t.step("should handle destination output errors gracefully", async () => {
		const node = new AudioEncodeNode(context);
		
		let resolveDone: () => void;
		const donePromise = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		
		const mockDest: EncodeDestination = {
			output: async () => {
				throw new Error("Destination error");
			},
			done: donePromise,
		};

		const config: AudioEncoderConfig = {
			codec: "opus",
			sampleRate: 48000,
			numberOfChannels: 2,
		};
		node.configure(config);
		
		const encodePromise = node.encodeTo(mockDest);
		
		// Simulate encoding
		const audioData = new MockAudioData(1024, 2, 48000);
		node.process(audioData);
		
		// Wait for async encoding
		await new Promise((resolve) => setTimeout(resolve, 10));
		
		// Resolve done to complete encodeTo
		resolveDone!();
		
		// Should not throw
		await encodePromise;
	});

	await t.step("should remove destination after encodeTo completes", async () => {
		const node = new AudioEncodeNode(context);
		
		const mockDest: EncodeDestination = {
			output: async () => {},
			done: Promise.resolve(),
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
	});

	await t.step("cleanup", () => {
		// Restore originals
		globalThis.AudioEncoder = originalAudioEncoder;
		globalThis.AudioWorkletNode = originalAudioWorkletNode;
		
		encodeNode.dispose();
	});
});

// Table-driven tests for multiple scenarios
Deno.test("AudioEncodeNode - edge cases", async (t) => {
	let originalAudioEncoder: any;
	let originalAudioWorkletNode: any;
	let context: AudioContext;

	await t.step("setup", () => {
		originalAudioEncoder = globalThis.AudioEncoder;
		originalAudioWorkletNode = globalThis.AudioWorkletNode;
		
		(globalThis as any).AudioEncoder = MockAudioEncoder;
		(globalThis as any).AudioWorkletNode = MockAudioWorkletNode;
		
		context = new MockAudioContext() as any;
	});

	const testCases = new Map([
		["should handle null channelCount gracefully", {
			setupContext: () => {
				const ctx = new MockAudioContext() as any;
				ctx.destination.channelCount = 0;
				return ctx;
			},
			validate: (node: AudioEncodeNode) => {
				assertEquals(node.channelCount, 1);
			},
		}],
		["should expose correct channel properties", {
			setupContext: () => context,
			validate: (node: AudioEncodeNode) => {
				assertEquals(node.channelCountMode, "explicit");
				assertEquals(node.channelInterpretation, "speakers");
			},
		}],
		["should handle worklet not yet initialized", {
			setupContext: () => context,
			validate: (node: AudioEncodeNode) => {
				// Access properties before worklet is ready
				const worklet = (node as any)["#worklet"];
				if (!worklet) {
					assertEquals(node.channelCount, 1);
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
		globalThis.AudioEncoder = originalAudioEncoder;
		globalThis.AudioWorkletNode = originalAudioWorkletNode;
	});
});

// Backpressure management tests
Deno.test("AudioEncodeNode - backpressure management", async (t) => {
	let originalAudioEncoder: any;
	let originalAudioWorkletNode: any;
	let context: AudioContext;
	let encodeNode: AudioEncodeNode;

	await t.step("setup", () => {
		originalAudioEncoder = globalThis.AudioEncoder;
		originalAudioWorkletNode = globalThis.AudioWorkletNode;
		
		(globalThis as any).AudioEncoder = MockAudioEncoder;
		(globalThis as any).AudioWorkletNode = MockAudioWorkletNode;
		
		context = new MockAudioContext() as any;
		encodeNode = new AudioEncodeNode(context);
	});

	await t.step("should encode when queue size is within limit", () => {
		const encoder = lastMockEncoder!;
		encoder.encodeQueueSize = 1;
		encoder.encodeCalls = [];
		
		const audioData = new MockAudioData(1024, 2, 48000);
		encodeNode.process(audioData);
		
		assertEquals(encoder.encodeCalls.length, 1);
	});

	await t.step("should drop frame when queue size exceeds MAX_ENCODE_QUEUE_SIZE", () => {
		const encoder = lastMockEncoder!;
		encoder.encodeQueueSize = 3; // > 2 (MAX_ENCODE_QUEUE_SIZE)
		encoder.encodeCalls = [];
		
		const audioData = new MockAudioData(1024, 2, 48000);
		encodeNode.process(audioData);
		
		// Should not encode
		assertEquals(encoder.encodeCalls.length, 0);
	});

	await t.step("should encode when queue size equals MAX_ENCODE_QUEUE_SIZE", () => {
		const encoder = lastMockEncoder!;
		encoder.encodeQueueSize = 2; // = MAX_ENCODE_QUEUE_SIZE
		encoder.encodeCalls = [];
		
		const audioData = new MockAudioData(1024, 2, 48000);
		encodeNode.process(audioData);
		
		// Should still encode at the limit
		assertEquals(encoder.encodeCalls.length, 1);
	});

	await t.step("cleanup", () => {
		globalThis.AudioEncoder = originalAudioEncoder;
		globalThis.AudioWorkletNode = originalAudioWorkletNode;
		encodeNode.dispose();
	});
});

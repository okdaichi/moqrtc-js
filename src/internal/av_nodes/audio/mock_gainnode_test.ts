/**
 * MockGainNode for Deno test environments.
 * Must be imported BEFORE any module that uses `class X extends GainNode`.
 * Provides AudioEncodeNode-compatible GainNode behavior (terminal node, throws on external connect).
 */
export class MockGainNode extends EventTarget {
	context: AudioContext;
	channelCount = 2;
	channelCountMode: ChannelCountMode = "max";
	channelInterpretation: ChannelInterpretation = "speakers";
	numberOfInputs = 1;
	numberOfOutputs = 0; // AudioEncodeNode has no outputs (terminal node)
	gain = {
		value: 1.0,
	};

	constructor(context?: AudioContext, _options?: { gain?: number }) {
		super();
		this.context = context ?? ({} as AudioContext);
		if (_options?.gain !== undefined) {
			this.gain.value = _options.gain;
		}
	}

	connect(_destination: AudioNode | AudioParam): AudioNode | void {
		// Allow internal connection to worklet during construction
		if (_destination && typeof _destination === "object" && "port" in _destination) {
			return _destination as AudioNode;
		}
		// AudioEncodeNode does not support external connections (it's a terminal node)
		throw new Error("AudioEncodeNode does not support connections. Use encodeTo() instead.");
	}

	disconnect(): void {
		// Mock implementation - no-op
	}
}

// Set globally so that `class X extends GainNode` works when this module is imported first
(globalThis as any).GainNode = MockGainNode;

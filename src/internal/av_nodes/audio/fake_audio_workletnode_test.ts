/**
 * FakeAudioWorkletNode for Deno test environments.
 *
 * This implementation is intentionally minimal and supports the methods
 * used by AudioEncodeNode unit tests.
 */
export class FakeAudioWorkletNode extends EventTarget {
	port: MessagePort;

	constructor(
		_context?: BaseAudioContext,
		_name?: string,
		_options?: AudioWorkletNodeOptions,
	) {
		super();
		this.port = {
			postMessage: () => {},
			onmessage: null,
			start: () => {},
			close: () => {},
			addEventListener: this.addEventListener.bind(this),
			removeEventListener: this.removeEventListener.bind(this),
			dispatchEvent: this.dispatchEvent.bind(this),
			// Minimal MessagePort shape for tests.
		} as unknown as MessagePort;
	}

	connect(_destination?: AudioNode): AudioNode | void {
		return _destination;
	}

	disconnect(): void {
		// No-op for fake worklet node.
	}
}

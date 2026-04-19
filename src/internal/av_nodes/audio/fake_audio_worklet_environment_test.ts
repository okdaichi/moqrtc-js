export type AudioWorkletRegisterCall = [string, unknown];

export class FakeAudioWorkletProcessor {
	port: MessagePort;

	constructor() {
		this.port = {
			postMessage: () => {},
			onmessage: undefined,
			start: () => {},
			close: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		} as unknown as MessagePort;
	}
}

export function setupFakeAudioWorkletEnvironment() {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasAudioWorkletProcessor = Object.prototype.hasOwnProperty.call(g, "AudioWorkletProcessor");
	const originalAudioWorkletProcessor = g.AudioWorkletProcessor;
	const hasRegisterProcessor = Object.prototype.hasOwnProperty.call(g, "registerProcessor");
	const originalRegisterProcessor = g.registerProcessor;

	const registerProcessorCalls: AudioWorkletRegisterCall[] = [];

	g.AudioWorkletProcessor = FakeAudioWorkletProcessor as unknown;
	g.registerProcessor = (name: string, processor: unknown) => {
		registerProcessorCalls.push([name, processor]);
	};

	return {
		registerProcessorCalls,
		restore() {
			if (hasAudioWorkletProcessor) {
				g.AudioWorkletProcessor = originalAudioWorkletProcessor;
			} else {
				delete g.AudioWorkletProcessor;
			}
			if (hasRegisterProcessor) {
				g.registerProcessor = originalRegisterProcessor;
			} else {
				delete g.registerProcessor;
			}
		},
	};
}

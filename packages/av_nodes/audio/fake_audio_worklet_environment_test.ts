export type AudioWorkletRegisterCall = [string, unknown];

// A processor's message port: records what the processor posts in `sent` and
// whether it closed the port; tests deliver messages by calling `onmessage`.
export class FakeProcessorPort {
	readonly sent: unknown[] = [];
	closed = false;
	onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

	postMessage(message: unknown): void {
		this.sent.push(message);
	}

	start(): void {}
	close(): void {
		this.closed = true;
	}
}

export class FakeAudioWorkletProcessor {
	readonly port = new FakeProcessorPort();
}

export function setupFakeAudioWorkletEnvironment() {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasAudioWorkletProcessor = Object.prototype.hasOwnProperty.call(
		g,
		"AudioWorkletProcessor",
	);
	const originalAudioWorkletProcessor = g.AudioWorkletProcessor;
	const hasRegisterProcessor = Object.prototype.hasOwnProperty.call(g, "registerProcessor");
	const originalRegisterProcessor = g.registerProcessor;

	const registerProcessorCalls: AudioWorkletRegisterCall[] = [];

	g.AudioWorkletProcessor = FakeAudioWorkletProcessor as unknown;
	// Like the real scope, a name registers once.
	g.registerProcessor = (name: string, processor: unknown) => {
		if (registerProcessorCalls.some(([registered]) => registered === name)) {
			throw new DOMException(`"${name}" is already registered`, "NotSupportedError");
		}
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

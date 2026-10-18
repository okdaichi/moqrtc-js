/// <reference path="../../../src/test_globals.d.ts" />
import { assertEquals, assertRejects } from "@std/assert";
import { CaptureCode } from "./capture_worklet_inline.ts";
import { PlayoutCode } from "./playout_worklet_inline.ts";
import {
	type AudioWorkletHost,
	AudioWorkletModule,
	type ProcessorNode,
	stopProcessor,
} from "./audio_worklet_module.ts";
import {
	CAPTURE_PROCESSOR_NAME,
	PLAYOUT_PROCESSOR_NAME,
	type StopMessage,
} from "./audio_worklet_protocol.ts";
import {
	type FakeProcessorPort,
	setupFakeAudioWorkletEnvironment,
} from "./fake_audio_worklet_environment_test.ts";

// An audio context's worklet: records the module URLs it is asked to add and
// fails the next add with the first of `failures`, if any.
class FakeWorkletHost implements AudioWorkletHost {
	readonly added: string[] = [];
	readonly failures: Error[] = [];
	readonly audioWorklet = {
		addModule: (moduleUrl: string): Promise<void> => {
			this.added.push(moduleUrl);
			const failure = this.failures.shift();
			return failure === undefined ? Promise.resolve() : Promise.reject(failure);
		},
	};
}

class FakeModuleLoadError extends Error {
	constructor() {
		super("module failed to load");
		this.name = "FakeModuleLoadError";
	}
}

Deno.test("load adds the module to a context once however often it is called", async () => {
	const module = new AudioWorkletModule("");
	const host = new FakeWorkletHost();

	await Promise.all([module.load(host), module.load(host), module.load(host)]);

	assertEquals(host.added.length, 1);
});

Deno.test("load adds the module to each context from one Blob URL", async () => {
	const module = new AudioWorkletModule("");
	const first = new FakeWorkletHost();
	const second = new FakeWorkletHost();

	await module.load(first);
	await module.load(second);

	assertEquals(second.added, first.added);
});

Deno.test("load rejects with the error of a failed load", async () => {
	const module = new AudioWorkletModule("");
	const host = new FakeWorkletHost();
	host.failures.push(new FakeModuleLoadError());

	await assertRejects(() => module.load(host), FakeModuleLoadError, "module failed to load");
});

Deno.test("load starts a failed load again on the next call", async () => {
	const module = new AudioWorkletModule("");
	const host = new FakeWorkletHost();
	host.failures.push(new FakeModuleLoadError());
	await module.load(host).catch(() => {
		// reason: the first load is meant to fail; the test is about the next one.
	});

	await module.load(host);

	assertEquals(host.added.length, 2);
});

// A worklet node: records what is posted to its port, whether the port closed
// and whether the node left the graph; posting throws `postError` when set.
class FakeProcessorNode implements ProcessorNode {
	readonly sent: StopMessage[] = [];
	postError: Error | null = null;
	closed = false;
	connected = true;
	readonly port = {
		postMessage: (message: StopMessage): void => {
			if (this.postError !== null) throw this.postError;
			this.sent.push(message);
		},
		close: (): void => {
			this.closed = true;
		},
	};

	disconnect(): void {
		this.connected = false;
	}
}

Deno.test("stopProcessor posts a stop message to the processor", () => {
	const node = new FakeProcessorNode();

	stopProcessor(node);

	assertEquals(node.sent, [{ type: "stop" }]);
});

Deno.test("stopProcessor closes the node's port", () => {
	const node = new FakeProcessorNode();

	stopProcessor(node);

	assertEquals(node.closed, true);
});

Deno.test("stopProcessor takes the node out of the graph", () => {
	const node = new FakeProcessorNode();

	stopProcessor(node);

	assertEquals(node.connected, false);
});

Deno.test("stopProcessor still releases the node when posting fails", () => {
	const node = new FakeProcessorNode();
	node.postError = new DOMException("port closed", "InvalidStateError");

	stopProcessor(node);

	assertEquals({ closed: node.closed, connected: node.connected }, {
		closed: true,
		connected: false,
	});
});

// Each worklet, as its TypeScript source and as the inline code that ships.
// `evaluate(n)` evaluates a fresh copy of the module in the current scope;
// `unversioned` is the name releases before versioned names registered.
const worklets = [
	{
		name: "the playout worklet source",
		processor: PLAYOUT_PROCESSOR_NAME,
		unversioned: "audio-offloader",
		evaluate: (n: number) => import(`./playout_worklet.ts?evaluation=${n}`),
	},
	{
		name: "the inline playout worklet",
		processor: PLAYOUT_PROCESSOR_NAME,
		unversioned: "audio-offloader",
		evaluate: (n: number) =>
			import(`data:text/javascript,${encodeURIComponent(`${PlayoutCode}//${n}`)}`),
	},
	{
		name: "the capture worklet source",
		processor: CAPTURE_PROCESSOR_NAME,
		unversioned: "audio-hijacker",
		evaluate: (n: number) => import(`./capture_worklet.ts?evaluation=${n}`),
	},
	{
		name: "the inline capture worklet",
		processor: CAPTURE_PROCESSOR_NAME,
		unversioned: "audio-hijacker",
		evaluate: (n: number) =>
			import(`data:text/javascript,${encodeURIComponent(`${CaptureCode}//${n}`)}`),
	},
] as const;

for (const w of worklets) {
	Deno.test(`${w.name} registers its processor once when evaluated twice in a scope`, async () => {
		const env = setupFakeAudioWorkletEnvironment();
		try {
			await w.evaluate(1);

			await w.evaluate(2);

			assertEquals(env.registerProcessorCalls.map(([name]) => name), [w.processor]);
		} finally {
			env.restore();
		}
	});

	Deno.test(`${w.name} registers its processor beside another version's`, async () => {
		const env = setupFakeAudioWorkletEnvironment();
		try {
			globalThis.registerProcessor(w.unversioned, class extends AudioWorkletProcessor {});

			await w.evaluate(3);

			assertEquals(env.registerProcessorCalls.map(([name]) => name), [
				w.unversioned,
				w.processor,
			]);
		} finally {
			env.restore();
		}
	});
}

interface Processor {
	readonly port: FakeProcessorPort;
	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorConstructor = new (options: AudioWorkletNodeOptions) => Processor;

function isProcessorConstructor(value: unknown): value is ProcessorConstructor {
	return typeof value === "function";
}

// Evaluates a worklet module in a fake scope and returns the processor it
// registered.
async function registeredProcessor(
	evaluate: () => Promise<unknown>,
): Promise<ProcessorConstructor> {
	const env = setupFakeAudioWorkletEnvironment();
	try {
		await evaluate();
		const processor = env.registerProcessorCalls[0]?.[1];
		if (!isProcessorConstructor(processor)) throw new TypeError("no processor registered");
		return processor;
	} finally {
		env.restore();
	}
}

const processors = [
	{
		name: "the playout processor",
		processor: await registeredProcessor(() => import("./playout_worklet.ts?stop")),
		options: { channelCount: 2, processorOptions: { sampleRate: 48000, latency: 80 } },
	},
	{
		name: "the capture processor",
		processor: await registeredProcessor(() => import("./capture_worklet.ts?stop")),
		options: { processorOptions: { sampleRate: 48000, targetChannels: 1 } },
	},
] as const;

const stop: StopMessage = { type: "stop" };

// Renders one quantum with no input into two output channels.
function renderQuantum(processor: Processor): boolean {
	return processor.process([], [[new Float32Array(128), new Float32Array(128)]]);
}

for (const p of processors) {
	Deno.test(`${p.name} keeps rendering until it is told to stop`, () => {
		const processor = new p.processor(p.options);

		const rendering = renderQuantum(processor);

		assertEquals(rendering, true);
	});

	Deno.test(`${p.name} renders nothing more after a stop message`, () => {
		const processor = new p.processor(p.options);
		processor.port.onmessage?.(new MessageEvent("message", { data: stop }));

		const rendering = renderQuantum(processor);

		assertEquals(rendering, false);
	});

	Deno.test(`${p.name} closes its port on a stop message`, () => {
		const processor = new p.processor(p.options);

		processor.port.onmessage?.(new MessageEvent("message", { data: stop }));

		assertEquals(processor.port.closed, true);
	});
}

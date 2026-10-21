import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { FakeGainNode } from "./fake_gainnode_test.ts";
import { VAD_PROCESSOR_NAME } from "./audio_worklet_protocol.ts";

// GainNode and AudioWorkletNode must be the fakes before the node's module
// is evaluated, as it extends GainNode.
function overrideGlobal(name: string, value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const has = Object.prototype.hasOwnProperty.call(g, name);
	const original = g[name];
	g[name] = value;
	return () => {
		if (has) g[name] = original;
		else delete g[name];
	};
}

/** The processor's side of a created worklet: what was posted, and its options. */
class FakeVoiceWorkletNode {
	static readonly created: FakeVoiceWorkletNode[] = [];
	readonly name: string;
	readonly options: AudioWorkletNodeOptions | undefined;
	readonly posted: unknown[] = [];
	closed = false;
	disconnected = false;
	readonly port = {
		onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
		postMessage: (message: unknown) => this.posted.push(message),
		close: () => {
			this.closed = true;
		},
	};

	constructor(_context: unknown, name: string, options?: AudioWorkletNodeOptions) {
		this.name = name;
		this.options = options;
		FakeVoiceWorkletNode.created.push(this);
	}

	/** The processor posts `data` to the node. */
	send(data: unknown): void {
		this.port.onmessage?.(new MessageEvent("message", { data }));
	}

	connect(): void {}
	disconnect(): void {
		this.disconnected = true;
	}
}

const restoreGainNode = overrideGlobal("GainNode", FakeGainNode);
const restoreWorkletNode = overrideGlobal("AudioWorkletNode", FakeVoiceWorkletNode);
const { VoiceActivityEvent, VoiceActivityNode, VoiceActivityNodeOptionError } = await import(
	"./voice_activity_node.ts"
);

/** A context whose worklet module loads, once the test lets it. */
function fakeContext() {
	let loaded = () => {};
	const ready = new Promise<void>((resolve) => (loaded = resolve));
	return {
		sampleRate: 48_000,
		audioWorklet: { addModule: () => ready },
		loaded,
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A node whose worklet has been created; returns both. */
async function attached(init?: ConstructorParameters<typeof VoiceActivityNode>[1]) {
	const context = fakeContext();
	const before = FakeVoiceWorkletNode.created.length;
	const node = new VoiceActivityNode(context, init);
	context.loaded();
	await settle();
	const worklet = FakeVoiceWorkletNode.created[before];
	if (worklet === undefined) throw new Error("no worklet created");
	return { node, worklet };
}

Deno.test("VoiceActivityNode", async (t) => {
	await t.step("creates its processor with the context's rate and the defaults", async () => {
		const { node, worklet } = await attached();

		assertEquals(worklet.name, VAD_PROCESSOR_NAME);
		assertEquals(worklet.options?.processorOptions, {
			sampleRate: 48_000,
			windowMs: 20,
			detector: { onDb: 9, offDb: 5, holdMs: 350, floorRiseDbPerSec: 4, minDb: -50 },
		});
		node.dispose();
	});

	await t.step("passes the thresholds it was given, keeping the rest", async () => {
		const { node, worklet } = await attached({ detector: { onDb: 12 }, windowMs: 10 });

		const options = worklet.options?.processorOptions as Record<string, unknown>;
		assertEquals([options.windowMs, (options.detector as { onDb: number }).onDb], [10, 12]);
		node.dispose();
	});

	await t.step("refuses thresholds no detector can work with", () => {
		const cases = [
			{ name: "stop above start", init: { detector: { onDb: 3, offDb: 6 } } },
			{ name: "negative hold", init: { detector: { holdMs: -1 } } },
			{ name: "zero window", init: { windowMs: 0 } },
			{ name: "endless window", init: { windowMs: Infinity } },
		];
		for (const c of cases) {
			assertThrows(
				() => new VoiceActivityNode(fakeContext(), c.init),
				VoiceActivityNodeOptionError,
				undefined,
				c.name,
			);
		}
	});

	await t.step("is silent until its processor reports a voice", async () => {
		const { node } = await attached();

		assertEquals(node.speaking, false);
		node.dispose();
	});

	await t.step("reports each change as an event with its time", async () => {
		const { node, worklet } = await attached();
		const seen: [boolean, number][] = [];
		node.addEventListener("speakingchange", (e) => {
			assertInstanceOf(e, VoiceActivityEvent);
			seen.push([e.speaking, e.time]);
		});

		worklet.send({ type: "speaking", speaking: true, time: 520 });
		worklet.send({ type: "speaking", speaking: false, time: 1400 });

		assertEquals(seen, [[true, 520], [false, 1400]]);
		node.dispose();
	});

	await t.step("calls onspeakingchange as well as listeners", async () => {
		const { node, worklet } = await attached();
		let called = 0;
		node.onspeakingchange = () => called++;

		worklet.send({ type: "speaking", speaking: true, time: 1 });

		assertEquals([called, node.speaking], [1, true]);
		node.dispose();
	});

	await t.step("ignores malformed messages and repeats of the current state", async () => {
		const { node, worklet } = await attached();
		let events = 0;
		node.addEventListener("speakingchange", () => events++);

		worklet.send({ type: "speaking", speaking: "yes", time: 1 });
		worklet.send({ type: "level", level: -20 });
		worklet.send({ type: "speaking", speaking: false, time: 2 });

		assertEquals(events, 0);
		node.dispose();
	});

	await t.step("dispose stops the processor and ends a voice heard", async () => {
		const { node, worklet } = await attached();
		worklet.send({ type: "speaking", speaking: true, time: 1 });
		const seen: boolean[] = [];
		node.addEventListener(
			"speakingchange",
			(e) => seen.push((e as InstanceType<typeof VoiceActivityEvent>).speaking),
		);

		node.dispose();

		assertEquals(worklet.posted, [{ type: "stop" }]);
		assertEquals([worklet.closed, worklet.disconnected, node.speaking, seen], [
			true,
			true,
			false,
			[false],
		]);
	});

	await t.step("a node disposed while loading creates no processor", async () => {
		const context = fakeContext();
		const before = FakeVoiceWorkletNode.created.length;
		const node = new VoiceActivityNode(context);

		node.dispose();
		context.loaded();
		await settle();

		assertEquals(FakeVoiceWorkletNode.created.length, before);
	});

	await t.step("messages after dispose are ignored", async () => {
		const { node, worklet } = await attached();
		node.dispose();
		let events = 0;
		node.addEventListener("speakingchange", () => events++);

		worklet.send({ type: "speaking", speaking: true, time: 1 });

		assertEquals([events, node.speaking], [0, false]);
	});

	await t.step("restore globals", () => {
		restoreWorkletNode();
		restoreGainNode();
	});
});

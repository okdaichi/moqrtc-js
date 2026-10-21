/// <reference path="../../../src/test_globals.d.ts" />
import { assertEquals } from "@std/assert";
import { isSpeakingMessage, type SpeakingMessage } from "./voice_activity_protocol.ts";
import { VAD_PROCESSOR_NAME } from "./audio_worklet_protocol.ts";
import {
	type FakeProcessorPort,
	setupFakeAudioWorkletEnvironment,
} from "./fake_audio_worklet_environment_test.ts";

interface Processor {
	readonly port: FakeProcessorPort;
	process(inputs: Float32Array[][]): boolean;
}

type ProcessorConstructor = new (options: AudioWorkletNodeOptions) => Processor;

const RATE = 48_000;
const QUANTUM = 128;

// The real VoiceActivityProcessor: the worklet module evaluated once in a
// fake worklet scope, so the tests exercise the code that ships.
const registered = await (async () => {
	const env = setupFakeAudioWorkletEnvironment();
	try {
		await import("./voice_activity_worklet.ts?behaviour");
		const [name, processor] = env.registerProcessorCalls[0] ?? [];
		if (typeof processor !== "function") throw new TypeError("no processor registered");
		return { name, Processor: processor as ProcessorConstructor };
	} finally {
		env.restore();
	}
})();

const newProcessor = (processorOptions: Record<string, unknown> = {}) =>
	new registered.Processor({ processorOptions: { sampleRate: RATE, ...processorOptions } });

/** A tone at `hz` and `amplitude`, `ms` long, as channels of render quanta. */
function* tone(hz: number, amplitude: number, ms: number, channels = 1): Generator<Float32Array[]> {
	const frames = Math.round(RATE * ms / 1000);
	for (let start = 0; start < frames; start += QUANTUM) {
		const q = new Float32Array(QUANTUM);
		for (let i = 0; i < QUANTUM; i++) {
			q[i] = amplitude * Math.sin(2 * Math.PI * hz * (start + i) / RATE);
		}
		yield Array.from({ length: channels }, () => q);
	}
}

function* silence(ms: number): Generator<Float32Array[]> {
	yield* tone(0, 0, ms);
}

/** Feeds `quanta` and returns what the processor posted. */
function feed(p: Processor, ...quanta: Iterable<Float32Array[]>[]): SpeakingMessage[] {
	for (const run of quanta) {
		for (const channels of run) p.process([channels]);
	}
	return p.port.sent.filter(isSpeakingMessage);
}

const speakingOf = (sent: SpeakingMessage[]) => sent.map((m) => m.speaking);

Deno.test("the processor registers under its versioned name", () => {
	assertEquals(registered.name, VAD_PROCESSOR_NAME);
});

Deno.test("a voice in a quiet room is reported speaking, then not after it stops", () => {
	const p = newProcessor();

	const sent = feed(p, silence(500), tone(200, 0.1, 500), silence(1000));

	assertEquals(speakingOf(sent), [true, false]);
});

Deno.test("the change is stamped with the input time it happened at", () => {
	const p = newProcessor();

	const [start] = feed(p, silence(500), tone(200, 0.1, 100));

	// The first 20 ms window of the voice ends about 520 ms into the input.
	assertEquals(Math.round((start?.time ?? 0) / 20) * 20, 520);
});

Deno.test("mains hum is never reported as speaking", () => {
	// 60 Hz at -26 dBFS would be heard unfiltered; below the voice band it
	// falls under the near-silence gate.
	const p = newProcessor();

	const sent = feed(p, silence(200), tone(60, 0.05, 3000));

	assertEquals(sent, []);
});

Deno.test("a steady tone that runs for seconds becomes the room's floor", () => {
	const p = newProcessor();

	const sent = feed(p, silence(500), tone(1000, 0.05, 15_000));

	// Heard as it starts, absorbed into the floor within seconds.
	assertEquals(speakingOf(sent), [true, false]);
});

Deno.test("only a change is posted, never the same state twice", () => {
	const p = newProcessor();

	const sent = feed(p, silence(300), tone(200, 0.1, 2000));

	assertEquals(speakingOf(sent), [true]);
});

Deno.test("a disconnected input counts as silence", () => {
	const p = newProcessor();
	feed(p, silence(500), tone(200, 0.1, 300));

	for (let i = 0; i < 400; i++) p.process([[]]); // about a second with no input
	const sent = p.port.sent.filter(isSpeakingMessage);

	assertEquals(speakingOf(sent), [true, false]);
});

Deno.test("stereo input is mixed to mono before it is measured", () => {
	const p = newProcessor();

	const sent = feed(p, silence(500), tone(200, 0.1, 300, 2));

	assertEquals(speakingOf(sent), [true]);
});

Deno.test("detector options given by the node are used", () => {
	// A start threshold no voice can reach: nothing is ever heard.
	const p = newProcessor({
		detector: { onDb: 200, offDb: 5, holdMs: 350, floorRiseDbPerSec: 4, minDb: -50 },
	});

	const sent = feed(p, silence(500), tone(200, 0.1, 500));

	assertEquals(sent, []);
});

Deno.test("invalid detector options fall back to the defaults", () => {
	const p = newProcessor({ detector: { onDb: "loud" } });

	const sent = feed(p, silence(500), tone(200, 0.1, 300));

	assertEquals(speakingOf(sent), [true]);
});

Deno.test("a stop message ends the processor and closes its port", () => {
	const p = newProcessor();

	p.port.onmessage?.(new MessageEvent("message", { data: { type: "stop" } }));
	const keepsRunning = p.process([[new Float32Array(QUANTUM)]]);

	assertEquals([keepsRunning, p.port.closed], [false, true]);
});

/// <reference path="../../../src/test_globals.d.ts" />
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
	type FormatMessage,
	type FrameMessage,
	isCaptureMessage,
} from "./audio_hijack_protocol.ts";
import { importWorkletUrl } from "./audio_hijack_worklet.ts";
import { HIJACK_PROCESSOR_NAME } from "./audio_worklet_protocol.ts";
import {
	type FakeProcessorPort,
	setupFakeAudioWorkletEnvironment,
} from "./fake_audio_worklet_environment_test.ts";

interface Processor {
	readonly port: FakeProcessorPort;
	process(inputs: Float32Array[][]): boolean;
}

type ProcessorConstructor = new (options: AudioWorkletNodeOptions) => Processor;

function isProcessorConstructor(value: unknown): value is ProcessorConstructor {
	return typeof value === "function";
}

const SAMPLE_RATE = 48000;
const QUANTUM = 128;
// A 20 ms codec frame at 48 kHz.
const FRAME = 960;

// The real AudioHijackProcessor: the worklet module evaluated once in a fake
// worklet scope, so the tests exercise the code that ships.
const HijackProcessor = await (async () => {
	const env = setupFakeAudioWorkletEnvironment();
	try {
		await import("./audio_hijack_worklet.ts?behaviour");
		const processor = env.registerProcessorCalls[0]?.[1];
		if (!isProcessorConstructor(processor)) throw new TypeError("no processor registered");
		return processor;
	} finally {
		env.restore();
	}
})();

function createProcessor(
	options: { channels?: number; frameLength?: number } = {},
): Processor {
	return new HijackProcessor({
		processorOptions: {
			sampleRate: SAMPLE_RATE,
			targetChannels: options.channels ?? 1,
			frameLength: options.frameLength,
		},
	});
}

// The context's render clock as the worklet scope exposes it, restored after
// `fn` runs.
function withClock(fn: (at: (frame: number) => void) => void): void {
	const saved = Object.getOwnPropertyDescriptor(globalThis, "currentFrame");
	try {
		fn((frame) => {
			globalThis.currentFrame = frame;
		});
	} finally {
		if (saved) Object.defineProperty(globalThis, "currentFrame", saved);
		else Reflect.deleteProperty(globalThis, "currentFrame");
	}
}

// Renders `count` quanta of continuous input from clock frame `from`, each
// sample on every channel being its clock frame.
function capture(
	processor: Processor,
	count: number,
	options: { from?: number; channels?: number } = {},
): void {
	const from = options.from ?? 0;
	withClock((at) => {
		for (let q = 0; q < count; q++) {
			const start = from + q * QUANTUM;
			at(start);
			const quantum = Array.from(
				{ length: options.channels ?? 1 },
				() => Float32Array.from({ length: QUANTUM }, (_, i) => start + i),
			);
			processor.process([quantum]);
		}
	});
}

// Renders one quantum with no input.
function silence(processor: Processor): void {
	processor.process([[]]);
}

function deliver(processor: Processor, data: unknown): void {
	processor.port.onmessage?.(new MessageEvent("message", { data }));
}

function frames(processor: Processor): FrameMessage[] {
	return processor.port.sent.filter((message): message is FrameMessage =>
		isCaptureMessage(message) && message.type === "frame"
	);
}

// What each message the processor posted was: a frame's length, or "ended".
function posted(processor: Processor): (number | "ended")[] {
	return processor.port.sent.filter(isCaptureMessage).map((message) =>
		message.type === "frame" ? message.numberOfFrames : "ended"
	);
}

Deno.test("provides a URL for the worklet script", () => {
	const url = importWorkletUrl();

	assert(url.endsWith("audio_hijack_worklet.js"));
});

Deno.test("registers the processor under its versioned name", async () => {
	const env = setupFakeAudioWorkletEnvironment();
	try {
		await import("./audio_hijack_worklet.ts?register");

		assertEquals(env.registerProcessorCalls.map(([name]) => name), [HIJACK_PROCESSOR_NAME]);
	} finally {
		env.restore();
	}
});

const frameCountCases = [
	{ name: "less than a frame", quanta: 7, frames: 0 },
	{ name: "exactly two frames", quanta: 15, frames: 2 },
	{ name: "a frame and a half", quanta: 11, frames: 1 },
	{ name: "one second", quanta: 375, frames: 50 },
] as const;
for (const c of frameCountCases) {
	Deno.test(`posts one 960-frame frame per 960 frames captured, for ${c.name}`, () => {
		const processor = createProcessor();

		capture(processor, c.quanta);

		assertEquals(posted(processor), Array(c.frames).fill(FRAME));
	});
}

Deno.test("stamps consecutive frames 20 ms apart across quanta", () => {
	const processor = createProcessor();

	capture(processor, 375, { from: SAMPLE_RATE });

	assertEquals(
		frames(processor).map((frame) => frame.timestamp),
		Array.from({ length: 50 }, (_, i) => 1_000_000 + i * 20_000),
	);
});

Deno.test("carries every captured sample in order across quantum boundaries", () => {
	const processor = createProcessor();

	capture(processor, 15);

	assertEquals(
		frames(processor).map((frame) => Array.from(frame.data)),
		[0, 1].map((f) => Array.from({ length: FRAME }, (_, i) => f * FRAME + i)),
	);
});

Deno.test("lays out a frame's channels as planes", () => {
	const processor = createProcessor({ channels: 2 });

	capture(processor, 8, { channels: 2 });

	const [frame] = frames(processor);
	const plane = Array.from({ length: FRAME }, (_, i) => i);
	assertEquals(frame?.data, new Float32Array([...plane, ...plane]));
});

Deno.test("hands each frame's buffer over to the node", () => {
	const processor = createProcessor();

	capture(processor, 15);

	const [first, second] = frames(processor);
	assert(first !== undefined && second !== undefined);
	assert(first.data.buffer !== second.data.buffer);
});

Deno.test("posts the frame captured so far when the input ends, then says so once", () => {
	const processor = createProcessor();
	capture(processor, 9);

	silence(processor);
	silence(processor);

	assertEquals(posted(processor), [FRAME, 9 * QUANTUM - FRAME, "ended"]);
});

Deno.test("stamps the first frame after the input comes back by the clock", () => {
	const processor = createProcessor();
	capture(processor, 8);
	silence(processor);

	capture(processor, 8, { from: 5 * SAMPLE_RATE });

	assertEquals(frames(processor).map((frame) => frame.timestamp), [0, 20_000, 5_000_000]);
});

Deno.test("posts the frame captured so far at a jump in the clock", () => {
	const processor = createProcessor();
	capture(processor, 4);

	capture(processor, 8, { from: SAMPLE_RATE });

	assertEquals(
		frames(processor).map((frame) => [frame.timestamp, frame.numberOfFrames]),
		[[0, 4 * QUANTUM], [1_000_000, FRAME]],
	);
});

Deno.test("repeats the first channel for a missing one", () => {
	const processor = createProcessor({ channels: 2 });

	capture(processor, 8, { channels: 1 });

	const [frame] = frames(processor);
	assertEquals(frame?.data.subarray(FRAME), frame?.data.subarray(0, FRAME));
});

Deno.test("reads a channel shorter than the first as silence", () => {
	const processor = createProcessor({ channels: 2, frameLength: 4 });

	withClock((at) => {
		at(0);
		processor.process([[new Float32Array([1, 2, 3, 4]), new Float32Array([5, 6])]]);
	});

	assertEquals(frames(processor)[0]?.data, new Float32Array([1, 2, 3, 4, 5, 6, 0, 0]));
});

Deno.test("takes the frame length from its options", () => {
	const processor = createProcessor({ frameLength: 480 });

	capture(processor, 15);

	assertEquals(posted(processor), [480, 480, 480, 480]);
});

Deno.test("posts the frame captured so far, then captures in the format a message sets", () => {
	const processor = createProcessor({ channels: 2 });
	capture(processor, 2, { channels: 2 });
	const format: FormatMessage = { type: "format", channels: 1, frameLength: 480 };

	deliver(processor, format);
	capture(processor, 4, { from: 2 * QUANTUM });

	assertEquals(
		frames(processor).map((frame) => [frame.numberOfChannels, frame.numberOfFrames]),
		[[2, 2 * QUANTUM], [1, 480]],
	);
});

Deno.test("continues the timestamps across a change of format", () => {
	const processor = createProcessor({ channels: 2 });
	capture(processor, 2, { channels: 2 });
	const format: FormatMessage = { type: "format", channels: 1, frameLength: 480 };

	deliver(processor, format);
	capture(processor, 4, { from: 2 * QUANTUM });

	assertEquals(
		frames(processor).map((frame) => frame.timestamp),
		[0, Math.round(2 * QUANTUM * 1_000_000 / SAMPLE_RATE)],
	);
});

const malformedFormats = [
	{ name: "no type", data: { channels: 1, frameLength: 480 } },
	{ name: "zero channels", data: { type: "format", channels: 0, frameLength: 480 } },
	{ name: "fractional channels", data: { type: "format", channels: 1.5, frameLength: 480 } },
	{ name: "no frame length", data: { type: "format", channels: 1 } },
	{ name: "a negative frame length", data: { type: "format", channels: 1, frameLength: -1 } },
	{ name: "not an object", data: "format" },
] as const;
for (const c of malformedFormats) {
	Deno.test(`ignores a format message with ${c.name}`, () => {
		const processor = createProcessor();

		deliver(processor, c.data);
		capture(processor, 8);

		assertEquals(posted(processor), [FRAME]);
	});
}

Deno.test("throws for more than one input", () => {
	const processor = createProcessor();

	assertThrows(() => processor.process([[], []]), Error, "only one input is supported.");
});

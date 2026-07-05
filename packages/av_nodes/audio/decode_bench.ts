// Audio decode plumbing harness.
//
// Scope (read before trusting numbers):
// - FakeAudioData.copyTo does real work (sine fill per channel) and clone()
//   allocates, so the channel-extraction in #process is measured realistically.
// - FakeAudioWorkletNode.port.postMessage is a no-op, and FakeAudioDecoder
//   models decode as an instant microtask. So this measures NODE-PLUMBING +
//   channel-extraction overhead, not real codec cost.
//
// Pipeline: EncodedAudioChunk stream --decodeFrom--> AudioDecodeNode
//           --decoder output--> #process (channel extract + postMessage)
//
// Run: deno bench packages/av_nodes/audio/decode_bench.ts --allow-all

import { FakeAudioContext } from "./fake_audio_context_test.ts";
import { FakeAudioWorkletNode } from "./fake_audio_workletnode_test.ts";
import { FakeAudioDecoder } from "./fake_audiodecoder_test.ts";
import { FakeGainNode } from "./fake_gainnode_test.ts";
import { FakeEncodedAudioChunk } from "./fake_encodedaudiochunk_test.ts";

function overrideGlobal(name: string, value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const had = Object.prototype.hasOwnProperty.call(g, name);
	const orig = g[name];
	g[name] = value;
	return () => {
		if (had) g[name] = orig;
		else delete g[name];
	};
}

overrideGlobal("GainNode", FakeGainNode);
overrideGlobal("AudioWorkletNode", FakeAudioWorkletNode);
overrideGlobal(
	"AudioDecoder",
	function (this: unknown, init: AudioDecoderInit) {
		return new FakeAudioDecoder(init);
	},
);

const { AudioDecodeNode } = await import("./decode_node.ts");

const N = 5000;

async function settle(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

function makeContext(): FakeAudioContext {
	const ctx = new FakeAudioContext();
	(ctx as unknown as Record<string, unknown>).state = "running";
	return ctx;
}

async function runDecode(n: number): Promise<{ elapsedMs: number; fps: number }> {
	const context = makeContext();
	const node = new AudioDecodeNode(context as unknown as AudioContext);
	node.configure({
		codec: "opus",
		sampleRate: 48000,
		numberOfChannels: 2,
	});

	const stream = new ReadableStream<EncodedAudioChunk>({
		start(controller) {
			for (let i = 0; i < n; i++) {
				controller.enqueue(new FakeEncodedAudioChunk("key", i * 21333));
			}
			controller.close();
		},
	});

	const start = performance.now();
	const { done } = node.decodeFrom(stream);
	await done;
	await settle(); // drain trailing decoder microtasks -> #process -> postMessage
	const elapsedMs = performance.now() - start;
	const fps = n / (elapsedMs / 1000);

	node.dispose();
	return { elapsedMs, fps };
}

Deno.bench({
	name: "audio decode plumbing throughput (5000 frames)",
	group: "audio-decode",
	baseline: true,
	async fn() {
		await runDecode(N);
	},
});

// Standalone runner for quick multi-run median (used outside deno bench).
if (import.meta.main) {
	const runs: number[] = [];
	for (let i = 0; i < 15; i++) {
		const { fps } = await runDecode(N);
		runs.push(fps);
	}
	runs.sort((a, b) => a - b);
	const median = runs[Math.floor(runs.length / 2)] ?? 0;
	const lo = runs[0] ?? 0;
	const hi = runs[runs.length - 1] ?? 0;
	console.log(`audio decode fps runs: min ${lo.toFixed(0)} median ${median.toFixed(0)} max ${hi.toFixed(0)}`);
}

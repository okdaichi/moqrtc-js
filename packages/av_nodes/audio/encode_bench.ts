// Audio encode #next-path harness.
//
// Drives the REAL production path: worklet.port.onmessage -> node-owned
// ReadableStream -> #next (read/clone-or-not/encode/close). We feed N
// AudioDataInit messages into the captured worklet port and wait until the
// encoder has encoded all N.
//
// Scope: FakeAudioData.clone() allocates a real FakeAudioData, so the clone
// cost IS measured (unlike video). FakeAudioEncoder models encode as a
// microtask. Measures node-plumbing + AudioData alloc/close, not real codec.
//
// Run: deno run --allow-all packages/av_nodes/audio/encode_bench.ts

import { FakeAudioContext } from "./fake_audio_context_test.ts";
import { FakeAudioWorkletNode } from "./fake_audio_workletnode_test.ts";
import { FakeAudioEncoder } from "./fake_audioencoder_test.ts";
import { FakeAudioData } from "./fake_audiodata_test.ts";
import { FakeGainNode } from "./fake_gainnode_test.ts";

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

// AudioData ctor that accepts either AudioDataInit (from worklet) or the
// positional (frames, channels, sampleRate, ts) form used by FakeAudioData.
class FakeAudioDataCtor extends FakeAudioData {
	constructor(
		initOrFrames?: unknown,
		channels?: number,
		sampleRate?: number,
		timestamp?: number,
	) {
		if (
			typeof initOrFrames === "object" && initOrFrames !== null
		) {
			const init = initOrFrames as AudioDataInit;
			super(
				init.numberOfFrames ?? 1024,
				init.numberOfChannels ?? 2,
				init.sampleRate ?? 44100,
				init.timestamp ?? 0,
			);
		} else {
			super(
				initOrFrames as number | undefined,
				channels,
				sampleRate,
				timestamp,
			);
		}
	}
}
overrideGlobal("AudioData", FakeAudioDataCtor);

// Worklet that records its instance so the harness can drive port.onmessage.
let lastWorklet: FakeAudioWorkletNode | null = null;
class RecordingWorklet extends FakeAudioWorkletNode {
	constructor(
		ctx?: BaseAudioContext,
		name?: string,
		opts?: AudioWorkletNodeOptions,
	) {
		super(ctx, name, opts);
		lastWorklet = this;
	}
}
overrideGlobal("AudioWorkletNode", RecordingWorklet);
overrideGlobal(
	"AudioEncoder",
	function (this: unknown, init: AudioEncoderInit) {
		return new FakeAudioEncoder(init);
	},
);

const { AudioEncodeNode } = await import("./encode_node.ts");

const N = 20000;

function makeContext(): FakeAudioContext {
	const ctx = new FakeAudioContext();
	(ctx as unknown as Record<string, unknown>).state = "running";
	return ctx;
}

async function runEncode(n: number): Promise<number> {
	const context = makeContext();
	const node = new AudioEncodeNode(context as unknown as AudioContext);
	node.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });

	// Wait for the worklet (addModule.then) to be constructed and #next started.
	await new Promise<void>((r) => setTimeout(r, 0));
	await new Promise<void>((r) => setTimeout(r, 0));

	const worklet = lastWorklet!;
	const encoder = FakeAudioEncoder.lastCreated!;

	const audioDataInit: AudioDataInit = {
		numberOfFrames: 1024,
		numberOfChannels: 2,
		sampleRate: 48000,
		format: "f32-planar",
		timestamp: 0,
		data: new Float32Array(1024 * 2),
	};

	const start = performance.now();
	for (let i = 0; i < n; i++) {
		audioDataInit.timestamp = i * 21333;
		// Drive the node's worklet onmessage -> ReadableStream -> #next.
		(worklet.port.onmessage as unknown as (
			ev: { data: AudioDataInit },
		) => void)({ data: audioDataInit });
	}

	// Wait until all N frames have been encoded.
	const deadline = start + 10000;
	while (encoder.encodeCalls.length < n && performance.now() < deadline) {
		await new Promise<void>((r) => setTimeout(r, 0));
	}
	const elapsedMs = performance.now() - start;

	node.dispose();
	return elapsedMs;
}

// `deno bench` entrypoint: a single run for regression detection.
Deno.bench({
	name: "audio encode #next throughput (20000 frames)",
	group: "audio-encode",
	baseline: true,
	async fn() {
		await runEncode(N);
	},
});

// Standalone runner for a GC-controlled multi-run median. Run with:
//   deno run --v8-flags=--expose-gc --allow-all packages/av_nodes/audio/encode_bench.ts
// Gated by import.meta.main so that `deno bench` (or any import) does not also
// execute this 20x20k-frame loop on module load.
if (import.meta.main) {
	const runs: number[] = [];
	// Force GC before each run if available (--v8-flags=--expose-gc) so the
	// comparison reflects steady-state allocation cost rather than GC scheduling
	// luck. Without this, run-to-run variance dwarfs the per-frame signal.
	const gc = (globalThis as unknown as { gc?: () => void }).gc?.bind(
		globalThis,
	);
	for (let i = 0; i < 20; i++) {
		gc?.();
		runs.push(await runEncode(N));
	}
	runs.sort((a, b) => a - b);
	// discard warmup tails, report median + trimmed mean of the middle 12
	const mid = runs.slice(4, 16);
	const median = mid[Math.floor(mid.length / 2)] ?? 0;
	const mean = mid.reduce((s, r) => s + r, 0) / mid.length;
	console.log(
		`audio encode #next: N=${N} frames, 20 runs (middle 12 used)`,
	);
	console.log(
		`elapsed ms: median ${median.toFixed(2)} mean ${mean.toFixed(2)} | fps median ${
			(N / (median / 1000)).toFixed(0)
		}`,
	);
	console.log(`all runs (ms): ${runs.map((r) => r.toFixed(0)).join(", ")}`);
}

/**
 * Global type augmentations for test environments.
 *
 * Only declares items NOT already present in lib.dom.d.ts.
 * For browser APIs that ARE in lib.dom.d.ts (AudioEncoder, GainNode, etc.),
 * tests can assign fake implementations without fighting the strict DOM types.
 */

declare global {
	/* ------------------------------------------------------------------ */
	/*  AudioWorkletGlobalScope APIs (not in lib.dom.d.ts)                 */
	/* ------------------------------------------------------------------ */
	// deno-lint-ignore no-explicit-any
	var AudioWorkletProcessor: new (...args: any[]) => { port: MessagePort };
	var registerProcessor: (
		name: string,
		// deno-lint-ignore no-explicit-any
		processorCtor: new (...args: any[]) => unknown,
	) => void;
	var sampleRate: number;

	/* ------------------------------------------------------------------ */
	/*  MediaStreamTrackProcessor (not in lib.dom.d.ts)                    */
	/* ------------------------------------------------------------------ */
	var MediaStreamTrackProcessor: {
		new (init: { track: MediaStreamTrack }): {
			readable: ReadableStream<VideoFrame>;
		};
	};

	/* ------------------------------------------------------------------ */
	/*  Test-only helpers injected by setupGlobalMocks()                   */
	/* ------------------------------------------------------------------ */
	var originalConsoleWarn: typeof console.warn;
	var warnCalls: unknown[][];
}

export {};

/**
 * Global type augmentations for test environments.
 *
 * Only declares items NOT already present in lib.dom.d.ts.
 * For browser APIs that ARE in lib.dom.d.ts (AudioEncoder, GainNode, etc.),
 * tests use stubGlobal()/deleteGlobal() from test-utils_test.ts to assign
 * fake implementations without fighting the strict DOM types.
 */

// deno-lint-ignore-file no-var

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

	/* ------------------------------------------------------------------ */
	/*  Build-time injection constants (also declared in volume.ts)        */
	/* ------------------------------------------------------------------ */
	var __DEFAULT_VOLUME__: number | undefined;
	var __DEFAULT_MIN_GAIN__: number | undefined;
	var __DEFAULT_FADE_TIME__: number | undefined;
}

export { };


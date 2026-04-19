// Build script: compile TypeScript to JavaScript
import { build, stop } from "https://deno.land/x/esbuild@v0.20.1/mod.js";

console.log("🔨 Building main.ts → main.js...");

try {
	// Build main application
	await build({
		entryPoints: ["./main.ts"],
		outfile: "./main.js",
		bundle: true,
		format: "esm",
		target: "es2020",
		platform: "browser",
	});

	console.log("🔨 Building audio worklets...");

	// // Build audio hijack worklet
	// await build({
	// 	entryPoints: ["../audio/audio_hijack_worklet.ts"],
	// 	outfile: "./audio_hijack_worklet.js",
	// 	bundle: false, // Don't bundle worklets - they need to be standalone
	// 	format: "esm",
	// 	target: "es2020",
	// 	platform: "browser",
	// });

	// // Build audio offload worklet
	// await build({
	// 	entryPoints: ["../audio/audio_offload_worklet.ts"],
	// 	outfile: "./audio_offload_worklet.js",
	// 	bundle: false,
	// 	format: "esm",
	// 	target: "es2020",
	// 	platform: "browser",
	// });

	console.log("✅ Build complete!");
} catch (error) {
	console.error("❌ Build failed:", error);
	Deno.exit(1);
} finally {
	stop();
}

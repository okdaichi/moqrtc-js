// Build script: compile TypeScript to JavaScript
import { build, stop } from "https://deno.land/x/esbuild@v0.20.1/mod.js";

console.log("🔨 Building main.ts → main.js...");

try {
	await build({
		entryPoints: ["./main.ts"],
		outfile: "./main.js",
		bundle: true,
		format: "esm",
		target: "es2020",
		platform: "browser",
	});

	console.log("✅ Build complete!");
} catch (error) {
	console.error("❌ Build failed:", error);
	Deno.exit(1);
} finally {
	stop();
}

#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
/// <reference lib="deno.ns" />
/**
 * Build script for AudioWorklet processors
 *
 * This script:
 * 1. Bundles worklet TypeScript files to JavaScript
 * 2. Generates TypeScript files that export the worklet code as strings
 * 3. Allows importing worklets as inline code instead of external files
 */

import { basename, dirname, fromFileUrl, join } from "https://deno.land/std@0.208.0/path/mod.ts";
import * as esbuild from "https://deno.land/x/esbuild@v0.20.1/mod.js";

// Get the directory where this script is located
const __dirname = dirname(fromFileUrl(import.meta.url));
// Audio worklet files are in the audio directory
const audioDir = join(__dirname, "..", "audio");

const WORKLET_FILES = [
	join(audioDir, "audio_hijack_worklet.ts"),
	join(audioDir, "audio_offload_worklet.ts"),
];

interface WorkletInfo {
	sourceFile: string;
	outputFile: string;
	exportName: string;
}

function getWorkletInfo(sourceFile: string): WorkletInfo {
	const baseName = basename(sourceFile, ".ts");
	const dir = dirname(sourceFile);
	const outputFile = join(dir, `${baseName}_inline.ts`);
	// Convert audio_hijack_worklet -> HijackCode, audio_offload_worklet -> OffloadCode
	let exportName: string;
	if (baseName.includes("hijack")) {
		exportName = "HijackCode";
	} else if (baseName.includes("offload")) {
		exportName = "OffloadCode";
	} else {
		// Fallback: convert audio_hijack_worklet -> audioHijackWorkletCode
		exportName = baseName
			.split("_")
			.map((part, i) => i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))
			.join("") + "Code";
	}

	return { sourceFile, outputFile, exportName };
}

async function buildWorklet(info: WorkletInfo): Promise<void> {
	const baseName = basename(info.sourceFile);
	const outputBaseName = basename(info.outputFile);
	console.log(`🔨 Building ${baseName} → ${outputBaseName}...`);

	// Bundle the worklet code
	const result = await esbuild.build({
		entryPoints: [info.sourceFile],
		bundle: true,
		format: "esm",
		write: false,
		minify: true,
		target: "es2022",
	});

	if (result.outputFiles.length === 0) {
		throw new Error(`No output files generated for ${info.sourceFile}`);
	}

	const outputFile = result.outputFiles[0];
	if (!outputFile) {
		throw new Error(`Output file is undefined for ${info.sourceFile}`);
	}

	let code = new TextDecoder().decode(outputFile.contents);

	// Extract worklet name before modifications
	const workletNameMatch = code.match(/var\s+(\w+)="([\w-]+)"/);
	const workletName = workletNameMatch ? workletNameMatch[2] : "audio-worklet";

	// Remove export statements - worklet doesn't need them
	code = code.replace(/export\s*\{[^}]*\}\s*;?\s*$/gm, "");
	code = code.replace(/export\s+(const|function|class)\s+/g, "$1 ");

	// Remove importWorkletUrl function (not needed in inline version)
	code = code.replace(
		/function\s+\w+\(\)\{return new URL\([^)]+\)\.href\}/g,
		"",
	);

	// Replace workletName variable with string literal in registerProcessor
	// Before: var h="audio-hijacker";...registerProcessor(h,l)
	// After: registerProcessor("audio-hijacker",l)
	if (workletNameMatch) {
		const varName = workletNameMatch[1];
		code = code.replace(new RegExp(`var\\s+${varName}="[^"]+";`, "g"), "");
		code = code.replace(
			new RegExp(`registerProcessor\\(${varName},`, "g"),
			`registerProcessor("${workletName}",`,
		);
	}

	// Generate TypeScript file with inline code
	const tsContent = `// Auto-generated file - do not edit manually
// Generated from ${basename(info.sourceFile)}

/**
 * Inline worklet code for ${basename(info.sourceFile, ".ts")}
 * This code is bundled and minified at build time.
 */
export const ${info.exportName} = ${JSON.stringify(code)};

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([${info.exportName}], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}
`;

	// Write the generated file
	await Deno.writeTextFile(info.outputFile, tsContent);

	// Format the generated file according to deno.json fmt settings
	const fmt = new Deno.Command("deno", { args: ["fmt", info.outputFile] });
	const fmtResult = await fmt.output();
	if (!fmtResult.success) {
		throw new Error(`deno fmt failed for ${basename(info.outputFile)}`);
	}

	console.log(`✅ Generated ${basename(info.outputFile)}`);
}

async function main() {
	console.log("🚀 Building AudioWorklet processors...\n");

	for (const sourceFile of WORKLET_FILES) {
		const info = getWorkletInfo(sourceFile);
		await buildWorklet(info);
	}

	console.log("\n✨ All worklets built successfully!");
	console.log("\nNext steps:");
	console.log(
		"1. Update encode_node.ts and decode_node.ts to import from *_inline.ts files",
	);
	console.log("2. Use createWorkletBlobUrl() instead of importWorkletUrl()");
}

// Run the build
if (import.meta.main) {
	try {
		await main();
		esbuild.stop();
	} catch (error) {
		console.error("❌ Build failed:", error);
		esbuild.stop();
		Deno.exit(1);
	}
}

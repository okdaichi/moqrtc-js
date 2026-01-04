import { audioEncoderConfig } from "../audio/audio_config.ts";
import { AudioDecodeNode, AudioEncodeDestination, AudioEncodeNode } from "../audio/mod.ts";
import {
	MediaStreamVideoSourceNode,
	VideoAnalyserNode,
	VideoContext,
	VideoDecodeNode,
	VideoEncodeDestination,
	VideoEncodeNode,
	VideoOverlayNode,
} from "../video/mod.ts";
import { videoEncoderConfig } from "../video/video_config.ts";

// ============================================================================
// Types
// ============================================================================

interface PipelineState {
	// Video pipeline
	sourceNode: MediaStreamVideoSourceNode | null;
	analyserNode: VideoAnalyserNode | null;
	encodeNode: VideoEncodeNode | null;
	decodeNode: VideoDecodeNode | null;
	overlayNode: VideoOverlayNode | null;
	outputContext: VideoContext | null;
	stream: MediaStream | null;
	running: boolean;

	// Audio pipeline (using browser's native Web Audio API)
	audioSourceNode: MediaStreamAudioSourceNode | null;
	audioEncodeNode: AudioEncodeNode | null;
	audioDecodeNode: AudioDecodeNode | null;
	audioContext: AudioContext | null;
}

interface Metrics {
	// Video metrics
	encodedFrames: number;
	decodedFrames: number;
	encodeQueueSize: number;
	decodeQueueSize: number;
	startTime: number;
	fps: number;

	// Audio metrics
	audioEncodedFrames: number;
	audioDecodedFrames: number;
	audioEncodeQueueSize: number;
	audioDecodeQueueSize: number;
}

// ============================================================================
// State
// ============================================================================

const pipeline: PipelineState = {
	// Video pipeline
	sourceNode: null,
	analyserNode: null,
	encodeNode: null,
	decodeNode: null,
	overlayNode: null,
	outputContext: null,
	stream: null,
	running: false,

	// Audio pipeline
	audioSourceNode: null,
	audioEncodeNode: null,
	audioDecodeNode: null,
	audioContext: null,
};

const metrics: Metrics = {
	// Video metrics
	encodedFrames: 0,
	decodedFrames: 0,
	encodeQueueSize: 0,
	decodeQueueSize: 0,
	startTime: 0,
	fps: 0,

	// Audio metrics
	audioEncodedFrames: 0,
	audioDecodedFrames: 0,
	audioEncodeQueueSize: 0,
	audioDecodeQueueSize: 0,
};

const DEBUG_METRICS = false;

// UI update cadence. Higher = more responsive, but can increase layout work.
// 250ms (~4Hz) is a good compromise for smooth-ish counters without stressing DOM.
const UI_UPDATE_INTERVAL_MS = 250;

function safeGetEncodeQueueSize(): number {
	try {
		return pipeline.encodeNode?.encodeQueueSize ?? 0;
	} catch {
		return 0;
	}
}

function safeGetDecodeQueueSize(): number {
	try {
		return pipeline.decodeNode?.decodeQueueSize ?? 0;
	} catch {
		return 0;
	}
}

function getOverlayText(): string {
	// Compute dynamically so it stays reactive even if DOM/rAF metrics loop is throttled.
	const encQ = safeGetEncodeQueueSize();
	const decQ = safeGetDecodeQueueSize();
	return `enc ${metrics.encodedFrames} | dec ${metrics.decodedFrames} | q ${encQ}/${decQ}`;
}

// ============================================================================
// DOM Elements (cached)
// ============================================================================

const elements = {
	status: () => document.getElementById("status"),
	// Video metrics
	encodedFrames: () => document.getElementById("encodedFrames"),
	decodedFrames: () => document.getElementById("decodedFrames"),
	encodeQueue: () => document.getElementById("encodeQueue"),
	decodeQueue: () => document.getElementById("decodeQueue"),
	codecConfig: () => document.getElementById("codecConfig"),
	sourceCanvas: () => document.getElementById("sourceCanvas") as HTMLCanvasElement,
	outputCanvas: () => document.getElementById("outputCanvas") as HTMLCanvasElement,
	brightness: () => document.getElementById("brightness"),
	contrast: () => document.getElementById("contrast"),
	saturation: () => document.getElementById("saturation"),
	dominantColor: () => document.getElementById("dominantColor"),
	colorBar: () => document.getElementById("colorBar"),
	// Audio metrics
	audioEncodedFrames: () => document.getElementById("audioEncodedFrames"),
	audioDecodedFrames: () => document.getElementById("audioDecodedFrames"),
	audioEncodeQueue: () => document.getElementById("audioEncodeQueue"),
	audioDecodeQueue: () => document.getElementById("audioDecodeQueue"),
	audioCodecConfig: () => document.getElementById("audioCodecConfig"),
	// Buttons
	startCameraBtn: () => document.getElementById("startCameraBtn") as HTMLButtonElement,
	startScreenBtn: () => document.getElementById("startScreenBtn") as HTMLButtonElement,
	stopBtn: () => document.getElementById("stopBtn") as HTMLButtonElement,
};

// ============================================================================
// UI Updates
// ============================================================================

function setStatus(
	message: string,
	type: "info" | "success" | "error" = "info",
) {
	const el = elements.status();
	if (el) {
		el.className = `status ${type}`;
		el.textContent = message;
	}
}

function renderMetrics() {
	// Update DOM elements with current video metrics
	const encodedEl = elements.encodedFrames();
	const decodedEl = elements.decodedFrames();
	const encodeQueueEl = elements.encodeQueue();
	const decodeQueueEl = elements.decodeQueue();

	if (encodedEl) encodedEl.textContent = metrics.encodedFrames.toString();
	if (decodedEl) decodedEl.textContent = metrics.decodedFrames.toString();
	if (encodeQueueEl) {
		encodeQueueEl.textContent = metrics.encodeQueueSize.toString();
	}
	if (decodeQueueEl) {
		decodeQueueEl.textContent = metrics.decodeQueueSize.toString();
	}

	// Update DOM elements with current audio metrics
	const audioEncodedEl = elements.audioEncodedFrames();
	const audioDecodedEl = elements.audioDecodedFrames();
	const audioEncodeQueueEl = elements.audioEncodeQueue();
	const audioDecodeQueueEl = elements.audioDecodeQueue();

	if (audioEncodedEl) {
		audioEncodedEl.textContent = metrics.audioEncodedFrames.toString();
	}
	if (audioDecodedEl) {
		audioDecodedEl.textContent = metrics.audioDecodedFrames.toString();
	}
	if (audioEncodeQueueEl) {
		audioEncodeQueueEl.textContent = metrics.audioEncodeQueueSize.toString();
	}
	if (audioDecodeQueueEl) {
		audioDecodeQueueEl.textContent = metrics.audioDecodeQueueSize.toString();
	}
}

function updateButtons(running: boolean) {
	const startCameraBtn = elements.startCameraBtn();
	const startScreenBtn = elements.startScreenBtn();
	const stopBtn = elements.stopBtn();

	if (startCameraBtn) startCameraBtn.disabled = running;
	if (startScreenBtn) startScreenBtn.disabled = running;
	if (stopBtn) stopBtn.disabled = !running;
}

// ============================================================================
// Metrics Collection (runs in main loop)
// ============================================================================

function collectMetrics() {
	// Video metrics
	if (pipeline.encodeNode) {
		try {
			metrics.encodeQueueSize = pipeline.encodeNode.encodeQueueSize;
		} catch (_e) {
			metrics.encodeQueueSize = 0;
		}
	}

	if (pipeline.decodeNode) {
		try {
			metrics.decodeQueueSize = pipeline.decodeNode.decodeQueueSize;
		} catch (_e) {
			metrics.decodeQueueSize = 0;
		}
	}

	// Audio metrics
	if (pipeline.audioEncodeNode) {
		try {
			metrics.audioEncodeQueueSize = pipeline.audioEncodeNode.encodeQueueSize;
		} catch (_e) {
			metrics.audioEncodeQueueSize = 0;
		}
	}

	if (pipeline.audioDecodeNode) {
		try {
			metrics.audioDecodeQueueSize = pipeline.audioDecodeNode.decodeQueueSize;
		} catch (_e) {
			metrics.audioDecodeQueueSize = 0;
		}
	}

	// Calculate FPS
	if (metrics.startTime > 0) {
		const elapsed = (performance.now() - metrics.startTime) / 1000;
		if (elapsed > 0) {
			metrics.fps = Math.round(metrics.encodedFrames / elapsed);
		}
	}
}

// ============================================================================
// Analysis Loop
// ============================================================================

// let analysisLoopRunning = false;

// Analysis is now handled reactively via onanalysis callback

// ============================================================================
// Metrics Update Strategy
// ============================================================================
// DOM paints can get starved during heavy canvas/video work. To maximize the
// chance of DOM updates being committed, update metrics from the same rAF task
// that draws the video (VideoDestinationNode's render loop).
// ============================================================================

// ============================================================================
// Pipeline Control
// ============================================================================

async function startPipeline(sourceType: "camera" | "screen") {
	if (pipeline.running) {
		console.warn("Pipeline already running");
		return;
	}

	try {
		// Reset metrics
		metrics.encodedFrames = 0;
		metrics.decodedFrames = 0;
		metrics.encodeQueueSize = 0;
		metrics.decodeQueueSize = 0;
		metrics.audioEncodedFrames = 0;
		metrics.audioDecodedFrames = 0;
		metrics.audioEncodeQueueSize = 0;
		metrics.audioDecodeQueueSize = 0;
		metrics.startTime = performance.now();
		metrics.fps = 0;
		renderMetrics();

		const emoji = sourceType === "camera" ? "🎥" : "🖥️";
		const label = sourceType === "camera" ? "camera" : "screen";
		setStatus(`${emoji} Requesting ${label} access...`, "info");

		// Get media stream
		pipeline.stream = await getMediaStream(sourceType);
		const track = pipeline.stream.getVideoTracks()[0];
		if (!track) throw new Error("No video track found");

		setStatus("⚙️ Initializing video pipeline...", "info");

		// Create source context and node
		const sourceContext = new VideoContext({
			frameRate: 30,
			canvas: elements.sourceCanvas(),
		});
		pipeline.sourceNode = new MediaStreamVideoSourceNode(sourceContext, {
			mediaStream: pipeline.stream,
		});

		// Branching architecture:
		// 1. Source → Destination (input display)
		pipeline.sourceNode.connect(sourceContext.destination);

		// 2. Source → Analyser (analysis branch - no latency impact)
		pipeline.analyserNode = new VideoAnalyserNode(sourceContext, {
			analysisInterval: 10, // Analyze every 10th frame (~3fps at 30fps) to reduce CPU load
			smoothingTimeConstant: 0.8, // Smooth values over time
		});
		pipeline.sourceNode.connect(pipeline.analyserNode);

		// Set up reactive analysis callback
		pipeline.analyserNode.onanalysis = (analysis) => {
			try {
				// Update UI with new metrics
				const lumaEl = elements.brightness();
				if (lumaEl) lumaEl.textContent = analysis.lumaAverage.toFixed(2);

				const contrastEl = elements.contrast();
				if (contrastEl) {
					contrastEl.textContent = analysis.lumaVariance.toFixed(2);
				}

				const saturationEl = elements.saturation();
				if (saturationEl) {
					saturationEl.textContent = analysis.chromaVariance.toFixed(2);
				}

				// Update dominant color with frame energy visualization
				const dominantColorEl = elements.dominantColor();
				if (dominantColorEl) {
					const energy = Math.floor(analysis.frameEnergy * 255);
					dominantColorEl.style.backgroundColor = `rgb(${energy}, ${energy}, ${energy})`;
				}

				// Update color bar with motion/activity metrics
				const colorBarEl = elements.colorBar();
				if (colorBarEl) {
					colorBarEl.innerHTML = "";

					// Show 5 metrics as colored blocks
					const metrics = [
						{ value: analysis.motionEnergy, label: "Motion" },
						{ value: analysis.activityLevel, label: "Activity" },
						{ value: analysis.edgeDensity, label: "Edges" },
						{ value: analysis.highFrequencyRatio, label: "HF" },
						{ value: analysis.spatialComplexity, label: "Complex" },
					];

					for (const metric of metrics) {
						const intensity = Math.floor(metric.value * 255);
						const colorDiv = document.createElement("div");
						colorDiv.className = "color-block";
						colorDiv.style.backgroundColor = `rgb(0, ${intensity}, ${255 - intensity})`;
						colorDiv.title = `${metric.label}: ${metric.value.toFixed(2)}`;
						colorBarEl.appendChild(colorDiv);
					}
				}
			} catch (e) {
				console.warn("Analysis callback error:", e);
			}
		};

		// Get encoder configuration
		const encoderConfig = await videoEncoderConfig({
			width: 1280,
			height: 720,
			frameRate: 30,
		});

		// Create encode node
		pipeline.encodeNode = new VideoEncodeNode(sourceContext);
		pipeline.encodeNode.configure(encoderConfig);

		// 3. Source → Encode (processing branch)
		pipeline.sourceNode.connect(pipeline.encodeNode);

		// Create output context and decode node
		pipeline.outputContext = new VideoContext({
			frameRate: 30,
			canvas: elements.outputCanvas(),
		});

		pipeline.decodeNode = new VideoDecodeNode(pipeline.outputContext);
		pipeline.decodeNode.configure({
			codec: encoderConfig.codec,
			codedWidth: encoderConfig.width,
			codedHeight: encoderConfig.height,
		});

		// Overlay as a first-class node: decode -> overlay -> destination
		// (keeps the overlay logic composable/replaceable without mutating the destination from the demo.)
		let lastText = "";
		let lastMeasuredWidth = 0;
		let lastUiUpdateMs = 0;
		const overlayDraw = (
			ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
			canvas: HTMLCanvasElement | OffscreenCanvas,
		): void => {
			// Update DOM + derived metrics from the same rAF task as video rendering.
			// Throttle to keep layout work minimal.
			const now = performance.now();
			if (now - lastUiUpdateMs >= UI_UPDATE_INTERVAL_MS) {
				lastUiUpdateMs = now;
				try {
					collectMetrics();
					renderMetrics();
				} catch (e) {
					if (DEBUG_METRICS) console.warn("[metrics] update error:", e);
				}
			}

			const text = getOverlayText();
			if (!text) return;
			ctx.save();
			ctx.font = "16px monospace";
			ctx.textBaseline = "top";

			// Background pill
			const padding = 8;
			const x = 10;
			const y = 10;
			if (text !== lastText) {
				lastText = text;
				lastMeasuredWidth = Math.ceil(ctx.measureText(text).width);
			}
			const metricsWidth = Math.min(
				canvas.width - 20,
				lastMeasuredWidth + padding * 2,
			);
			const height = 24 + padding;
			ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
			ctx.fillRect(x, y, metricsWidth, height);

			// Text
			ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
			ctx.fillText(text, x + padding, y + padding);
			ctx.restore();
		};

		pipeline.overlayNode = new VideoOverlayNode({ overlay: overlayDraw });
		pipeline.decodeNode.connect(pipeline.overlayNode);
		pipeline.overlayNode.connect(pipeline.outputContext.destination);

		// Wrap destination.process to count decoded frames
		const outputDestinationNode = pipeline.outputContext.destination;
		const originalProcess = outputDestinationNode.process.bind(
			outputDestinationNode,
		);
		outputDestinationNode.process = (frame: VideoFrame) => {
			metrics.decodedFrames++;
			originalProcess(frame);
		};

		// Create stream for encoded chunks
		const { readable, writable } = new TransformStream<EncodedVideoChunk>();

		// Setup encode destination
		const destination: VideoEncodeDestination = {
			output: async (chunk: EncodedVideoChunk, _decoderConfig?: VideoDecoderConfig) => {
				metrics.encodedFrames++;
				const writer = writable.getWriter();
				await writer.write(chunk);
				writer.releaseLock();
				return undefined;
			},
		};

		// Start encoding and decoding
		void pipeline.encodeNode.encodeTo(destination);
		void pipeline.decodeNode.decodeFrom(readable);

		// ==================================================================
		// Audio Pipeline Setup
		// ==================================================================
		setStatus("🔊 Initializing audio pipeline...", "info");

		try {
			// Create audio context
			pipeline.audioContext = new AudioContext();

			// Create audio source node using browser's native Web Audio API
			pipeline.audioSourceNode = new MediaStreamAudioSourceNode(
				pipeline.audioContext,
				{ mediaStream: pipeline.stream },
			);

			// Create audio encode node
			pipeline.audioEncodeNode = new AudioEncodeNode(pipeline.audioContext);

			// Get audio encoder config
			const audioConfig = await audioEncoderConfig({
				sampleRate: pipeline.audioContext.sampleRate,
				channels: 2,
				bitrate: 128000,
			});
			pipeline.audioEncodeNode.configure(audioConfig);

			// Connect audio source to encode node (worklet initialization is handled internally)
			pipeline.audioSourceNode.connect(pipeline.audioEncodeNode);

			// Create audio decode node
			pipeline.audioDecodeNode = new AudioDecodeNode(pipeline.audioContext, {
				latency: 100, // 100ms latency
			});
			pipeline.audioDecodeNode.configure({
				codec: audioConfig.codec,
				sampleRate: audioConfig.sampleRate,
				numberOfChannels: audioConfig.numberOfChannels,
			});

			// Set up decoded frame counter
			pipeline.audioDecodeNode.onoutput = () => {
				metrics.audioDecodedFrames++;
			};

			// Connect decode to speakers (worklet initialization is handled internally)
			pipeline.audioDecodeNode.connect(pipeline.audioContext.destination);

			// Create stream for encoded audio chunks
			const {
				readable: audioReadable,
				writable: audioWritable,
			} = new TransformStream<EncodedAudioChunk>();

			// Setup audio encode destination
			const audioDestination: AudioEncodeDestination = {
				output: async (chunk: EncodedAudioChunk, _decoderConfig?: AudioDecoderConfig) => {
					metrics.audioEncodedFrames++;
					const writer = audioWritable.getWriter();
					await writer.write(chunk);
					writer.releaseLock();
					return undefined;
				},
			};

			// Start audio encoding and decoding
			void pipeline.audioEncodeNode.encodeTo(audioDestination);
			void pipeline.audioDecodeNode.decodeFrom(audioReadable);

			// Note: Native MediaStreamAudioSourceNode starts automatically when connected
		} catch (audioError) {
			console.warn("Audio pipeline setup failed:", audioError);
			// Continue without audio
		}

		// ==================================================================
		// Start Video Pipeline
		// ==================================================================

		// Start source
		await pipeline.sourceNode.start();

		// Mark as running
		pipeline.running = true;

		// Best-effort initial UI update. Ongoing updates are tied to the video render loop.
		collectMetrics();
		renderMetrics();

		setStatus(`✅ Pipeline running! Source: ${track.label}`, "success");
		updateButtons(true);
	} catch (error) {
		handleError(error as Error);
		stopPipeline();
	}
}

function stopPipeline() {
	pipeline.running = false;
	// Final UI update
	collectMetrics();
	renderMetrics();

	// Stop media tracks
	if (pipeline.stream) {
		pipeline.stream.getTracks().forEach((track) => track.stop());
		pipeline.stream = null;
	}

	// Cleanup nodes
	if (pipeline.sourceNode) {
		pipeline.sourceNode.dispose();
		pipeline.sourceNode = null;
	}

	if (pipeline.analyserNode) {
		pipeline.analyserNode.dispose();
		pipeline.analyserNode = null;
	}

	if (pipeline.encodeNode) {
		void pipeline.encodeNode.dispose().catch(() => {});
		pipeline.encodeNode.dispose();
		pipeline.encodeNode = null;
	}

	if (pipeline.decodeNode) {
		void pipeline.decodeNode.dispose().catch(() => {});
		pipeline.decodeNode.dispose();
		pipeline.decodeNode = null;
	}

	if (pipeline.overlayNode) {
		pipeline.overlayNode.dispose();
		pipeline.overlayNode = null;
	}

	if (pipeline.outputContext) {
		void pipeline.outputContext.close();
		pipeline.outputContext = null;
	}

	// Cleanup audio nodes
	if (pipeline.audioSourceNode) {
		pipeline.audioSourceNode.disconnect();
		pipeline.audioSourceNode = null;
	}

	if (pipeline.audioEncodeNode) {
		void pipeline.audioEncodeNode.dispose().catch(() => {});
		pipeline.audioEncodeNode.dispose();
		pipeline.audioEncodeNode = null;
	}

	if (pipeline.audioDecodeNode) {
		void pipeline.audioDecodeNode.close().catch(() => {});
		pipeline.audioDecodeNode.dispose();
		pipeline.audioDecodeNode = null;
	}

	if (pipeline.audioContext) {
		void pipeline.audioContext.close().catch(() => {});
		pipeline.audioContext = null;
	}

	updateButtons(false);
	setStatus("⏹️ Pipeline stopped", "info");
}

// ============================================================================
// Helpers
// ============================================================================

async function getMediaStream(
	sourceType: "camera" | "screen",
): Promise<MediaStream> {
	if (!navigator.mediaDevices) {
		throw new Error("mediaDevices API is not supported");
	}

	if (sourceType === "screen") {
		if (!navigator.mediaDevices.getDisplayMedia) {
			throw new Error("Screen sharing is not supported");
		}
		return navigator.mediaDevices.getDisplayMedia({
			video: {
				width: { ideal: 1920 },
				height: { ideal: 1080 },
				frameRate: { ideal: 30 },
			},
			audio: true,
		});
	}

	// Camera
	if (!navigator.mediaDevices.getUserMedia) {
		throw new Error("Camera access is not supported");
	}

	try {
		return await navigator.mediaDevices.getUserMedia({
			video: {
				width: { ideal: 1280 },
				height: { ideal: 720 },
				frameRate: { ideal: 30 },
			},
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
		});
	} catch {
		// Fallback to basic constraints
		return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
	}
}

function handleError(error: Error) {
	let message = error.message;

	switch (error.name) {
		case "NotFoundError":
			message = "Camera not found. Please connect a camera.";
			break;
		case "NotAllowedError":
		case "PermissionDeniedError":
			message = "Permission denied. Please allow access and reload.";
			break;
		case "NotReadableError":
			message = "Device is in use by another application.";
			break;
	}

	setStatus(`❌ ${message}`, "error");
	console.error("Pipeline error:", error);
}

async function loadCodecConfig() {
	try {
		const config = await videoEncoderConfig({
			width: 1280,
			height: 720,
			frameRate: 30,
		});
		const el = elements.codecConfig();
		if (el) el.textContent = JSON.stringify(config, null, 2);
	} catch (error) {
		const el = elements.codecConfig();
		if (el) el.textContent = `Error: ${(error as Error).message}`;
	}
}

// ============================================================================
// Initialization
// ============================================================================

function init() {
	// Event listeners
	elements.startCameraBtn()?.addEventListener(
		"click",
		() => startPipeline("camera"),
	);
	elements.startScreenBtn()?.addEventListener(
		"click",
		() => startPipeline("screen"),
	);
	elements.stopBtn()?.addEventListener("click", stopPipeline);

	// Load codec config
	loadCodecConfig();

	// Check WebCodecs support
	if (!("VideoEncoder" in window)) {
		setStatus("⚠️ WebCodecs API not supported. Use Chrome/Edge.", "error");
		updateButtons(true); // Disable start buttons
		elements.stopBtn()!.disabled = true;
	}

	// Initial metrics render
	renderMetrics();
}

// Run on load
init();

import type { EncodeDestination } from "../container.ts";
import {
  MediaStreamVideoSourceNode,
  VideoAnalyserNode,
  VideoContext,
  VideoDecodeNode,
  VideoEncodeNode,
  VideoOverlayNode,
} from "../mod.ts";
import { videoEncoderConfig } from "../video_config.ts";

// ============================================================================
// Types
// ============================================================================

interface PipelineState {
  sourceNode: MediaStreamVideoSourceNode | null;
  analyserNode: VideoAnalyserNode | null;
  encodeNode: VideoEncodeNode | null;
  decodeNode: VideoDecodeNode | null;
  overlayNode: VideoOverlayNode | null;
  outputContext: VideoContext | null;
  stream: MediaStream | null;
  running: boolean;
}

interface Metrics {
  encodedFrames: number;
  decodedFrames: number;
  encodeQueueSize: number;
  decodeQueueSize: number;
  startTime: number;
  fps: number;
}

// ============================================================================
// State
// ============================================================================

const pipeline: PipelineState = {
  sourceNode: null,
  analyserNode: null,
  encodeNode: null,
  decodeNode: null,
  overlayNode: null,
  outputContext: null,
  stream: null,
  running: false,
};

const metrics: Metrics = {
  encodedFrames: 0,
  decodedFrames: 0,
  encodeQueueSize: 0,
  decodeQueueSize: 0,
  startTime: 0,
  fps: 0,
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
  encodedFrames: () => document.getElementById("encodedFrames"),
  decodedFrames: () => document.getElementById("decodedFrames"),
  encodeQueue: () => document.getElementById("encodeQueue"),
  decodeQueue: () => document.getElementById("decodeQueue"),
  codecConfig: () => document.getElementById("codecConfig"),
  sourceCanvas: () =>
    document.getElementById("sourceCanvas") as HTMLCanvasElement,
  outputCanvas: () =>
    document.getElementById("outputCanvas") as HTMLCanvasElement,
  brightness: () => document.getElementById("brightness"),
  contrast: () => document.getElementById("contrast"),
  saturation: () => document.getElementById("saturation"),
  dominantColor: () => document.getElementById("dominantColor"),
  colorBar: () => document.getElementById("colorBar"),
  startCameraBtn: () =>
    document.getElementById("startCameraBtn") as HTMLButtonElement,
  startScreenBtn: () =>
    document.getElementById("startScreenBtn") as HTMLButtonElement,
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
  // Update DOM elements with current metrics
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

let analysisLoopRunning = false;

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
    pipeline.sourceNode = new MediaStreamVideoSourceNode(track, sourceContext);

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
        if (contrastEl) contrastEl.textContent = analysis.lumaVariance.toFixed(2);

        const saturationEl = elements.saturation();
        if (saturationEl) saturationEl.textContent = analysis.chromaVariance.toFixed(2);

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
            { value: analysis.motionEnergy, label: 'Motion' },
            { value: analysis.activityLevel, label: 'Activity' },
            { value: analysis.edgeDensity, label: 'Edges' },
            { value: analysis.highFrequencyRatio, label: 'HF' },
            { value: analysis.spatialComplexity, label: 'Complex' }
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
    const destination: EncodeDestination = {
      output: async (chunk: EncodedVideoChunk) => {
        metrics.encodedFrames++;
        const writer = writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
      },
      done: new Promise(() => {}), // Never resolves
    };

    // Start encoding and decoding
    void pipeline.encodeNode.encodeTo(destination);
    void pipeline.decodeNode.decodeFrom(readable);

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
    void pipeline.encodeNode.close().catch(() => {});
    pipeline.encodeNode.dispose();
    pipeline.encodeNode = null;
  }

  if (pipeline.decodeNode) {
    void pipeline.decodeNode.close().catch(() => {});
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
    });
  } catch {
    // Fallback to basic constraints
    return navigator.mediaDevices.getUserMedia({ video: true });
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

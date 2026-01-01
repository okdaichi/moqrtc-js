# @okudai/video-nodes

WebCodecs-based video processing library with a node-graph architecture inspired by Web Audio API.

## Features

- 🎥 **Video Node Graph**: Connect video sources, encoders, decoders, and destinations
- 🔧 **Hardware Acceleration**: Leverage WebCodecs for efficient video encoding/decoding
- 📊 **Video Analysis**: Real-time content metrics (10 normalized metrics: luma, chroma, motion, edges, complexity)
- 🎬 **Flexible Pipeline**: Build custom video processing pipelines
- 🖼️ **Multiple Render Modes**: Contain, cover, fill, scale-down
- 🎯 **Type-Safe**: Full TypeScript support

## Installation

```bash
deno add @okudai/video-nodes
```

## Quick Start

### Simple Camera Preview

```typescript
import { MediaStreamVideoSourceNode } from "@okudai/video-nodes";

const stream = await navigator.mediaDevices.getUserMedia({ video: true });
const track = stream.getVideoTracks()[0];

const source = new MediaStreamVideoSourceNode(track);
await source.start();
```

### Encode → Decode Pipeline

```typescript
import { MediaStreamVideoSourceNode, VideoContext, VideoDecodeNode, VideoEncodeNode } from "@okudai/video-nodes";
import { videoEncoderConfig } from "@okudai/video-nodes/config";

// Source
const stream = await navigator.mediaDevices.getUserMedia({ video: true });
const source = new MediaStreamVideoSourceNode(stream.getVideoTracks()[0]);

// Encoder
const encoder = new VideoEncodeNode(source.context);
const config = await videoEncoderConfig({
	width: 1280,
	height: 720,
	frameRate: 30,
});
encoder.configure(config);
source.connect(encoder);

// Decoder
const outputContext = new VideoContext();
const decoder = new VideoDecodeNode(outputContext);
decoder.configure({
	codec: config.codec,
	codedWidth: config.width,
	codedHeight: config.height,
});
decoder.connect(outputContext.destination);

// Stream encoded data to decoder
const { readable, writable } = new TransformStream<EncodedVideoChunk>();
encoder.encodeTo({
	output: async (chunk) => {
		const writer = writable.getWriter();
		await writer.write(chunk);
		writer.releaseLock();
	},
	done: new Promise(() => {}),
});

decoder.decodeFrom(readable);
await source.start();
```

## Demo

See the live demo:

```bash
cd demo
deno task dev
```

Open http://localhost:5173 to see:

- Real-time camera encode/decode pipeline
- Video analysis metrics with live visualization
- Performance monitoring
- Codec configuration

## API

### Core Classes

#### `VideoContext`

Main processing context (like AudioContext).

```typescript
const context = new VideoContext({ frameRate: 30 });
```

#### `MediaStreamVideoSourceNode`

Create video source from MediaStreamTrack.

```typescript
const source = new MediaStreamVideoSourceNode(track);
await source.start();
```

#### `VideoEncodeNode`

Encode video frames using WebCodecs.

```typescript
const encoder = new VideoEncodeNode(context);
encoder.configure(await getVideoConfig());
```

#### `VideoDecodeNode`

Decode video chunks.

```typescript
const decoder = new VideoDecodeNode(context);
decoder.configure(decoderConfig);
```

#### `VideoDestinationNode`

Render to canvas.

```typescript
context.destination.canvas = myCanvas;
context.destination.renderFunction = VideoRenderFunctions.cover;
```

#### `VideoAnalyserNode`

Analyze video content in real-time with AudioAnalyserNode-compatible API.

```typescript
const analyser = new VideoAnalyserNode(context, {
	analysisInterval: 10, // Analyze every 10th frame
	smoothingTimeConstant: 0.8, // Smooth values over time
	historySize: 256, // Number of frames to keep in history
});
source.connect(analyser);

// Reactive callback approach
analyser.onanalysis = (analysis) => {
	console.log("Brightness:", analysis.lumaAverage);
	console.log("Motion:", analysis.motionEnergy);
	console.log("Complexity:", analysis.spatialComplexity);
};

// Polling approach
const current = analyser.getFrameAnalysis();
const history = analyser.getAnalysisHistory();
const recent = analyser.getRecentAnalysis(30); // Last 30 frames
const average = analyser.getAverageValue("motionEnergy");
const peak = analyser.getPeakValue("edgeDensity");
```

**Available Metrics** (all normalized 0.0–1.0):

- **Intra-Frame**: `lumaAverage`, `lumaVariance`, `chromaVariance`, `frameEnergy`
- **Inter-Frame**: `frameDelta`, `motionEnergy`, `activityLevel`
- **Information Density**: `edgeDensity`, `highFrequencyRatio`, `spatialComplexity`

### Utilities

#### `videoEncoderConfig()`

Get optimal encoder configuration for current browser.

```typescript
import { videoEncoderConfig } from "@okudai/video-nodes/config";
const config = await videoEncoderConfig({
	width: 1280,
	height: 720,
	frameRate: 30,
});
// { codec: "vp09.00.10.08", width: 1280, height: 720, ... }
```

#### `VideoRenderFunctions`

Pre-defined render modes: `contain`, `cover`, `fill`, `scaleDown`.

## Browser Compatibility

| Browser      | WebCodecs | Status                         |
| ------------ | --------- | ------------------------------ |
| Chrome 94+   | ✅        | Full support                   |
| Edge 94+     | ✅        | Full support                   |
| Firefox 130+ | ⚠️        | Partial (workarounds included) |
| Safari 17+   | ⚠️        | Limited                        |

## Architecture

Based on Web Audio API's node graph pattern:

```
Source → [Analyser] → [Encoder] → [Decoder] → Destination
   ↓         ↓                                    ↓
 Camera   Analysis                             Canvas
```

Each node can be connected to multiple outputs, creating flexible processing pipelines.

## License

MIT

## Links

- [JSR Package](https://jsr.io/@okudai/video-nodes)
- [GitHub](https://github.com/okdaichi/moqrtc-js)
- [WebCodecs API Docs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)

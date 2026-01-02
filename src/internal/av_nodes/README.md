# @okdaichi/video-nodes

WebCodecs-based video and audio processing nodes with MoQ Transport support.

## Features

- 🎥 **Video Processing**: WebCodecs-based encoding/decoding with hardware acceleration
- 🎵 **Audio Processing**: AudioWorklet-based capture and playback
- 🔄 **Media Streaming**: Real-time media transport over MoQ
- 📦 **Zero Dependencies**: Self-contained worklet code (no external JS files)
- 🚀 **High Performance**: Hardware-accelerated encoding/decoding

## Installation

```bash
# From JSR
deno add @okdaichi/video-nodes

# Or import directly
import { VideoEncodeNode, AudioEncodeNode } from "jsr:@okdaichi/video-nodes";
```

## Quick Start

```typescript
import {
	VideoContext,
	MediaStreamVideoSourceNode,
	VideoEncodeNode,
	AudioEncodeNode,
} from "jsr:@okdaichi/video-nodes";

// Create video context
const videoContext = new VideoContext({ fps: 30 });

// Get media stream
const stream = await navigator.mediaDevices.getUserMedia({
	video: true,
	audio: true,
});

// Setup video pipeline
const videoTrack = stream.getVideoTracks()[0];
const sourceNode = new MediaStreamVideoSourceNode(videoContext, videoTrack);
const encodeNode = new VideoEncodeNode(videoContext);

encodeNode.configure({
	codec: "avc1.42001f",
	width: 1280,
	height: 720,
	bitrate: 2_000_000,
});

sourceNode.connect(encodeNode);
sourceNode.start();
await videoContext.start();

// Setup audio pipeline
const audioContext = new AudioContext();
const audioSource = audioContext.createMediaStreamSource(stream);
const audioEncodeNode = new AudioEncodeNode(audioContext);

audioEncodeNode.configure({
	codec: "opus",
	sampleRate: 48000,
	numberOfChannels: 2,
	bitrate: 128000,
});

audioSource.connect(audioEncodeNode);
```

## API Documentation

### Video Nodes

- `VideoContext` - Manages video processing context and frame timing
- `VideoSourceNode` - Base video source node
- `MediaStreamVideoSourceNode` - Capture video from MediaStreamTrack
- `VideoEncodeNode` - Encode video frames using WebCodecs
- `VideoDecodeNode` - Decode encoded video chunks

### Audio Nodes

- `AudioEncodeNode` - Capture and encode audio using AudioWorklet + WebCodecs
- `AudioDecodeNode` - Decode and play audio using AudioWorklet + WebCodecs

## Development

### Build

```bash
# Build AudioWorklet inline code
deno task build:worklets

# Type check
deno task check

# Run tests
deno task test
```

### Publish

The package automatically builds worklets before publishing:

```bash
deno publish
```

The `prepublish` task ensures `*_inline.ts` files are up-to-date.

## Architecture

The package uses inline AudioWorklet code for better distribution:

- No external `.js` files required
- Works in all environments (browser, Deno, Node.js)
- Easy to bundle with other build tools
- Uses Blob URLs at runtime

See [audio/WORKLET_BUILD.md](./audio/WORKLET_BUILD.md) for details.

## License

MIT © okdaichi

## Related

- [@okudai/moq](https://jsr.io/@okudai/moq) - MoQ Transport implementation
- [moqrtc-js](https://github.com/okdaichi/moqrtc-js) - Complete MoQ-RTC implementation

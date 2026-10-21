// Audio module exports
export * from "./audio_config.ts";
export * from "./decode_node.ts";
export * from "./encode_node.ts";
export * from "./voice_activity_node.ts";
export type { VoiceDetectorOptions } from "./voice_detector.ts";

// Inline worklet modules (recommended for library usage)
export {
	CaptureCode,
	createWorkletBlobUrl as createCaptureWorkletBlobUrl,
} from "./capture_worklet_inline.ts";

export {
	createWorkletBlobUrl as createPlayoutWorkletBlobUrl,
	PlayoutCode,
} from "./playout_worklet_inline.ts";

export {
	createWorkletBlobUrl as createVoiceActivityWorkletBlobUrl,
	VoiceActivityCode,
} from "./voice_activity_worklet_inline.ts";

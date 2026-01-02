// Audio module exports
export * from "./audio_config.ts";
export * from "./decode_node.ts";
export * from "./encode_node.ts";

// Inline worklet modules (recommended for library usage)
export {
	audioHijackWorkletCode,
	createWorkletBlobUrl as createHijackWorkletBlobUrl
} from "./audio_hijack_worklet_inline.ts";

export {
	audioOffloadWorkletCode,
	createWorkletBlobUrl as createOffloadWorkletBlobUrl
} from "./audio_offload_worklet_inline.ts";


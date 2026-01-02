// Audio module exports
export * from "./audio_config.ts";
export * from "./decode_node.ts";
export * from "./encode_node.ts";

// Inline worklet modules (recommended for library usage)
export {
	createWorkletBlobUrl as createHijackWorkletBlobUrl,
	HijackCode,
} from "./audio_hijack_worklet_inline.ts";

export {
	createWorkletBlobUrl as createOffloadWorkletBlobUrl,
	OffloadCode,
} from "./audio_offload_worklet_inline.ts";

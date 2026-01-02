// Audio module exports
export * from "./audio_config.ts";
export * from "./decode_node.ts";
export * from "./encode_node.ts";

// Inline worklet modules (recommended for library usage)
export {
	HijackCode,
	createWorkletBlobUrl as createHijackWorkletBlobUrl,
} from "./audio_hijack_worklet_inline.ts";

export {
	OffloadCode,
	createWorkletBlobUrl as createOffloadWorkletBlobUrl,
} from "./audio_offload_worklet_inline.ts";


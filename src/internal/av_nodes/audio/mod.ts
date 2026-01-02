// Audio module exports
export * from "./audio_config.ts";
export * from "./decode_node.ts";
export * from "./encode_node.ts";

// Worklet modules with explicit exports to avoid naming conflicts
export {
	importWorkletUrl as importHijackWorkletUrl,
	workletName as hijackWorkletName,
} from "./audio_hijack_worklet.ts";

export {
	importWorkletUrl as importOffloadWorkletUrl,
	workletName as offloadWorkletName,
} from "./audio_offload_worklet.ts";

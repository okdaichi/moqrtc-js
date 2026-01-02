// Audio module exports
export * from "./audio_config.ts";
export * from "./encode_node.ts";

// Worklet modules with explicit exports to avoid naming conflicts
export {
	workletName as hijackWorkletName, importWorkletUrl as importHijackWorkletUrl
} from "./audio_hijack_worklet.ts";

export {
	importWorkletUrl as importOffloadWorkletUrl,
	workletName as offloadWorkletName
} from "./audio_offload_worklet.ts";

// Test utilities and mocks
export * from "./mock_audiodata_test.ts";
export * from "./mock_audioencoder_test.ts";
export * from "./mock_encodedaudiochunk_test.ts";


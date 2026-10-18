// What the nodes and their worklet processors share: the processors' names and
// the message every node posts to its processor on dispose.

// The processors' names are generated from the package version in deno.json by
// scripts/build_worklets.ts into audio_worklet_names.ts, so copies of av-nodes
// of different versions can share a scope, each registering and using its own
// processors.
export { HIJACK_PROCESSOR_NAME, OFFLOAD_PROCESSOR_NAME } from "./audio_worklet_names.ts";

/** Tells a processor to stop: it renders nothing more and closes its port. */
export interface StopMessage {
	readonly type: "stop";
}

/** Whether `value` is a {@link StopMessage}. */
export function isStopMessage(value: unknown): value is StopMessage {
	return typeof value === "object" && value !== null && "type" in value &&
		value.type === "stop";
}

// What the nodes and their worklet processors share: the processors' names and
// the message every node posts to its processor on dispose.

// The version of the processors and their messages. It is part of each
// processor's name, so copies of av-nodes that differ in it can share a scope,
// each registering and using its own processors. Raise it with any change to a
// processor or its messages.
const WORKLET_PROTOCOL_VERSION = 2;

/** Name the playback processor is registered under. */
export const OFFLOAD_PROCESSOR_NAME = `audio-offloader-v${WORKLET_PROTOCOL_VERSION}`;

/** Name the capture processor is registered under. */
export const HIJACK_PROCESSOR_NAME = `audio-hijacker-v${WORKLET_PROTOCOL_VERSION}`;

/** Tells a processor to stop: it renders nothing more and closes its port. */
export interface StopMessage {
	readonly type: "stop";
}

/** Whether `value` is a {@link StopMessage}. */
export function isStopMessage(value: unknown): value is StopMessage {
	return typeof value === "object" && value !== null && "type" in value &&
		value.type === "stop";
}

// The message every node posts to its worklet processor on dispose.

/** Tells a processor to stop: it renders nothing more and closes its port. */
export interface StopMessage {
	readonly type: "stop";
}

/** Whether `value` is a {@link StopMessage}. */
export function isStopMessage(value: unknown): value is StopMessage {
	return typeof value === "object" && value !== null && "type" in value &&
		value.type === "stop";
}

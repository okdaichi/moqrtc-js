// Messages between VoiceActivityNode and its worklet.
import type { StopMessage } from "./audio_worklet_protocol.ts";
import { isStopMessage } from "./audio_worklet_protocol.ts";

/** How long each measured level covers (ms) when the node gives no window. */
export const DEFAULT_VOICE_WINDOW_MS = 20;

/** Messages the node posts to the voice activity worklet. */
export type VoiceActivityControlMessage = StopMessage;

/** Whether `value` is a well-formed message for the voice activity worklet. */
export function isVoiceActivityControlMessage(
	value: unknown,
): value is VoiceActivityControlMessage {
	return isStopMessage(value);
}

/**
 * The voice started or stopped being heard, at `time`: milliseconds of input
 * the processor had measured by then.
 */
export interface SpeakingMessage {
	readonly type: "speaking";
	readonly speaking: boolean;
	readonly time: number;
}

/** Whether `value` is a well-formed message from the voice activity worklet. */
export function isSpeakingMessage(value: unknown): value is SpeakingMessage {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return v.type === "speaking" && typeof v.speaking === "boolean" &&
		typeof v.time === "number" && Number.isFinite(v.time);
}

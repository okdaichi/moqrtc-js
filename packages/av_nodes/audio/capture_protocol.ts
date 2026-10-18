// Messages between AudioEncodeNode and its capture worklet.
import type { StopMessage } from "./audio_worklet_protocol.ts";

/** Duration of a captured frame when the encoder config gives none (µs). */
export const DEFAULT_FRAME_DURATION_US = 20_000;

/** What the node wants captured: the channels and the length (frames) of each frame. */
export interface FormatMessage {
	readonly type: "format";
	readonly channels: number;
	readonly frameLength: number;
}

/** Messages the node posts to the capture worklet. */
export type AudioCaptureMessage = FormatMessage | StopMessage;

/**
 * A captured frame: `numberOfChannels` planes of `numberOfFrames` samples in
 * `data`, the first of them captured at `timestamp` (µs) by the context's clock.
 */
export interface FrameMessage {
	readonly type: "frame";
	readonly data: Float32Array<ArrayBuffer>;
	readonly numberOfChannels: number;
	readonly numberOfFrames: number;
	readonly sampleRate: number;
	readonly timestamp: number;
}

/** The capture input stopped. */
export interface InputEndedMessage {
	readonly type: "inputEnded";
}

/** Messages the capture worklet posts to the node. */
export type CaptureMessage = FrameMessage | InputEndedMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

// Samples in a buffer of their own kind that can be handed over.
function isSamples(value: unknown): value is Float32Array<ArrayBuffer> {
	return value instanceof Float32Array && value.buffer instanceof ArrayBuffer;
}

/** Whether `value` is a whole number above zero. */
export function isCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

/** Whether `value` is a well-formed message for the capture worklet. */
export function isAudioCaptureMessage(value: unknown): value is AudioCaptureMessage {
	if (!isRecord(value)) return false;
	switch (value.type) {
		case "format":
			return isCount(value.channels) && isCount(value.frameLength);
		case "stop":
			return true;
		default:
			return false;
	}
}

/** Whether `value` is a well-formed message from the capture worklet. */
export function isCaptureMessage(value: unknown): value is CaptureMessage {
	if (!isRecord(value)) return false;
	switch (value.type) {
		case "frame":
			return isSamples(value.data) && isCount(value.numberOfChannels) &&
				isCount(value.numberOfFrames) &&
				value.data.length === value.numberOfChannels * value.numberOfFrames &&
				typeof value.sampleRate === "number" && Number.isFinite(value.sampleRate) &&
				value.sampleRate > 0 &&
				typeof value.timestamp === "number" && Number.isFinite(value.timestamp);
		case "inputEnded":
			return true;
		default:
			return false;
	}
}

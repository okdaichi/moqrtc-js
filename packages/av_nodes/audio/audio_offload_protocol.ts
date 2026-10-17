// Messages between AudioDecodeNode and its playback worklet.
import type { AudioPlayoutStats } from "./audio_playback_stats.ts";
import type { StopMessage } from "./audio_worklet_protocol.ts";

/** Starting and minimum playout delay when none is given (ms). */
export const DEFAULT_LATENCY_MS = 100;

/** Maximum playout delay when none is given (ms). */
export const DEFAULT_MAX_LATENCY_MS = 400;

/** A decoded block for the worklet to play at its timestamp (µs). */
export interface AppendMessage {
	readonly type: "append";
	readonly channels: readonly Float32Array[];
	readonly timestamp: number;
}

/** A request for a stats snapshot, answered with a {@link StatsReply} of the same id. */
export interface StatsRequest {
	readonly type: "stats";
	readonly id: number;
}

/** Messages the node posts to the worklet. */
export type AudioOffloadMessage = AppendMessage | StatsRequest | StopMessage;

/** The worklet's answer to a {@link StatsRequest}. */
export interface StatsReply {
	readonly type: "stats";
	readonly id: number;
	readonly stats: AudioPlayoutStats;
}

// Every stats field, so a snapshot can be checked field by field. The mapped
// type makes the compiler reject a missing or unknown field.
const STATS_FIELDS: { readonly [K in keyof AudioPlayoutStats]: true } = {
	targetDelayMs: true,
	delayMs: true,
	bufferLevelMs: true,
	receivedBlocks: true,
	lateBlocks: true,
	droppedBlocks: true,
	underruns: true,
	expands: true,
	expandedMs: true,
	accelerates: true,
	acceleratedMs: true,
	resyncs: true,
	reanchors: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFloat32ArrayList(value: unknown): value is readonly Float32Array[] {
	return Array.isArray(value) && value.every((channel) => channel instanceof Float32Array);
}

/** Whether `value` is a well-formed message for the worklet. */
export function isAudioOffloadMessage(value: unknown): value is AudioOffloadMessage {
	if (!isRecord(value)) return false;
	switch (value.type) {
		case "append":
			return isFloat32ArrayList(value.channels) &&
				typeof value.timestamp === "number" && Number.isFinite(value.timestamp);
		case "stats":
			return Number.isSafeInteger(value.id);
		case "stop":
			return true;
		default:
			return false;
	}
}

/** Whether `value` is a well-formed stats snapshot. */
export function isAudioPlayoutStats(value: unknown): value is AudioPlayoutStats {
	if (!isRecord(value)) return false;
	return Object.keys(STATS_FIELDS).every((field) => {
		const n = value[field];
		return typeof n === "number" && Number.isFinite(n);
	});
}

/** Whether `value` is a well-formed reply to a stats request. */
export function isStatsReply(value: unknown): value is StatsReply {
	return isRecord(value) && value.type === "stats" && Number.isSafeInteger(value.id) &&
		isAudioPlayoutStats(value.stats);
}

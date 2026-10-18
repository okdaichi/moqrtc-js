/**
 * The playout buffer's part of {@link AudioPlaybackStats}, as the playback
 * worklet reports it. Delays are the cushion over the fastest recent arrival,
 * in ms.
 */
export interface AudioPlayoutStats {
	/** Delay the arrival statistics ask for. */
	readonly targetDelayMs: number;
	/** Delay applied now; it follows the target in steps. */
	readonly delayMs: number;
	/** Audio written ahead of the playback position. */
	readonly bufferLevelMs: number;
	/** Decoded blocks received. */
	readonly receivedBlocks: number;
	/** Blocks that arrived after their playout time and played after raising the delay. */
	readonly lateBlocks: number;
	/** Blocks that arrived too late to play and were dropped. */
	readonly droppedBlocks: number;
	/** Times playback ran out of audio and faded to silence. */
	readonly underruns: number;
	/**
	 * Times the delay was raised other than for a late block: concealment of
	 * audio that had not arrived when the buffer ran low, a repeated pitch
	 * period, or a widened silence gap.
	 */
	readonly expands: number;
	/** Total length of the audio concealed, repeated or inserted as silence to raise the delay. */
	readonly expandedMs: number;
	/** Steps that lowered the delay: a removed pitch period, or a cut of silence or quiet audio. */
	readonly accelerates: number;
	/** Total length of the audio removed to lower the delay. */
	readonly acceleratedMs: number;
	/** Jumps to the live edge after the stream ran far ahead of playback. */
	readonly resyncs: number;
	/** Restarts from a stream that fell too far behind. */
	readonly reanchors: number;
}

/** Snapshot of an `AudioDecodeNode`'s playback. */
export interface AudioPlaybackStats extends AudioPlayoutStats {
	/**
	 * Encoded chunks `decodeFrom()` dropped because the audio context was not
	 * running (not yet resumed, suspended or interrupted).
	 */
	readonly droppedWhileSuspended: number;
}

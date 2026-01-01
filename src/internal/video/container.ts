// Container types for video encoding/decoding

/**
 * Destination for encoded video chunks.
 * Implement this interface to handle encoded output from VideoEncodeNode.
 */
export interface EncodeDestination {
	/**
	 * Called when an encoded chunk is produced.
	 * @param chunk - The encoded video chunk
	 */
	output(chunk: EncodedVideoChunk): Promise<void>;

	/**
	 * Promise that resolves when encoding destination is done.
	 */
	done: Promise<void>;
}

/**
 * Union type for encoded media chunks.
 */
export type EncodedChunk = EncodedVideoChunk | EncodedAudioChunk;

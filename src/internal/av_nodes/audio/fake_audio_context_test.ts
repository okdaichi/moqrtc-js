/**
 * FakeAudioContext for Deno test environments.
 *
 * Implements the minimal API required by AudioEncodeNode.
 */
export class FakeAudioContext {
	sampleRate = 44100;
	currentTime = 0;
	destination = {
		channelCount: 2,
	};
	audioWorklet = {
		addModule: async (_moduleUrl: string): Promise<void> => {
			// No-op for test environments.
		},
	};
}

/// <reference path="../../../src/test_globals.d.ts" />
import { isStopMessage } from "./audio_worklet_protocol.ts";

// URL getter function for main thread import
export function importWorkletUrl(): string {
	return new URL("./audio_hijack_worklet.js", import.meta.url).href;
}

export const workletName: string = "audio-hijacker";

// Check if we're in a worklet context
if (typeof AudioWorkletProcessor !== "undefined") {
	// Worklet code
	class AudioHijackProcessor extends AudioWorkletProcessor {
		#sampleRate: number;
		// Whether the last render quantum had input.
		#capturing = false;
		#targetChannels: number;
		// Set by a stop message: process() then returns false, so the
		// processor can be collected.
		#stopped = false;

		constructor(options: AudioWorkletNodeOptions) {
			super();
			// Get sampleRate from processorOptions or fall back to global sampleRate
			this.#sampleRate = options.processorOptions?.sampleRate ||
				globalThis.sampleRate;
			// Get target number of channels from processorOptions
			this.#targetChannels = options.processorOptions?.targetChannels || 1;
			// The node changes the channel count when its encoder is configured.
			this.port.onmessage = ({ data }: MessageEvent) => {
				if (isStopMessage(data)) {
					this.#stopped = true;
					this.port.close();
					return;
				}
				const channels = data?.targetChannels;
				if (Number.isInteger(channels) && channels > 0) {
					this.#targetChannels = channels;
				}
			};
		}

		process(inputs: Float32Array[][]) {
			if (this.#stopped) return false;
			if (inputs.length > 1) throw new Error("only one input is supported.");

			// Just take one input channel, the first one.
			// MOQ enables the delivery of audio inputs individually for each track.
			// So do not mix audio from different tracks or different devices.
			const channels = inputs[0];

			if (!channels || channels.length === 0 || !channels[0]) {
				// The input stopped (its source was disconnected): say so once, so
				// the node can release the audio its encoder still holds.
				if (this.#capturing) {
					this.#capturing = false;
					this.port.postMessage({ inputEnded: true });
				}
				return true;
			}
			this.#capturing = true;

			const inputChannels = channels.length;
			const numberOfFrames = channels[0].length;

			// Use target channels from configuration, not input channels
			const numberOfChannels = this.#targetChannels;
			const data = new Float32Array(numberOfChannels * numberOfFrames);

			for (let i = 0; i < numberOfChannels; i++) {
				if (i < inputChannels) {
					const inputChannel = channels[i];
					if (inputChannel && inputChannel.length > 0) {
						// Use input channel data
						data.set(inputChannel, i * numberOfFrames);
					} else {
						// Fill with silence if input channel is empty
						data.fill(0, i * numberOfFrames, (i + 1) * numberOfFrames);
					}
				} else if (inputChannels > 0) {
					const firstChannel = channels[0];
					if (firstChannel && firstChannel.length > 0) {
						// If we need more channels than input provides, duplicate the first channel
						data.set(firstChannel, i * numberOfFrames);
					} else {
						// Fill with silence if first channel is empty
						data.fill(0, i * numberOfFrames, (i + 1) * numberOfFrames);
					}
				} else {
					// Fill with silence if no input data
					data.fill(0, i * numberOfFrames, (i + 1) * numberOfFrames);
				}
			}

			const init: AudioDataInit = {
				format: "f32-planar",
				sampleRate: this.#sampleRate,
				numberOfChannels: numberOfChannels,
				numberOfFrames: numberOfFrames,
				data: data,
				// Stamped by the audio context's clock, not by counting captured
				// frames: a stretch with no input (a disconnected source) shows as
				// a gap in the timestamps, so a player keeps later audio in place.
				timestamp: Math.round(currentFrame * 1_000_000 / sampleRate),
				transfer: [data.buffer],
			};

			this.port.postMessage(init);

			return true;
		}
	}

	try {
		registerProcessor(workletName, AudioHijackProcessor);
	} catch (e) {
		// reason: the module was evaluated again in this scope (another copy of
		// the library loaded it); the processor registered first stays in use.
		if (!(e instanceof DOMException && e.name === "NotSupportedError")) throw e;
	}
}

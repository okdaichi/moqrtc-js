/// <reference path="../../../src/test_globals.d.ts" />
import {
	DEFAULT_FRAME_DURATION_US,
	type FrameMessage,
	type InputEndedMessage,
	isAudioHijackMessage,
	isCount,
} from "./audio_hijack_protocol.ts";
import { HIJACK_PROCESSOR_NAME } from "./audio_worklet_names.ts";

// URL getter function for main thread import
export function importWorkletUrl(): string {
	return new URL("./audio_hijack_worklet.js", import.meta.url).href;
}

const INPUT_ENDED: InputEndedMessage = { type: "inputEnded" };

// Check if we're in a worklet context
if (typeof AudioWorkletProcessor !== "undefined") {
	// Captures the input in frames of a codec frame's length (960 frames, 20 ms
	// at 48 kHz, unless the node says otherwise) and posts each to the node. A
	// render quantum is only 128 frames: one encode() call per quantum, 375 a
	// second, leaves the encoder queue no room for the main thread's jitter.
	//
	// Each frame's samples gather in a buffer allocated for that frame and
	// handed over with the message, without a copy: one allocation per frame,
	// 50 a second. A pool of buffers returned by the node would not save it,
	// as the node hands each buffer on to its AudioData in turn.
	//
	// A frame is stamped with its first sample's frame on the context's clock,
	// so consecutive frames have continuous timestamps, and a stretch with no
	// input (a disconnected source) shows as a gap in them. A frame cut short,
	// by the input ending, a jump in the clock or a new format, is posted as it
	// is, so no captured audio is lost.
	class AudioHijackProcessor extends AudioWorkletProcessor {
		readonly #sampleRate: number;
		#channels: number;
		#frameLength: number;
		// The frame being filled: #channels planes of #frameLength samples, of
		// which the first #filled are captured.
		#buffer: Float32Array<ArrayBuffer>;
		#filled = 0;
		// Clock frame of the frame's first sample, and the one the next render
		// quantum starts at if the clock runs on.
		#frameStart = 0;
		#nextFrame = 0;
		// Whether the last render quantum had input.
		#capturing = false;
		// Set by a stop message: process() then returns false, so the
		// processor can be collected.
		#stopped = false;

		constructor(options: AudioWorkletNodeOptions) {
			super();
			const rate: unknown = options.processorOptions?.sampleRate;
			this.#sampleRate = typeof rate === "number" && rate > 0 ? rate : globalThis.sampleRate;
			const channels: unknown = options.processorOptions?.targetChannels;
			this.#channels = isCount(channels) ? channels : 1;
			const frameLength: unknown = options.processorOptions?.frameLength;
			this.#frameLength = isCount(frameLength)
				? frameLength
				: Math.round(this.#sampleRate * DEFAULT_FRAME_DURATION_US / 1_000_000);
			this.#buffer = new Float32Array(this.#channels * this.#frameLength);

			this.port.onmessage = ({ data }: MessageEvent<unknown>) => {
				if (!isAudioHijackMessage(data)) return;
				switch (data.type) {
					case "format":
						this.#setFormat(data.channels, data.frameLength);
						return;
					case "stop":
						this.#stopped = true;
						this.port.close();
						return;
					default: {
						const unhandled: never = data;
						return unhandled;
					}
				}
			};
		}

		// Posts what is captured so far, then captures in the new format.
		#setFormat(channels: number, frameLength: number): void {
			if (channels === this.#channels && frameLength === this.#frameLength) return;
			this.#post();
			this.#channels = channels;
			this.#frameLength = frameLength;
			this.#buffer = new Float32Array(channels * frameLength);
		}

		// Posts the frame being filled, if it holds anything; the next one
		// starts after it.
		#post(): void {
			const frames = this.#filled;
			if (frames === 0) return;
			let data = this.#buffer;
			if (frames < this.#frameLength) {
				// A short frame: its planes are packed together.
				data = new Float32Array(this.#channels * frames);
				for (let c = 0; c < this.#channels; c++) {
					const plane = c * this.#frameLength;
					data.set(this.#buffer.subarray(plane, plane + frames), c * frames);
				}
			} else {
				this.#buffer = new Float32Array(this.#channels * this.#frameLength);
			}
			const message: FrameMessage = {
				type: "frame",
				data,
				numberOfChannels: this.#channels,
				numberOfFrames: frames,
				sampleRate: this.#sampleRate,
				timestamp: Math.round(this.#frameStart * 1_000_000 / this.#sampleRate),
			};
			this.port.postMessage(message, [data.buffer]);
			this.#frameStart += frames;
			this.#filled = 0;
		}

		process(inputs: Float32Array[][]): boolean {
			if (this.#stopped) return false;
			if (inputs.length > 1) throw new Error("only one input is supported.");

			// Just take one input channel, the first one.
			// MOQ enables the delivery of audio inputs individually for each track.
			// So do not mix audio from different tracks or different devices.
			const channels = inputs[0];
			const first = channels?.[0];

			if (!channels || !first) {
				// The input stopped (its source was disconnected): post what was
				// captured and say so once, so the node can release the audio its
				// encoder still holds.
				if (this.#capturing) {
					this.#capturing = false;
					this.#post();
					this.port.postMessage(INPUT_ENDED);
				}
				return true;
			}
			this.#capturing = true;

			const now = currentFrame;
			if (this.#filled > 0 && now !== this.#nextFrame) this.#post();
			if (this.#filled === 0) this.#frameStart = now;
			this.#nextFrame = now + first.length;

			// The node sets the input's channel count to the captured one; a
			// missing channel repeats the first.
			let offset = 0;
			while (offset < first.length) {
				const take = Math.min(first.length - offset, this.#frameLength - this.#filled);
				for (let c = 0; c < this.#channels; c++) {
					const source = (channels[c] ?? first).subarray(offset, offset + take);
					const at = c * this.#frameLength + this.#filled;
					this.#buffer.set(source, at);
					// A channel shorter than the first reads as silence.
					this.#buffer.fill(0, at + source.length, at + take);
				}
				this.#filled += take;
				offset += take;
				if (this.#filled === this.#frameLength) this.#post();
			}

			return true;
		}
	}

	try {
		registerProcessor(HIJACK_PROCESSOR_NAME, AudioHijackProcessor);
	} catch (e) {
		// reason: the module was evaluated again in this scope (another copy of
		// the same version loaded it); the identical processor registered first
		// stays in use.
		if (!(e instanceof DOMException && e.name === "NotSupportedError")) throw e;
	}
}

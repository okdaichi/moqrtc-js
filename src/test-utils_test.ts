/// <reference path="./test_globals.d.ts" />
// Common test utilities and mocks for hang-web tests

import { mockAudioContextClose, mockAudioWorkletAddModule } from "./mock_audio_context_test.ts";
import {
	mockAudioWorkletNode,
	mockWorkletConnect,
	mockWorkletDisconnect,
	mockWorkletPort,
} from "./mock_audio_worklet_node_test.ts";
import { mockCanvas, mockCanvasContext } from "./mock_canvas_test.ts";
import {
	MockGainNode,
	mockGainNodeConnect,
	mockGainNodeDisconnect,
} from "./mock_gain_node_test.ts";
import { mockVideo } from "./mock_video_test.ts";

// Re-export mocks for convenience
export {
	mockAudioContext,
	mockAudioContextClose,
	mockAudioWorkletAddModule,
} from "./mock_audio_context_test.ts";
export {
	mockAudioWorkletNode,
	mockWorkletConnect,
	mockWorkletDisconnect,
	mockWorkletPort,
} from "./mock_audio_worklet_node_test.ts";
export { mockCanvas, mockCanvasContext } from "./mock_canvas_test.ts";
export {
	MockGainNode,
	mockGainNode,
	mockGainNodeConnect,
	mockGainNodeDisconnect,
} from "./mock_gain_node_test.ts";
export { mockVideo } from "./mock_video_test.ts";

/**
 * Assigns a value to a globalThis property, bypassing strict DOM type checks.
 * Used in tests to stub browser APIs with fake implementations.
 */
export function stubGlobal(key: string, value: unknown): void {
	(globalThis as unknown as Record<string, unknown>)[key] = value;
}

/**
 * Deletes a globalThis property, bypassing strict DOM type checks.
 */
export function deleteGlobal(key: string): void {
	delete (globalThis as unknown as Record<string, unknown>)[key];
}

// Global constructor mocks
export function setupGlobalMocks() {
	stubGlobal(
		"AudioContext",
		class MockAudioContext {
			audioWorklet = {
				addModule: mockAudioWorkletAddModule,
			};
			get currentTime() {
				return this._currentTime || 0;
			}
			set currentTime(value: number) {
				this._currentTime = value;
			}
			_currentTime = 0;
			sampleRate = 44100;
			destination = {};
			close = mockAudioContextClose;
		},
	);
	stubGlobal("GainNode", MockGainNode);
	stubGlobal("AudioWorkletNode", () => mockAudioWorkletNode);
	stubGlobal("HTMLCanvasElement", () => mockCanvas);
	stubGlobal("HTMLVideoElement", () => mockVideo);

	// Mock console.warn for testing
	stubGlobal("originalConsoleWarn", console.warn);
	stubGlobal("warnCalls", []);
	console.warn = (...args: unknown[]) => {
		const warnCalls = (globalThis as unknown as Record<string, unknown[][]>).warnCalls!;
		warnCalls.push(args);
	};
}

export function resetGlobalMocks() {
	// Reset spies
	mockCanvasContext.clearRect.calls.length = 0;
	mockCanvasContext.drawImage.calls.length = 0;
	mockCanvasContext.fillText.calls.length = 0;
	mockVideo.play.calls.length = 0;
	mockVideo.pause.calls.length = 0;
	mockVideo.addEventListener.calls.length = 0;
	mockVideo.removeEventListener.calls.length = 0;
	mockAudioWorkletAddModule.calls.length = 0;
	mockAudioContextClose.calls.length = 0;
	mockGainNodeConnect.calls.length = 0;
	mockGainNodeDisconnect.calls.length = 0;
	mockWorkletConnect.calls.length = 0;
	mockWorkletDisconnect.calls.length = 0;
	mockWorkletPort.postMessage.calls.length = 0;

	// Reset console.warn calls
	stubGlobal("warnCalls", []);

	// Re-setup global mocks
	setupGlobalMocks();
}

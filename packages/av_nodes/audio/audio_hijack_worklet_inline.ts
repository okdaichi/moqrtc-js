// Auto-generated file - do not edit manually
// Generated from audio_hijack_worklet.ts

/**
 * Inline worklet code for audio_hijack_worklet
 * This code is bundled and minified at build time.
 */
export const HijackCode =
	'if(typeof AudioWorkletProcessor<"u"){class l extends AudioWorkletProcessor{#s;#e=!1;#t;constructor(a){super(),this.#s=a.processorOptions?.sampleRate||globalThis.sampleRate,this.#t=a.processorOptions?.targetChannels||1,this.port.onmessage=({data:s})=>{let o=s?.targetChannels;Number.isInteger(o)&&o>0&&(this.#t=o)}}process(a){if(a.length>1)throw new Error("only one input is supported.");let s=a[0];if(!s||s.length===0||!s[0])return this.#e&&(this.#e=!1,this.port.postMessage({inputEnded:!0})),!0;this.#e=!0;let o=s.length,t=s[0].length,i=this.#t,r=new Float32Array(i*t);for(let e=0;e<i;e++)if(e<o){let n=s[e];n&&n.length>0?r.set(n,e*t):r.fill(0,e*t,(e+1)*t)}else if(o>0){let n=s[0];n&&n.length>0?r.set(n,e*t):r.fill(0,e*t,(e+1)*t)}else r.fill(0,e*t,(e+1)*t);let u={format:"f32-planar",sampleRate:this.#s,numberOfChannels:i,numberOfFrames:t,data:r,timestamp:Math.round(currentFrame*1e6/sampleRate),transfer:[r.buffer]};return this.port.postMessage(u),!0}}registerProcessor("audio-hijacker",l)}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([HijackCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

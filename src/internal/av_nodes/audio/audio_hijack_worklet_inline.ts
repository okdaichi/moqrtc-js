// Auto-generated file - do not edit manually
// Generated from audio_hijack_worklet.ts

/**
 * Inline worklet code for audio_hijack_worklet
 * This code is bundled and minified at build time.
 */
export const HijackCode =
	'if(typeof AudioWorkletProcessor<"u"){class l extends AudioWorkletProcessor{#t=0;#e;#r;constructor(o){super(),this.#e=o.processorOptions?.sampleRate||globalThis.sampleRate,this.#r=o.processorOptions?.targetChannels||1}process(o){if(o.length>1)throw new Error("only one input is supported.");let r=o[0];if(!r||r.length===0||!r[0])return!0;let i=r.length,t=r[0].length,a=this.#r,s=new Float32Array(a*t);for(let e=0;e<a;e++)if(e<i){let n=r[e];n&&n.length>0?s.set(n,e*t):s.fill(0,e*t,(e+1)*t)}else if(i>0){let n=r[0];n&&n.length>0?s.set(n,e*t):s.fill(0,e*t,(e+1)*t)}else s.fill(0,e*t,(e+1)*t);let u={format:"f32-planar",sampleRate:this.#e,numberOfChannels:a,numberOfFrames:t,data:s,timestamp:Math.round(this.#t*1e6/this.#e),transfer:[s.buffer]};return this.port.postMessage(u),this.#t+=t,!0}}registerProcessor("audio-hijacker",l)}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([HijackCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

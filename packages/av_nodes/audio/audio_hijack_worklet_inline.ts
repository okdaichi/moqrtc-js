// Auto-generated file - do not edit manually
// Generated from audio_hijack_worklet.ts

/**
 * Inline worklet code for audio_hijack_worklet
 * This code is bundled and minified at build time.
 */
export const HijackCode =
	'var f="audio-hijacker-v1";function u(n){return typeof n=="object"&&n!==null&&"type"in n&&n.type==="stop"}if(typeof AudioWorkletProcessor<"u"){class n extends AudioWorkletProcessor{#s;#e=!1;#t;#r=!1;constructor(a){super(),this.#s=a.processorOptions?.sampleRate||globalThis.sampleRate,this.#t=a.processorOptions?.targetChannels||1,this.port.onmessage=({data:t})=>{if(u(t)){this.#r=!0,this.port.close();return}let i=t?.targetChannels;Number.isInteger(i)&&i>0&&(this.#t=i)}}process(a){if(this.#r)return!1;if(a.length>1)throw new Error("only one input is supported.");let t=a[0];if(!t||t.length===0||!t[0])return this.#e&&(this.#e=!1,this.port.postMessage({inputEnded:!0})),!0;this.#e=!0;let i=t.length,s=t[0].length,p=this.#t,r=new Float32Array(p*s);for(let e=0;e<p;e++)if(e<i){let o=t[e];o&&o.length>0?r.set(o,e*s):r.fill(0,e*s,(e+1)*s)}else if(i>0){let o=t[0];o&&o.length>0?r.set(o,e*s):r.fill(0,e*s,(e+1)*s)}else r.fill(0,e*s,(e+1)*s);let c={format:"f32-planar",sampleRate:this.#s,numberOfChannels:p,numberOfFrames:s,data:r,timestamp:Math.round(currentFrame*1e6/sampleRate),transfer:[r.buffer]};return this.port.postMessage(c),!0}}try{registerProcessor(f,n)}catch(l){if(!(l instanceof DOMException&&l.name==="NotSupportedError"))throw l}}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([HijackCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

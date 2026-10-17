// Auto-generated file - do not edit manually
// Generated from audio_hijack_worklet.ts

/**
 * Inline worklet code for audio_hijack_worklet
 * This code is bundled and minified at build time.
 */
export const HijackCode =
	'var u="audio-hijacker-v1";function f(i){return typeof i=="object"&&i!==null&&"type"in i&&i.type==="stop"}if(typeof AudioWorkletProcessor<"u"){class i extends AudioWorkletProcessor{#s;#e=!1;#t;#r=!1;constructor(a){super(),this.#s=a.processorOptions?.sampleRate||globalThis.sampleRate,this.#t=a.processorOptions?.targetChannels||1,this.port.onmessage=({data:e})=>{if(f(e)){this.#r=!0,this.port.close();return}let r=typeof e=="object"&&e!==null&&"targetChannels"in e?e.targetChannels:void 0;typeof r=="number"&&Number.isInteger(r)&&r>0&&(this.#t=r)}}process(a){if(this.#r)return!1;if(a.length>1)throw new Error("only one input is supported.");let e=a[0];if(!e||e.length===0||!e[0])return this.#e&&(this.#e=!1,this.port.postMessage({inputEnded:!0})),!0;this.#e=!0;let r=e.length,s=e[0].length,p=this.#t,n=new Float32Array(p*s);for(let t=0;t<p;t++)if(t<r){let o=e[t];o&&o.length>0?n.set(o,t*s):n.fill(0,t*s,(t+1)*s)}else if(r>0){let o=e[0];o&&o.length>0?n.set(o,t*s):n.fill(0,t*s,(t+1)*s)}else n.fill(0,t*s,(t+1)*s);let c={format:"f32-planar",sampleRate:this.#s,numberOfChannels:p,numberOfFrames:s,data:n,timestamp:Math.round(currentFrame*1e6/sampleRate),transfer:[n.buffer]};return this.port.postMessage(c),!0}}try{registerProcessor(u,i)}catch(l){if(!(l instanceof DOMException&&l.name==="NotSupportedError"))throw l}}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([HijackCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

// Auto-generated file - do not edit manually
// Generated from capture_worklet.ts

/**
 * Inline worklet code for capture_worklet
 * This code is bundled and minified at build time.
 */
export const CaptureCode =
	'function l(s){return typeof s=="object"&&s!==null}function i(s){return Number.isSafeInteger(s)&&typeof s=="number"&&s>0}function m(s){if(!l(s))return!1;switch(s.type){case"format":return i(s.channels)&&i(s.frameLength);case"stop":return!0;default:return!1}}var c="@okdaichi/av-nodes/capture@0.15.1";var y={type:"inputEnded"};if(typeof AudioWorkletProcessor<"u"){class s extends AudioWorkletProcessor{#n;#t;#e;#s;#r=0;#a=0;#u=0;#i=!1;#p=!1;constructor(e){super();let t=e.processorOptions?.sampleRate;this.#n=typeof t=="number"&&t>0?t:globalThis.sampleRate;let o=e.processorOptions?.targetChannels;this.#t=i(o)?o:1;let n=e.processorOptions?.frameLength;this.#e=i(n)?n:Math.round(this.#n*2e4/1e6),this.#s=new Float32Array(this.#t*this.#e),this.port.onmessage=({data:r})=>{if(m(r))switch(r.type){case"format":this.#h(r.channels,r.frameLength);return;case"stop":this.#p=!0,this.port.close();return;default:return r}}}#h(e,t){e===this.#t&&t===this.#e||(this.#o(),this.#t=e,this.#e=t,this.#s=new Float32Array(e*t))}#o(){let e=this.#r;if(e===0)return;let t=this.#s;if(e<this.#e){t=new Float32Array(this.#t*e);for(let n=0;n<this.#t;n++){let r=n*this.#e;t.set(this.#s.subarray(r,r+e),n*e)}}else this.#s=new Float32Array(this.#t*this.#e);let o={type:"frame",data:t,numberOfChannels:this.#t,numberOfFrames:e,sampleRate:this.#n,timestamp:Math.round(this.#a*1e6/this.#n)};this.port.postMessage(o,[t.buffer]),this.#a+=e,this.#r=0}process(e){if(this.#p)return!1;if(e.length>1)throw new Error("only one input is supported.");let t=e[0],o=t?.[0];if(!t||!o)return this.#i&&(this.#i=!1,this.#o(),this.port.postMessage(y)),!0;this.#i=!0;let n=currentFrame;this.#r>0&&n!==this.#u&&this.#o(),this.#r===0&&(this.#a=n),this.#u=n+o.length;let r=0;for(;r<o.length;){let a=Math.min(o.length-r,this.#e-this.#r);for(let p=0;p<this.#t;p++){let f=(t[p]??o).subarray(r,r+a),h=p*this.#e+this.#r;this.#s.set(f,h),this.#s.fill(0,h+f.length,h+a)}this.#r+=a,r+=a,this.#r===this.#e&&this.#o()}return!0}}try{registerProcessor(c,s)}catch(u){if(!(u instanceof DOMException&&u.name==="NotSupportedError"))throw u}}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([CaptureCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

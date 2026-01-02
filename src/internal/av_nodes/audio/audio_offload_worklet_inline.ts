// Auto-generated file - do not edit manually
// Generated from audio_offload_worklet.ts

/**
 * Inline worklet code for audio_offload_worklet
 * This code is bundled and minified at build time.
 */
export const audioOffloadWorkletCode = "function y(){return new URL(\"./audio_offload_worklet.js\",import.meta.url).href}var g=\"audio-offloader\";if(typeof AudioWorkletProcessor<\"u\"){class u extends AudioWorkletProcessor{#t=[];#e=0;#n=0;constructor(o){if(super(),!o.processorOptions)throw new Error(\"processorOptions is required\");let t=o.channelCount;if(!t||t<=0)throw new Error(\"invalid channelCount\");let e=o.processorOptions.sampleRate;if(!e||e<=0)throw new Error(\"invalid sampleRate\");let f=o.processorOptions.latency;if(!f||f<=0)throw new Error(\"invalid latency\");let c=Math.ceil(e*f/1e3);for(let n=0;n<t;n++)this.#t[n]=new Float32Array(c);this.port.onmessage=({data:n})=>{this.append(n.channels)}}append(o){if(!o.length||!o[0]||o[0].length===0||this.#t===void 0||this.#t.length===0||this.#t[0]===void 0)return;let t=this.#t[0].length,e=o[0].length,f=this.#n-this.#e+e-t;f>0&&(this.#e+=f);for(let c=0;c<this.#t.length;c++){let n=o[c],l=this.#t[c];if(!l)continue;if(!n){let i=this.#n%t,s=Math.min(e,t-i);l.fill(0,i,i+s),s<e&&l.fill(0,0,e-s);continue}let r=this.#n%t,h=0;for(;h<e;){let i=e-h,s=t-r,a=Math.min(i,s);l.set(n.subarray(h,h+a),r),h+=a,r=(r+a)%t}}this.#n+=e}process(o,t){if(t===void 0||t.length===0||t[0]===void 0||t[0]?.length===0||this.#t.length===0||this.#t[0]===void 0)return!0;let e=this.#t[0].length,f=this.#n-this.#e,c=t[0][0]?.length??128,n=Math.min(Math.max(0,f),c);if(n<=0){for(let l of t)for(let r of l)r&&r.fill(0);return!0}for(let l of t)for(let r=0;r<l.length;r++){let h=this.#t[r],i=l[r];if(!i)continue;if(!h){i.fill(0);continue}let s=this.#e%e,a=0;for(;a<n;){let m=n-a,p=e-s,d=Math.min(m,p);i.set(h.subarray(s,s+d),a),a+=d,s=(s+d)%e}a<i.length&&i.fill(0,a)}return this.#e+=n,!0}}registerProcessor(g,u)}export{y as importWorkletUrl,g as workletName};\n";

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([audioOffloadWorkletCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

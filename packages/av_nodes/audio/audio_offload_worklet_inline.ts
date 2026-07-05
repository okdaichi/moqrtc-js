// Auto-generated file - do not edit manually
// Generated from audio_offload_worklet.ts

/**
 * Inline worklet code for audio_offload_worklet
 * This code is bundled and minified at build time.
 */
export const OffloadCode =
	'if(typeof AudioWorkletProcessor<"u"){class b extends AudioWorkletProcessor{#t=[];#e=0;#i=null;#n=null;#s=0;#r=0;#o=0;constructor(r){if(super(),!r.processorOptions)throw new Error("processorOptions is required");let n=r.channelCount;if(!n||n<=0)throw new Error("invalid channelCount");let i=r.processorOptions.sampleRate;if(!i||i<=0)throw new Error("invalid sampleRate");let e=r.processorOptions.latency;if(!e||e<=0)throw new Error("invalid latency");this.#o=i,this.#s=Math.ceil(i*e/1e3),this.#r=this.#s*2;for(let t=0;t<n;t++)this.#t[t]=new Float32Array(this.#r);this.port.onmessage=({data:t})=>{this.append(t.channels,t.timestamp)}}#l(r){let n=this.#i??0;return this.#s+Math.round((r-n)*this.#o/1e6)}#a(r,n){let i=this.#r;for(let e of this.#t){if(!e)continue;let t=r%i,l=n-r;for(;l>0;){let o=Math.min(l,i-t);e.fill(0,t,t+o),t=(t+o)%i,l-=o}}}append(r,n){if(!r.length||!r[0]||r[0].length===0||this.#t===void 0||this.#t.length===0||this.#t[0]===void 0)return;let i=r[0].length;this.#i===null&&(this.#i=n,this.#n=0);let e=this.#l(n),t=e+i;if(t<=this.#e)return;let l=this.#e+this.#r;if(e>=l)return;t>l&&(t=l);let o=this.#n??e;e>o&&this.#a(o,e);let a=this.#r,f=t-e;for(let m=0;m<this.#t.length;m++){let d=r[m],h=this.#t[m];if(!h)continue;if(!d){let c=e%a,u=f;for(;u>0;){let g=Math.min(u,a-c);h.fill(0,c,c+g),c=(c+g)%a,u-=g}continue}let s=e%a,p=0;for(;p<f;){let c=f-p,u=a-s,g=Math.min(c,u);h.set(d.subarray(p,p+g),s),p+=g,s=(s+g)%a}}(this.#n===null||t>this.#n)&&(this.#n=t)}process(r,n){if(n===void 0||n.length===0||n[0]===void 0||n[0]?.length===0||this.#t.length===0||this.#t[0]===void 0)return!0;let i=this.#r,e=n[0][0]?.length??128,t=this.#n??this.#e,l=Math.min(this.#e+e,t),o=Math.max(0,l-this.#e);for(let a of n)for(let f=0;f<a.length;f++){let m=this.#t[f],d=a[f];if(!d)continue;if(!m||o<=0){d.fill(0);continue}let h=this.#e%i,s=0;for(;s<o;){let p=o-s,c=i-h,u=Math.min(p,c);d.set(m.subarray(h,h+u),s),s+=u,h=(h+u)%i}s<d.length&&d.fill(0,s)}return this.#e+=e,!0}}registerProcessor("audio-offloader",b)}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([OffloadCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

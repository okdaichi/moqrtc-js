// Auto-generated file - do not edit manually
// Generated from audio_offload_worklet.ts

/**
 * Inline worklet code for audio_offload_worklet
 * This code is bundled and minified at build time.
 */
export const OffloadCode =
	'if(typeof AudioWorkletProcessor<"u"){class y extends AudioWorkletProcessor{#e=[];#t=0;#r=null;#o=0;#n=null;#s=0;#i=0;#l=0;constructor(i){if(super(),!i.processorOptions)throw new Error("processorOptions is required");let e=i.channelCount;if(!e||e<=0)throw new Error("invalid channelCount");let r=i.processorOptions.sampleRate;if(!r||r<=0)throw new Error("invalid sampleRate");let t=i.processorOptions.latency;if(!t||t<=0)throw new Error("invalid latency");this.#l=r,this.#s=Math.ceil(r*t/1e3),this.#i=this.#s*2;for(let n=0;n<e;n++)this.#e[n]=new Float32Array(this.#i);this.port.onmessage=({data:n})=>{this.append(n.channels,n.timestamp)}}#a(i){let e=this.#r??0;return this.#o+this.#s+Math.round((i-e)*this.#l/1e6)}#h(i,e){let r=this.#i;for(let t of this.#e){if(!t)continue;let n=i%r,l=e-i;for(;l>0;){let s=Math.min(l,r-n);t.fill(0,n,n+s),n=(n+s)%r,l-=s}}}append(i,e){if(!i.length||!i[0]||i[0].length===0||this.#e===void 0||this.#e.length===0||this.#e[0]===void 0)return;let r=i[0].length;this.#r===null&&(this.#r=e,this.#o=this.#t,this.#n=this.#t);let t=this.#a(e),n=t+r;if(n<=this.#t)return;let l=0;t<this.#t&&(l=this.#t-t,t=this.#t);let s=this.#t+this.#i,f=n;if(t>=s)return;f>s&&(f=s);let m=this.#n??t;t>m&&this.#h(m,t);let a=this.#i,h=f-t;for(let o=0;o<this.#e.length;o++){let c=i[o],b=this.#e[o];if(!b)continue;if(!c){let d=t%a,w=h;for(;w>0;){let p=Math.min(w,a-d);b.fill(0,d,d+p),d=(d+p)%a,w-=p}continue}let g=t%a,u=0;for(;u<h;){let d=h-u,w=a-g,p=Math.min(d,w);b.set(c.subarray(l+u,l+u+p),g),u+=p,g=(g+p)%a}}(this.#n===null||f>this.#n)&&(this.#n=f)}process(i,e){let r=e?.[0]?.[0]?.length??128;if(e===void 0||e.length===0||e[0]===void 0||e[0]?.length===0)return this.#t+=r,!0;if(this.#e.length===0||this.#e[0]===void 0)return this.#t+=r,!0;let t=this.#i,n=this.#n??this.#t,l=Math.min(this.#t+r,n),s=Math.max(0,l-this.#t);for(let f of e)for(let m=0;m<f.length;m++){let a=this.#e[m],h=f[m];if(!h)continue;if(!a||s<=0){h.fill(0);continue}let o=this.#t%t,c=0;for(;c<s;){let b=s-c,g=t-o,u=Math.min(b,g);h.set(a.subarray(o,o+u),c),c+=u,o=(o+u)%t}c<h.length&&h.fill(0,c)}return this.#t+=r,!0}}registerProcessor("audio-offloader",y)}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([OffloadCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

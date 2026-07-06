// Auto-generated file - do not edit manually
// Generated from audio_offload_worklet.ts

/**
 * Inline worklet code for audio_offload_worklet
 * This code is bundled and minified at build time.
 */
export const OffloadCode =
	'if(typeof AudioWorkletProcessor<"u"){class y extends AudioWorkletProcessor{#e=[];#t=0;#r=null;#o=0;#i=null;#s=0;#n=0;#l=0;constructor(i){if(super(),!i.processorOptions)throw new Error("processorOptions is required");let e=i.channelCount;if(!e||e<=0)throw new Error("invalid channelCount");let s=i.processorOptions.sampleRate;if(!s||s<=0)throw new Error("invalid sampleRate");let t=i.processorOptions.latency;if(!t||t<=0)throw new Error("invalid latency");this.#l=s,this.#s=Math.ceil(s*t/1e3),this.#n=this.#s*2;for(let n=0;n<e;n++)this.#e[n]=new Float32Array(this.#n);this.port.onmessage=({data:n})=>{this.append(n.channels,n.timestamp)}}#h(i){let e=this.#r??0;return this.#o+this.#s+Math.round((i-e)*this.#l/1e6)}#a(i,e){let s=this.#n;for(let t of this.#e){if(!t)continue;let n=i%s,o=e-i;for(;o>0;){let l=Math.min(o,s-n);t.fill(0,n,n+l),n=(n+l)%s,o-=l}}}append(i,e){if(!i.length||!i[0]||i[0].length===0||this.#e===void 0||this.#e.length===0||this.#e[0]===void 0)return;let s=i[0].length;this.#r===null&&(this.#r=e,this.#o=this.#t,this.#i=this.#t);let t=this.#h(e),n=t+s;if(n<=this.#t)return;let o=0;t<this.#t&&(o=this.#t-t,t=this.#t);let l=this.#t+this.#n,f=n;t>=l&&(this.#t=t-this.#s,this.#i=this.#t),f>this.#t+this.#n&&(f=this.#t+this.#n);let m=this.#i??t;t>m&&this.#a(m,t);let h=this.#n,a=f-t;for(let r=0;r<this.#e.length;r++){let c=i[r],b=this.#e[r];if(!b)continue;if(!c){let d=t%h,w=a;for(;w>0;){let p=Math.min(w,h-d);b.fill(0,d,d+p),d=(d+p)%h,w-=p}continue}let g=t%h,u=0;for(;u<a;){let d=a-u,w=h-g,p=Math.min(d,w);b.set(c.subarray(o+u,o+u+p),g),u+=p,g=(g+p)%h}}(this.#i===null||f>this.#i)&&(this.#i=f)}process(i,e){let s=e?.[0]?.[0]?.length??128;if(e===void 0||e.length===0||e[0]===void 0||e[0]?.length===0)return this.#t+=s,!0;if(this.#e.length===0||this.#e[0]===void 0)return this.#t+=s,!0;let t=this.#n,n=this.#i??this.#t,o=Math.min(this.#t+s,n),l=Math.max(0,o-this.#t);for(let f of e)for(let m=0;m<f.length;m++){let h=this.#e[m],a=f[m];if(!a)continue;if(!h||l<=0){a.fill(0);continue}let r=this.#t%t,c=0;for(;c<l;){let b=l-c,g=t-r,u=Math.min(b,g);a.set(h.subarray(r,r+u),c),c+=u,r=(r+u)%t}c<a.length&&a.fill(0,c)}return this.#t+=s,!0}}registerProcessor("audio-offloader",y)}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([OffloadCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

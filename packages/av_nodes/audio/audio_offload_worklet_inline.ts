// Auto-generated file - do not edit manually
// Generated from audio_offload_worklet.ts

/**
 * Inline worklet code for audio_offload_worklet
 * This code is bundled and minified at build time.
 */
export const OffloadCode =
	'var F="audio-offloader",O=3;if(typeof AudioWorkletProcessor<"u"){class y extends AudioWorkletProcessor{#e=[];#t=0;#o=null;#h=0;#i=null;#s=0;#n=0;#l=0;#r=0;constructor(n){if(super(),!n.processorOptions)throw new Error("processorOptions is required");let e=n.channelCount;if(!e||e<=0)throw new Error("invalid channelCount");let i=n.processorOptions.sampleRate;if(!i||i<=0)throw new Error("invalid sampleRate");let t=n.processorOptions.latency;if(!t||t<=0)throw new Error("invalid latency");this.#l=i,this.#s=Math.ceil(i*t/1e3),this.#n=this.#s*2;for(let s=0;s<e;s++)this.#e[s]=new Float32Array(this.#n);this.port.onmessage=({data:s})=>{this.append(s.channels,s.timestamp)}}#a(n){let e=this.#o??0;return this.#h+this.#s+Math.round((n-e)*this.#l/1e6)}#c(n){this.#o=n,this.#h=this.#t,this.#i=this.#t,this.#r=0}#u(n,e){let i=this.#n;for(let t of this.#e){if(!t)continue;let s=n%i,o=e-n;for(;o>0;){let h=Math.min(o,i-s);t.fill(0,s,s+h),s=(s+h)%i,o-=h}}}append(n,e){if(!n.length||!n[0]||n[0].length===0||this.#e===void 0||this.#e.length===0||this.#e[0]===void 0)return;let i=n[0].length;this.#o===null&&this.#c(e);let t=this.#a(e);if(t+i<=this.#t){if(this.#r++,this.#r<O)return;this.#c(e),t=this.#a(e)}this.#r=0;let s=t+i,o=0;t<this.#t&&(o=this.#t-t,t=this.#t);let h=this.#t+this.#n,f=s;t>=h&&(this.#t=t-this.#s,this.#i=this.#t),f>this.#t+this.#n&&(f=this.#t+this.#n);let m=this.#i??t;t>m&&this.#u(m,t);let l=this.#n,a=f-t;for(let r=0;r<this.#e.length;r++){let c=n[r],g=this.#e[r];if(!g)continue;if(!c){let d=t%l,w=a;for(;w>0;){let p=Math.min(w,l-d);g.fill(0,d,d+p),d=(d+p)%l,w-=p}continue}let b=t%l,u=0;for(;u<a;){let d=a-u,w=l-b,p=Math.min(d,w);g.set(c.subarray(o+u,o+u+p),b),u+=p,b=(b+p)%l}}(this.#i===null||f>this.#i)&&(this.#i=f)}process(n,e){let i=e?.[0]?.[0]?.length??128;if(e===void 0||e.length===0||e[0]===void 0||e[0]?.length===0)return this.#t+=i,!0;if(this.#e.length===0||this.#e[0]===void 0)return this.#t+=i,!0;let t=this.#n,s=this.#i??this.#t,o=Math.min(this.#t+i,s),h=Math.max(0,o-this.#t);for(let f of e)for(let m=0;m<f.length;m++){let l=this.#e[m],a=f[m];if(!a)continue;if(!l||h<=0){a.fill(0);continue}let r=this.#t%t,c=0;for(;c<h;){let g=h-c,b=t-r,u=Math.min(g,b);a.set(l.subarray(r,r+u),c),c+=u,r=(r+u)%t}c<a.length&&a.fill(0,c)}return this.#t+=i,!0}}registerProcessor("audio-offloader",y)}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([OffloadCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

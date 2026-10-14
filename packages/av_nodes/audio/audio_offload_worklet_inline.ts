// Auto-generated file - do not edit manually
// Generated from audio_offload_worklet.ts

/**
 * Inline worklet code for audio_offload_worklet
 * This code is bundled and minified at build time.
 */
export const OffloadCode =
	'var F="audio-offloader",O=3;if(typeof AudioWorkletProcessor<"u"){class y extends AudioWorkletProcessor{#e=[];#t=0;#o=null;#h=0;#n=null;#s=0;#i=0;#l=0;#r=0;constructor(i){if(super(),!i.processorOptions)throw new Error("processorOptions is required");let e=i.channelCount;if(!e||e<=0)throw new Error("invalid channelCount");let n=i.processorOptions.sampleRate;if(!n||n<=0)throw new Error("invalid sampleRate");let t=i.processorOptions.latency;if(!t||t<=0)throw new Error("invalid latency");this.#l=n,this.#s=Math.ceil(n*t/1e3),this.#i=this.#s*2;for(let s=0;s<e;s++)this.#e[s]=new Float32Array(this.#i);this.port.onmessage=({data:s})=>{this.append(s.channels,s.timestamp)}}#a(i){let e=this.#o??0;return this.#h+this.#s+Math.round((i-e)*this.#l/1e6)}#c(i){this.#o=i,this.#h=this.#t,this.#n=this.#t,this.#r=0}#u(i,e){let n=this.#i;for(let t of this.#e){if(!t)continue;let s=i%n,o=e-i;for(;o>0;){let h=Math.min(o,n-s);t.fill(0,s,s+h),s=(s+h)%n,o-=h}}}append(i,e){if(!i.length||!i[0]||i[0].length===0||this.#e===void 0||this.#e.length===0||this.#e[0]===void 0)return;let n=i[0].length;this.#o===null&&this.#c(e);let t=this.#a(e);if(t+n<=this.#t){let r=this.#t-(t+n)>this.#s;if(this.#r=r?this.#r+1:0,this.#r<O)return;this.#c(e),t=this.#a(e)}this.#r=0;let s=t+n,o=0;t<this.#t&&(o=this.#t-t,t=this.#t);let h=this.#t+this.#i,f=s;t>=h&&(this.#t=t-this.#s,this.#n=this.#t),f>this.#t+this.#i&&(f=this.#t+this.#i);let d=this.#n??t;t>d&&this.#u(d,t);let l=this.#i,a=f-t;for(let r=0;r<this.#e.length;r++){let c=i[r],g=this.#e[r];if(!g)continue;if(!c){let m=t%l,w=a;for(;w>0;){let p=Math.min(w,l-m);g.fill(0,m,m+p),m=(m+p)%l,w-=p}continue}let b=t%l,u=0;for(;u<a;){let m=a-u,w=l-b,p=Math.min(m,w);g.set(c.subarray(o+u,o+u+p),b),u+=p,b=(b+p)%l}}(this.#n===null||f>this.#n)&&(this.#n=f)}process(i,e){let n=e?.[0]?.[0]?.length??128;if(e===void 0||e.length===0||e[0]===void 0||e[0]?.length===0)return this.#t+=n,!0;if(this.#e.length===0||this.#e[0]===void 0)return this.#t+=n,!0;let t=this.#i,s=this.#n??this.#t,o=Math.min(this.#t+n,s),h=Math.max(0,o-this.#t);for(let f of e)for(let d=0;d<f.length;d++){let l=this.#e[d],a=f[d];if(!a)continue;if(!l||h<=0){a.fill(0);continue}let r=this.#t%t,c=0;for(;c<h;){let g=h-c,b=t-r,u=Math.min(g,b);a.set(l.subarray(r,r+u),c),c+=u,r=(r+u)%t}c<a.length&&a.fill(0,c)}return this.#t+=n,!0}}registerProcessor("audio-offloader",y)}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([OffloadCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

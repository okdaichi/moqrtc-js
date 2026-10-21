// Auto-generated file - do not edit manually
// Generated from voice_activity_worklet.ts

/**
 * Inline worklet code for voice_activity_worklet
 * This code is bundled and minified at build time.
 */
export const VoiceActivityCode =
	'var m="@okdaichi/av-nodes/vad@0.14.0";function d(i){return typeof i=="object"&&i!==null&&"type"in i&&i.type==="stop"}var y=20;function g(i){return d(i)}var f={onDb:9,offDb:5,holdMs:350,floorRiseDbPerSec:4,minDb:-50},O=-90;function M(i){if(!_(i))return!1;let{onDb:n,offDb:e,holdMs:t,floorRiseDbPerSec:s,minDb:o}=i;return h(n)&&h(e)&&h(t)&&h(s)&&h(o)&&n>=e&&t>=0&&s>=0}function _(i){return typeof i=="object"&&i!==null}function h(i){return typeof i=="number"&&Number.isFinite(i)}var c=class{#t=null;#e=!1;#s=-1/0;#n=null;#o;constructor(n=f){this.#o=n}get floorDb(){return this.#t??O}get heard(){return this.#e}reset(){this.#t=null,this.#e=!1,this.#s=-1/0,this.#n=null}update(n,e){let t=Number.isFinite(n)?n:-1/0,s=this.#n===null?0:Math.max(0,e-this.#n)/1e3;this.#n=e;let o=this.#i(t,s),r=t>=this.#o.minDb;return r&&t>=o+this.#o.onDb?(this.#e=!0,this.#s=e):this.#e&&r&&t>=o+this.#o.offDb?this.#s=e:this.#e&&e-this.#s>this.#o.holdMs&&(this.#e=!1),this.#e}#i(n,e){let t=Math.max(n,O);if(this.#t===null||t<=this.#t)this.#t=t;else{let s=this.#o.floorRiseDbPerSec*e;this.#t=Math.min(t,this.#t+s)}return this.#t}};var D=Math.SQRT1_2,l=class{#t;#e;#s;#n;#o;#i=0;#r=0;#a=0;#h=0;constructor(n,e,t){let s=2*Math.PI*Math.min(e,t*.49)/t,o=Math.cos(s),r=Math.sin(s)/(2*D),a=1+r,p=n==="highpass"?-(1+o):1-o,b=n==="highpass"?(1+o)/2:(1-o)/2;this.#t=b/a,this.#e=p/a,this.#s=b/a,this.#n=-2*o/a,this.#o=(1-r)/a}next(n){let e=this.#t*n+this.#e*this.#i+this.#s*this.#r-this.#n*this.#a-this.#o*this.#h;return this.#r=this.#i,this.#i=n,this.#h=this.#a,this.#a=e,e}},u=class{#t;#e;constructor(n,e=300,t=3400){this.#t=new l("highpass",e,n),this.#e=new l("lowpass",t,n)}process(n,e){for(let t=0;t<e.length;t++)e[t]=this.#e.next(this.#t.next(n[t]??0))}};if(typeof AudioWorkletProcessor<"u"){class i extends AudioWorkletProcessor{#t;#e;#s;#n;#o=new Float32Array(128);#i=0;#r=0;#a=0;#h=!1;#c=!1;constructor(e){super();let t=e.processorOptions?.sampleRate,s=typeof t=="number"&&t>0?t:globalThis.sampleRate,o=e.processorOptions?.windowMs,r=typeof o=="number"&&o>0?o:y,a=e.processorOptions?.detector;this.#t=new c(M(a)?a:f),this.#e=new u(s),this.#s=Math.max(1,Math.round(s*r/1e3)),this.#n=1e3/s,this.port.onmessage=({data:p})=>{g(p)&&(this.#c=!0,this.port.close())}}process(e){if(this.#c)return!1;let t=e[0]??[],s=t[0]?.length??128;this.#o.length!==s&&(this.#o=new Float32Array(s)),this.#l(t),this.#e.process(this.#o,this.#o);for(let o=0;o<s;o++){let r=this.#o[o]??0;this.#i+=r*r,this.#r++,this.#a++,this.#r===this.#s&&this.#u()}return!0}#l(e){let t=this.#o;if(t.fill(0),e.length===0)return;let s=1/e.length;for(let o of e)for(let r=0;r<t.length;r++)t[r]=(t[r]??0)+(o[r]??0)*s}#u(){let e=this.#i/this.#r,t=e>0?10*Math.log10(e):-1/0;this.#i=0,this.#r=0;let s=this.#a*this.#n,o=this.#t.update(t,s);if(o===this.#h)return;this.#h=o;let r={type:"speaking",speaking:o,time:s};this.port.postMessage(r)}}registerProcessor(m,i)}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([VoiceActivityCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

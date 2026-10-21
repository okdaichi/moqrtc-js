// Auto-generated file - do not edit manually
// Generated from voice_activity_worklet.ts

/**
 * Inline worklet code for voice_activity_worklet
 * This code is bundled and minified at build time.
 */
export const VoiceActivityCode =
	'var p="@okdaichi/av-nodes/vad@0.14.0";function b(r){return typeof r=="object"&&r!==null&&"type"in r&&r.type==="stop"}var d=20;function y(r){return b(r)}var f={onDb:9,offDb:5,holdMs:350,floorRiseDbPerSec:4,minDb:-50},g=-90;function O(r){if(typeof r!="object"||r===null)return!1;let o=r,t=e=>typeof e=="number"&&Number.isFinite(e);return t(o.onDb)&&t(o.offDb)&&t(o.holdMs)&&t(o.floorRiseDbPerSec)&&t(o.minDb)&&o.onDb>=o.offDb&&o.holdMs>=0&&o.floorRiseDbPerSec>=0}var h=class{#t=null;#e=!1;#s=-1/0;#n=null;#o;constructor(o=f){this.#o=o}get floorDb(){return this.#t??g}get heard(){return this.#e}reset(){this.#t=null,this.#e=!1,this.#s=-1/0,this.#n=null}update(o,t){let e=Number.isFinite(o)?o:-1/0,n=this.#n===null?0:Math.max(0,t-this.#n)/1e3;this.#n=t;let s=this.#i(e,n),i=e>=this.#o.minDb;return i&&e>=s+this.#o.onDb?(this.#e=!0,this.#s=t):this.#e&&i&&e>=s+this.#o.offDb?this.#s=t:this.#e&&t-this.#s>this.#o.holdMs&&(this.#e=!1),this.#e}#i(o,t){let e=Math.max(o,g);if(this.#t===null||e<=this.#t)this.#t=e;else{let n=this.#o.floorRiseDbPerSec*t;this.#t=Math.min(e,this.#t+n)}return this.#t}};var M=Math.SQRT1_2,l=class{#t;#e;#s;#n;#o;#i=0;#r=0;#a=0;#h=0;constructor(o,t,e){let n=2*Math.PI*Math.min(t,e*.49)/e,s=Math.cos(n),i=Math.sin(n)/(2*M),a=1+i,u=o==="highpass"?-(1+s):1-s,m=o==="highpass"?(1+s)/2:(1-s)/2;this.#t=m/a,this.#e=u/a,this.#s=m/a,this.#n=-2*s/a,this.#o=(1-i)/a}next(o){let t=this.#t*o+this.#e*this.#i+this.#s*this.#r-this.#n*this.#a-this.#o*this.#h;return this.#r=this.#i,this.#i=o,this.#h=this.#a,this.#a=t,t}},c=class{#t;#e;constructor(o,t=300,e=3400){this.#t=new l("highpass",t,o),this.#e=new l("lowpass",e,o)}process(o,t){for(let e=0;e<t.length;e++)t[e]=this.#e.next(this.#t.next(o[e]??0))}};if(typeof AudioWorkletProcessor<"u"){class r extends AudioWorkletProcessor{#t;#e;#s;#n;#o=new Float32Array(128);#i=0;#r=0;#a=0;#h=!1;#l=!1;constructor(t){super();let e=t.processorOptions?.sampleRate,n=typeof e=="number"&&e>0?e:globalThis.sampleRate,s=t.processorOptions?.windowMs,i=typeof s=="number"&&s>0?s:d,a=t.processorOptions?.detector;this.#t=new h(O(a)?a:f),this.#e=new c(n),this.#s=Math.max(1,Math.round(n*i/1e3)),this.#n=1e3/n,this.port.onmessage=({data:u})=>{y(u)&&(this.#l=!0,this.port.close())}}process(t){if(this.#l)return!1;let e=t[0]??[],n=e[0]?.length??128;this.#o.length!==n&&(this.#o=new Float32Array(n)),this.#c(e),this.#e.process(this.#o,this.#o);for(let s=0;s<n;s++){let i=this.#o[s]??0;this.#i+=i*i,this.#r++,this.#a++,this.#r===this.#s&&this.#u()}return!0}#c(t){let e=this.#o;if(e.fill(0),t.length===0)return;let n=1/t.length;for(let s of t)for(let i=0;i<e.length;i++)e[i]=(e[i]??0)+(s[i]??0)*n}#u(){let t=this.#i/this.#r,e=t>0?10*Math.log10(t):-1/0;this.#i=0,this.#r=0;let n=this.#a*this.#n,s=this.#t.update(e,n);if(s===this.#h)return;this.#h=s;let i={type:"speaking",speaking:s,time:n};this.port.postMessage(i)}}registerProcessor(p,r)}';

/**
 * Create a Blob URL for the worklet code
 * Use this with audioContext.audioWorklet.addModule()
 */
export function createWorkletBlobUrl(): string {
	const blob = new Blob([VoiceActivityCode], { type: "application/javascript" });
	return URL.createObjectURL(blob);
}

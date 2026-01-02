var __accessCheck = (obj, member, msg) => {
  if (!member.has(obj))
    throw TypeError("Cannot " + msg);
};
var __privateGet = (obj, member, getter) => {
  __accessCheck(obj, member, "read from private field");
  return getter ? getter.call(obj) : member.get(obj);
};
var __privateAdd = (obj, member, value) => {
  if (member.has(obj))
    throw TypeError("Cannot add the same private member more than once");
  member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
};
var __privateSet = (obj, member, value, setter) => {
  __accessCheck(obj, member, "write to private field");
  setter ? setter.call(obj, value) : member.set(obj, value);
  return value;
};
var _currentFrame, _sampleRate, _targetChannels;
function importWorkletUrl() {
  return new URL("./audio_hijack_worklet.js", import.meta.url).href;
}
const workletName = "audio-hijacker";
if (typeof AudioWorkletProcessor !== "undefined") {
  class AudioHijackProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      __privateAdd(this, _currentFrame, 0);
      __privateAdd(this, _sampleRate, void 0);
      __privateAdd(this, _targetChannels, void 0);
      __privateSet(this, _sampleRate, options.processorOptions?.sampleRate || globalThis.sampleRate);
      __privateSet(this, _targetChannels, options.processorOptions?.targetChannels || 1);
    }
    process(inputs) {
      if (inputs.length > 1)
        throw new Error("only one input is supported.");
      const channels = inputs[0];
      if (!channels || channels.length === 0 || !channels[0]) {
        return true;
      }
      const inputChannels = channels.length;
      const numberOfFrames = channels[0].length;
      const numberOfChannels = __privateGet(this, _targetChannels);
      const data = new Float32Array(numberOfChannels * numberOfFrames);
      for (let i = 0; i < numberOfChannels; i++) {
        if (i < inputChannels) {
          const inputChannel = channels[i];
          if (inputChannel && inputChannel.length > 0) {
            data.set(inputChannel, i * numberOfFrames);
          } else {
            data.fill(0, i * numberOfFrames, (i + 1) * numberOfFrames);
          }
        } else if (inputChannels > 0) {
          const firstChannel = channels[0];
          if (firstChannel && firstChannel.length > 0) {
            data.set(firstChannel, i * numberOfFrames);
          } else {
            data.fill(0, i * numberOfFrames, (i + 1) * numberOfFrames);
          }
        } else {
          data.fill(0, i * numberOfFrames, (i + 1) * numberOfFrames);
        }
      }
      const init = {
        format: "f32-planar",
        sampleRate: __privateGet(this, _sampleRate),
        numberOfChannels,
        numberOfFrames,
        data,
        timestamp: Math.round(__privateGet(this, _currentFrame) * 1e6 / __privateGet(this, _sampleRate)),
        transfer: [data.buffer]
      };
      this.port.postMessage(init);
      __privateSet(this, _currentFrame, __privateGet(this, _currentFrame) + numberOfFrames);
      return true;
    }
  }
  _currentFrame = new WeakMap();
  _sampleRate = new WeakMap();
  _targetChannels = new WeakMap();
  registerProcessor(workletName, AudioHijackProcessor);
}
export {
  importWorkletUrl,
  workletName
};

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
var _channelsBuffer, _readIndex, _writeIndex;
function importWorkletUrl() {
  return new URL("./audio_offload_worklet.js", import.meta.url).href;
}
const workletName = "audio-offloader";
if (typeof AudioWorkletProcessor !== "undefined") {
  class AudioOffloadProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      __privateAdd(this, _channelsBuffer, []);
      __privateAdd(this, _readIndex, 0);
      __privateAdd(this, _writeIndex, 0);
      if (!options.processorOptions) {
        throw new Error("processorOptions is required");
      }
      const channelCount = options.channelCount;
      if (!channelCount || channelCount <= 0) {
        throw new Error("invalid channelCount");
      }
      const sampleRate = options.processorOptions.sampleRate;
      if (!sampleRate || sampleRate <= 0) {
        throw new Error("invalid sampleRate");
      }
      const latency = options.processorOptions.latency;
      if (!latency || latency <= 0) {
        throw new Error("invalid latency");
      }
      const bufferingSamples = Math.ceil(sampleRate * latency / 1e3);
      for (let i = 0; i < channelCount; i++) {
        __privateGet(this, _channelsBuffer)[i] = new Float32Array(bufferingSamples);
      }
      this.port.onmessage = ({ data }) => {
        this.append(data.channels);
      };
    }
    append(channels) {
      if (!channels.length || !channels[0] || channels[0].length === 0) {
        return;
      }
      if (__privateGet(this, _channelsBuffer) === void 0 || __privateGet(this, _channelsBuffer).length === 0 || __privateGet(this, _channelsBuffer)[0] === void 0)
        return;
      const bufferLength = __privateGet(this, _channelsBuffer)[0].length;
      const numberOfFrames = channels[0].length;
      const discard = __privateGet(this, _writeIndex) - __privateGet(this, _readIndex) + numberOfFrames - bufferLength;
      if (discard > 0) {
        __privateSet(this, _readIndex, __privateGet(this, _readIndex) + discard);
      }
      for (let channel = 0; channel < __privateGet(this, _channelsBuffer).length; channel++) {
        const src = channels[channel];
        const dst = __privateGet(this, _channelsBuffer)[channel];
        if (!dst)
          continue;
        if (!src) {
          const writeStart = __privateGet(this, _writeIndex) % bufferLength;
          const firstPart = Math.min(numberOfFrames, bufferLength - writeStart);
          dst.fill(0, writeStart, writeStart + firstPart);
          if (firstPart < numberOfFrames) {
            dst.fill(0, 0, numberOfFrames - firstPart);
          }
          continue;
        }
        let writePos = __privateGet(this, _writeIndex) % bufferLength;
        let srcOffset = 0;
        while (srcOffset < numberOfFrames) {
          const remaining = numberOfFrames - srcOffset;
          const spaceToEnd = bufferLength - writePos;
          const toCopy = Math.min(remaining, spaceToEnd);
          dst.set(src.subarray(srcOffset, srcOffset + toCopy), writePos);
          srcOffset += toCopy;
          writePos = (writePos + toCopy) % bufferLength;
        }
      }
      __privateSet(this, _writeIndex, __privateGet(this, _writeIndex) + numberOfFrames);
    }
    process(_inputs, outputs) {
      if (outputs === void 0 || outputs.length === 0 || outputs[0] === void 0 || outputs[0]?.length === 0)
        return true;
      if (__privateGet(this, _channelsBuffer).length === 0 || __privateGet(this, _channelsBuffer)[0] === void 0) {
        return true;
      }
      const bufferLength = __privateGet(this, _channelsBuffer)[0].length;
      const available = __privateGet(this, _writeIndex) - __privateGet(this, _readIndex);
      const outputLength = outputs[0][0]?.length ?? 128;
      const numberOfFrames = Math.min(Math.max(0, available), outputLength);
      if (numberOfFrames <= 0) {
        for (const output of outputs) {
          for (const channel of output) {
            if (channel)
              channel.fill(0);
          }
        }
        return true;
      }
      for (const output of outputs) {
        for (let channel = 0; channel < output.length; channel++) {
          const src = __privateGet(this, _channelsBuffer)[channel];
          const dst = output[channel];
          if (!dst)
            continue;
          if (!src) {
            dst.fill(0);
            continue;
          }
          let readPos = __privateGet(this, _readIndex) % bufferLength;
          let dstOffset = 0;
          while (dstOffset < numberOfFrames) {
            const remaining = numberOfFrames - dstOffset;
            const availableToEnd = bufferLength - readPos;
            const toCopy = Math.min(remaining, availableToEnd);
            dst.set(src.subarray(readPos, readPos + toCopy), dstOffset);
            dstOffset += toCopy;
            readPos = (readPos + toCopy) % bufferLength;
          }
          if (dstOffset < dst.length) {
            dst.fill(0, dstOffset);
          }
        }
      }
      __privateSet(this, _readIndex, __privateGet(this, _readIndex) + numberOfFrames);
      return true;
    }
  }
  _channelsBuffer = new WeakMap();
  _readIndex = new WeakMap();
  _writeIndex = new WeakMap();
  registerProcessor(workletName, AudioOffloadProcessor);
}
export {
  importWorkletUrl,
  workletName
};

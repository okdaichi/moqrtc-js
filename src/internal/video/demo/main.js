var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};
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
var __privateWrapper = (obj, member, setter, getter) => ({
  set _(value) {
    __privateSet(obj, member, value, setter);
  },
  get _() {
    return __privateGet(obj, member, getter);
  }
});
var __privateMethod = (obj, member, method) => {
  __accessCheck(obj, member, "access private method");
  return method;
};

// ../video_node.ts
var _inputs, _outputs, _disposed;
var VideoNode = class {
  constructor(options) {
    __publicField(this, "numberOfInputs");
    __publicField(this, "numberOfOutputs");
    __privateAdd(this, _inputs, /* @__PURE__ */ new Set());
    __privateAdd(this, _outputs, /* @__PURE__ */ new Set());
    __privateAdd(this, _disposed, false);
    this.numberOfInputs = options?.numberOfInputs ?? 1;
    this.numberOfOutputs = options?.numberOfOutputs ?? 1;
  }
  /** Connected input nodes (read-only view) */
  get inputs() {
    return __privateGet(this, _inputs);
  }
  /** Connected output nodes (read-only view) */
  get outputs() {
    return __privateGet(this, _outputs);
  }
  /** Whether this node has been disposed */
  get disposed() {
    return __privateGet(this, _disposed);
  }
  connect(destination) {
    if (__privateGet(this, _disposed)) {
      console.warn("[VideoNode] Cannot connect: node is disposed");
      return destination;
    }
    if (destination === this)
      return destination;
    __privateGet(this, _outputs).add(destination);
    __privateGet(destination, _inputs).add(this);
    return destination;
  }
  disconnect(destination) {
    if (destination) {
      __privateGet(this, _outputs).delete(destination);
      __privateGet(destination, _inputs).delete(this);
    } else {
      for (const output of Array.from(__privateGet(this, _outputs))) {
        __privateGet(this, _outputs).delete(output);
        __privateGet(output, _inputs).delete(this);
      }
    }
  }
  dispose() {
    if (__privateGet(this, _disposed))
      return;
    __privateSet(this, _disposed, true);
    this.disconnect();
  }
};
_inputs = new WeakMap();
_outputs = new WeakMap();
_disposed = new WeakMap();

// ../analyse_node.ts
var _brightness, _contrast, _saturation, _colorHistogram, _dominantColors, _sharpness, _edgeStrength, _textureComplexity, _motionMagnitude, _motionDirection, _previousFrameData, _spatialFrequency, _canvas, _ctx, _throttle, _frameCount, _pendingPixelData, _pendingWidth, _pendingHeight, _idleCallbackId, _scheduleAnalysis, scheduleAnalysis_fn, _runDeferredAnalysis, runDeferredAnalysis_fn, _analyzeFrame, analyzeFrame_fn, _calculateBasicStats, calculateBasicStats_fn, _calculateColorHistogram, calculateColorHistogram_fn, _calculateDominantColors, calculateDominantColors_fn, _findHistogramPeaks, findHistogramPeaks_fn, _calculateSpatialFeatures, calculateSpatialFeatures_fn, _calculateSharpness, calculateSharpness_fn, _calculateEdgeStrength, calculateEdgeStrength_fn, _calculateTextureComplexity, calculateTextureComplexity_fn, _calculateMotionFeatures, calculateMotionFeatures_fn, _findBlockMotion, findBlockMotion_fn, _calculateSpatialFrequency, calculateSpatialFrequency_fn;
var VideoAnalyserNode = class extends VideoNode {
  constructor(context, options) {
    super({ numberOfInputs: 1, numberOfOutputs: 1 });
    __privateAdd(this, _scheduleAnalysis);
    __privateAdd(this, _runDeferredAnalysis);
    __privateAdd(this, _analyzeFrame);
    __privateAdd(this, _calculateBasicStats);
    __privateAdd(this, _calculateColorHistogram);
    __privateAdd(this, _calculateDominantColors);
    __privateAdd(this, _findHistogramPeaks);
    __privateAdd(this, _calculateSpatialFeatures);
    __privateAdd(this, _calculateSharpness);
    __privateAdd(this, _calculateEdgeStrength);
    __privateAdd(this, _calculateTextureComplexity);
    __privateAdd(this, _calculateMotionFeatures);
    __privateAdd(this, _findBlockMotion);
    __privateAdd(this, _calculateSpatialFrequency);
    __publicField(this, "context");
    // Basic image statistics
    __privateAdd(this, _brightness, 0);
    __privateAdd(this, _contrast, 0);
    __privateAdd(this, _saturation, 0);
    // Color analysis
    __privateAdd(this, _colorHistogram, void 0);
    __privateAdd(this, _dominantColors, []);
    // Spatial features
    __privateAdd(this, _sharpness, 0);
    __privateAdd(this, _edgeStrength, 0);
    __privateAdd(this, _textureComplexity, 0);
    // Motion features (requires frame comparison)
    __privateAdd(this, _motionMagnitude, 0);
    __privateAdd(this, _motionDirection, 0);
    __privateAdd(this, _previousFrameData, null);
    // Frequency domain features
    __privateAdd(this, _spatialFrequency, void 0);
    // Performance optimization
    __privateAdd(this, _canvas, void 0);
    __privateAdd(this, _ctx, void 0);
    __privateAdd(this, _throttle, void 0);
    __privateAdd(this, _frameCount, 0);
    // Pending pixel data for deferred analysis
    __privateAdd(this, _pendingPixelData, null);
    __privateAdd(this, _pendingWidth, 0);
    __privateAdd(this, _pendingHeight, 0);
    __privateAdd(this, _idleCallbackId, void 0);
    this.context = context;
    this.context._register(this);
    const histogramBins = options?.histogramBins ?? 256;
    __privateSet(this, _colorHistogram, new Uint32Array(histogramBins * 3));
    __privateSet(this, _spatialFrequency, new Float32Array(histogramBins));
    __privateSet(this, _throttle, options?.throttle ?? 1);
  }
  // Basic statistics getters
  get brightness() {
    return __privateGet(this, _brightness);
  }
  get contrast() {
    return __privateGet(this, _contrast);
  }
  get saturation() {
    return __privateGet(this, _saturation);
  }
  // Color analysis getters
  getColorHistogram(array) {
    const length = Math.min(array.length, __privateGet(this, _colorHistogram).length);
    for (let i = 0; i < length; i++) {
      array[i] = __privateGet(this, _colorHistogram)[i] ?? 0;
    }
  }
  getDominantColors() {
    return [...__privateGet(this, _dominantColors)];
  }
  // Spatial features getters
  get sharpness() {
    return __privateGet(this, _sharpness);
  }
  get edgeStrength() {
    return __privateGet(this, _edgeStrength);
  }
  get textureComplexity() {
    return __privateGet(this, _textureComplexity);
  }
  // Motion features getters
  get motionMagnitude() {
    return __privateGet(this, _motionMagnitude);
  }
  get motionDirection() {
    return __privateGet(this, _motionDirection);
  }
  // Frequency domain getters
  getSpatialFrequencyData(array) {
    const length = Math.min(array.length, __privateGet(this, _spatialFrequency).length);
    for (let i = 0; i < length; i++) {
      array[i] = __privateGet(this, _spatialFrequency)[i] ?? 0;
    }
  }
  process(input) {
    if (this.disposed) {
      return;
    }
    const clonedFrame = input.clone();
    __privateWrapper(this, _frameCount)._++;
    if (__privateGet(this, _frameCount) % __privateGet(this, _throttle) === 0) {
      __privateMethod(this, _scheduleAnalysis, scheduleAnalysis_fn).call(this, clonedFrame);
    }
    for (const output of Array.from(this.outputs)) {
      try {
        void output.process(clonedFrame);
      } catch (e) {
        console.error("[VideoAnalyserNode] process error:", e);
      }
    }
    clonedFrame.close();
  }
  // Content detection getters (removed - use separate AI nodes)
  // get hasFaces(): boolean { return this.#hasFaces; }
  // get hasText(): boolean { return this.#hasText; }
  // get sceneChange(): boolean { return this.#sceneChange; }
  dispose() {
    if (this.disposed)
      return;
    __privateSet(this, _previousFrameData, null);
    this.context._unregister(this);
    super.dispose();
  }
};
_brightness = new WeakMap();
_contrast = new WeakMap();
_saturation = new WeakMap();
_colorHistogram = new WeakMap();
_dominantColors = new WeakMap();
_sharpness = new WeakMap();
_edgeStrength = new WeakMap();
_textureComplexity = new WeakMap();
_motionMagnitude = new WeakMap();
_motionDirection = new WeakMap();
_previousFrameData = new WeakMap();
_spatialFrequency = new WeakMap();
_canvas = new WeakMap();
_ctx = new WeakMap();
_throttle = new WeakMap();
_frameCount = new WeakMap();
_pendingPixelData = new WeakMap();
_pendingWidth = new WeakMap();
_pendingHeight = new WeakMap();
_idleCallbackId = new WeakMap();
_scheduleAnalysis = new WeakSet();
scheduleAnalysis_fn = function(frame) {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const sampleWidth = Math.min(width, 320);
  const sampleHeight = Math.min(height, 240);
  const pixelData = new Uint8Array(sampleWidth * sampleHeight * 4);
  try {
    if (!__privateGet(this, _canvas) || __privateGet(this, _canvas).width !== sampleWidth || __privateGet(this, _canvas).height !== sampleHeight) {
      __privateSet(this, _canvas, new OffscreenCanvas(sampleWidth, sampleHeight));
      __privateSet(this, _ctx, __privateGet(this, _canvas).getContext("2d", { willReadFrequently: true }));
    }
    if (!__privateGet(this, _ctx))
      return;
    __privateGet(this, _ctx).drawImage(frame, 0, 0, sampleWidth, sampleHeight);
    const imageData = __privateGet(this, _ctx).getImageData(0, 0, sampleWidth, sampleHeight);
    pixelData.set(imageData.data);
  } catch (_e) {
    return;
  }
  __privateSet(this, _pendingPixelData, pixelData);
  __privateSet(this, _pendingWidth, sampleWidth);
  __privateSet(this, _pendingHeight, sampleHeight);
  if (__privateGet(this, _idleCallbackId) !== void 0) {
    cancelIdleCallback(__privateGet(this, _idleCallbackId));
  }
  __privateSet(this, _idleCallbackId, requestIdleCallback(
    () => __privateMethod(this, _runDeferredAnalysis, runDeferredAnalysis_fn).call(this),
    { timeout: 100 }
    // Max 100ms delay
  ));
};
_runDeferredAnalysis = new WeakSet();
runDeferredAnalysis_fn = function() {
  __privateSet(this, _idleCallbackId, void 0);
  if (!__privateGet(this, _pendingPixelData))
    return;
  const pixelData = __privateGet(this, _pendingPixelData);
  const sampleWidth = __privateGet(this, _pendingWidth);
  const sampleHeight = __privateGet(this, _pendingHeight);
  __privateSet(this, _pendingPixelData, null);
  __privateMethod(this, _calculateBasicStats, calculateBasicStats_fn).call(this, pixelData, sampleWidth, sampleHeight);
  __privateMethod(this, _calculateColorHistogram, calculateColorHistogram_fn).call(this, pixelData, sampleWidth, sampleHeight);
  __privateMethod(this, _calculateDominantColors, calculateDominantColors_fn).call(this);
  __privateMethod(this, _calculateSpatialFeatures, calculateSpatialFeatures_fn).call(this, pixelData, sampleWidth, sampleHeight);
  __privateMethod(this, _calculateMotionFeatures, calculateMotionFeatures_fn).call(this, pixelData, sampleWidth, sampleHeight);
  __privateMethod(this, _calculateSpatialFrequency, calculateSpatialFrequency_fn).call(this, pixelData, sampleWidth, sampleHeight);
};
_analyzeFrame = new WeakSet();
analyzeFrame_fn = function(frame) {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const sampleWidth = Math.min(width, 320);
  const sampleHeight = Math.min(height, 240);
  const sampleStepX = width / sampleWidth;
  const sampleStepY = height / sampleHeight;
  const pixelData = new Uint8Array(sampleWidth * sampleHeight * 4);
  try {
    if (!__privateGet(this, _canvas) || __privateGet(this, _canvas).width !== sampleWidth || __privateGet(this, _canvas).height !== sampleHeight) {
      __privateSet(this, _canvas, new OffscreenCanvas(sampleWidth, sampleHeight));
      __privateSet(this, _ctx, __privateGet(this, _canvas).getContext("2d", { willReadFrequently: true }));
    }
    if (!__privateGet(this, _ctx))
      return;
    __privateGet(this, _ctx).drawImage(frame, 0, 0, sampleWidth, sampleHeight);
    const imageData = __privateGet(this, _ctx).getImageData(
      0,
      0,
      sampleWidth,
      sampleHeight
    );
    pixelData.set(imageData.data);
  } catch (_e) {
    try {
      const fullData = new Uint8Array(width * height * 4);
      frame.copyTo(fullData);
      for (let y = 0; y < sampleHeight; y++) {
        for (let x = 0; x < sampleWidth; x++) {
          const srcX = Math.floor(x * sampleStepX);
          const srcY = Math.floor(y * sampleStepY);
          const srcIdx = (srcY * width + srcX) * 4;
          const dstIdx = (y * sampleWidth + x) * 4;
          if (srcIdx + 3 < fullData.length && dstIdx + 3 < pixelData.length) {
            pixelData[dstIdx] = fullData[srcIdx];
            pixelData[dstIdx + 1] = fullData[srcIdx + 1];
            pixelData[dstIdx + 2] = fullData[srcIdx + 2];
            pixelData[dstIdx + 3] = fullData[srcIdx + 3];
          }
        }
      }
    } catch (fallbackError) {
      console.warn("Failed to analyze frame:", fallbackError);
      return;
    }
  }
  __privateMethod(this, _calculateBasicStats, calculateBasicStats_fn).call(this, pixelData, sampleWidth, sampleHeight);
  __privateMethod(this, _calculateColorHistogram, calculateColorHistogram_fn).call(this, pixelData, sampleWidth, sampleHeight);
  __privateMethod(this, _calculateDominantColors, calculateDominantColors_fn).call(this);
  __privateMethod(this, _calculateSpatialFeatures, calculateSpatialFeatures_fn).call(this, pixelData, sampleWidth, sampleHeight);
  __privateMethod(this, _calculateMotionFeatures, calculateMotionFeatures_fn).call(this, pixelData, sampleWidth, sampleHeight);
  __privateMethod(this, _calculateSpatialFrequency, calculateSpatialFrequency_fn).call(this, pixelData, sampleWidth, sampleHeight);
};
_calculateBasicStats = new WeakSet();
calculateBasicStats_fn = function(pixelData, width, height) {
  let sumBrightness = 0;
  let sumSaturation = 0;
  const pixelCount = width * height;
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    sumBrightness += brightness;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max > 0 ? (max - min) / max : 0;
    sumSaturation += saturation;
  }
  __privateSet(this, _brightness, sumBrightness / pixelCount);
  let sumSquaredDiff = 0;
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    sumSquaredDiff += Math.pow(brightness - __privateGet(this, _brightness), 2);
  }
  __privateSet(this, _contrast, Math.sqrt(sumSquaredDiff / pixelCount));
  __privateSet(this, _saturation, sumSaturation / pixelCount);
};
_calculateColorHistogram = new WeakSet();
calculateColorHistogram_fn = function(pixelData, _width, _height) {
  __privateGet(this, _colorHistogram).fill(0);
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    __privateGet(this, _colorHistogram)[r] = (__privateGet(this, _colorHistogram)[r] ?? 0) + 1;
    __privateGet(this, _colorHistogram)[256 + g] = (__privateGet(this, _colorHistogram)[256 + g] ?? 0) + 1;
    __privateGet(this, _colorHistogram)[512 + b] = (__privateGet(this, _colorHistogram)[512 + b] ?? 0) + 1;
  }
};
_calculateDominantColors = new WeakSet();
calculateDominantColors_fn = function() {
  const peaks = __privateMethod(this, _findHistogramPeaks, findHistogramPeaks_fn).call(this);
  __privateSet(this, _dominantColors, peaks.slice(0, 5).map((peak) => ({
    r: peak.r,
    g: peak.g,
    b: peak.b,
    count: peak.count
  })));
};
_findHistogramPeaks = new WeakSet();
findHistogramPeaks_fn = function() {
  const peaks = [];
  for (let r = 1; r < 255; r++) {
    const countR = __privateGet(this, _colorHistogram)[r] ?? 0;
    if (countR > (__privateGet(this, _colorHistogram)[r - 1] ?? 0) && countR > (__privateGet(this, _colorHistogram)[r + 1] ?? 0)) {
      for (let g = 1; g < 255; g++) {
        const countG = __privateGet(this, _colorHistogram)[256 + g] ?? 0;
        if (countG > (__privateGet(this, _colorHistogram)[256 + g - 1] ?? 0) && countG > (__privateGet(this, _colorHistogram)[256 + g + 1] ?? 0)) {
          for (let b = 1; b < 255; b++) {
            const countB = __privateGet(this, _colorHistogram)[512 + b] ?? 0;
            if (countB > (__privateGet(this, _colorHistogram)[512 + b - 1] ?? 0) && countB > (__privateGet(this, _colorHistogram)[512 + b + 1] ?? 0)) {
              peaks.push({
                r,
                g,
                b,
                count: countR + countG + countB
              });
            }
          }
        }
      }
    }
  }
  return peaks.sort((a, b) => b.count - a.count);
};
_calculateSpatialFeatures = new WeakSet();
calculateSpatialFeatures_fn = function(pixelData, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    gray[i / 4] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  __privateSet(this, _sharpness, __privateMethod(this, _calculateSharpness, calculateSharpness_fn).call(this, gray, width, height));
  __privateSet(this, _edgeStrength, __privateMethod(this, _calculateEdgeStrength, calculateEdgeStrength_fn).call(this, gray, width, height));
  __privateSet(this, _textureComplexity, __privateMethod(this, _calculateTextureComplexity, calculateTextureComplexity_fn).call(this, gray));
};
_calculateSharpness = new WeakSet();
calculateSharpness_fn = function(gray, width, height) {
  let sum = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const laplacian = -4 * gray[idx] + gray[(y - 1) * width + x] + gray[y * width + (x - 1)] + gray[y * width + (x + 1)] + gray[(y + 1) * width + x];
      sum += laplacian * laplacian;
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sum / count) / 128 : 0;
};
_calculateEdgeStrength = new WeakSet();
calculateEdgeStrength_fn = function(gray, width, height) {
  let sum = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx = -1 * gray[(y - 1) * width + (x - 1)] + 1 * gray[(y - 1) * width + (x + 1)] + -2 * gray[y * width + (x - 1)] + 2 * gray[y * width + (x + 1)] + -1 * gray[(y + 1) * width + (x - 1)] + 1 * gray[(y + 1) * width + (x + 1)];
      const gy = -1 * gray[(y - 1) * width + (x - 1)] - 2 * gray[(y - 1) * width + x] - 1 * gray[(y - 1) * width + (x + 1)] + 1 * gray[(y + 1) * width + (x - 1)] + 2 * gray[(y + 1) * width + x] + 1 * gray[(y + 1) * width + (x + 1)];
      sum += Math.sqrt(gx * gx + gy * gy);
      count++;
    }
  }
  return count > 0 ? sum / count / 1442 : 0;
};
_calculateTextureComplexity = new WeakSet();
calculateTextureComplexity_fn = function(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    hist[gray[i]] = (hist[gray[i]] ?? 0) + 1;
  }
  let entropy = 0;
  const total = gray.length;
  for (let i = 0; i < 256; i++) {
    if (hist[i] > 0) {
      const p = hist[i] / total;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy / 8;
};
_calculateMotionFeatures = new WeakSet();
calculateMotionFeatures_fn = function(pixelData, width, height) {
  if (!__privateGet(this, _previousFrameData)) {
    __privateSet(this, _previousFrameData, new Uint8Array(pixelData));
    __privateSet(this, _motionMagnitude, 0);
    __privateSet(this, _motionDirection, 0);
    return;
  }
  let sumDiff = 0;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const blockSize = 8;
  for (let by = 0; by < height - blockSize; by += blockSize) {
    for (let bx = 0; bx < width - blockSize; bx += blockSize) {
      const motion = __privateMethod(this, _findBlockMotion, findBlockMotion_fn).call(this, pixelData, __privateGet(this, _previousFrameData), width, height, bx, by, blockSize);
      if (motion) {
        sumDiff += motion.magnitude;
        sumX += motion.dx;
        sumY += motion.dy;
        count++;
      }
    }
  }
  if (count > 0) {
    __privateSet(this, _motionMagnitude, sumDiff / count / (255 * 3));
    __privateSet(this, _motionDirection, Math.atan2(sumY / count, sumX / count));
  }
  __privateGet(this, _previousFrameData).set(pixelData);
};
_findBlockMotion = new WeakSet();
findBlockMotion_fn = function(curr, prev, width, height, bx, by, blockSize) {
  let minSAD = Infinity;
  let bestDx = 0;
  let bestDy = 0;
  const searchRange = 4;
  for (let dy = -searchRange; dy <= searchRange; dy++) {
    for (let dx = -searchRange; dx <= searchRange; dx++) {
      if (bx + dx < 0 || bx + dx + blockSize >= width || by + dy < 0 || by + dy + blockSize >= height)
        continue;
      let sad = 0;
      for (let y = 0; y < blockSize; y++) {
        for (let x = 0; x < blockSize; x++) {
          const currIdx = ((by + y) * width + (bx + x)) * 4;
          const prevIdx = ((by + dy + y) * width + (bx + dx + x)) * 4;
          const currR = curr[currIdx];
          const currG = curr[currIdx + 1];
          const currB = curr[currIdx + 2];
          const prevR = prev[prevIdx];
          const prevG = prev[prevIdx + 1];
          const prevB = prev[prevIdx + 2];
          sad += Math.abs(currR - prevR) + Math.abs(currG - prevG) + Math.abs(currB - prevB);
        }
      }
      if (sad < minSAD) {
        minSAD = sad;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  return {
    magnitude: Math.sqrt(bestDx * bestDx + bestDy * bestDy),
    dx: bestDx,
    dy: bestDy
  };
};
_calculateSpatialFrequency = new WeakSet();
calculateSpatialFrequency_fn = function(pixelData, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    gray[i / 4] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  const numFreqs = Math.min(__privateGet(this, _spatialFrequency).length, width / 2);
  for (let freq = 0; freq < numFreqs; freq++) {
    let real = 0;
    let imag = 0;
    for (let x = 0; x < width; x++) {
      let rowSum = 0;
      for (let y = 0; y < height; y++) {
        rowSum += gray[y * width + x];
      }
      const avg = rowSum / height;
      const angle = -2 * Math.PI * freq * x / width;
      real += avg * Math.cos(angle);
      imag += avg * Math.sin(angle);
    }
    __privateGet(this, _spatialFrequency)[freq] = Math.sqrt(real * real + imag * imag) / width;
  }
  const maxFreq = Math.max(...__privateGet(this, _spatialFrequency));
  if (maxFreq > 0) {
    for (let i = 0; i < __privateGet(this, _spatialFrequency).length; i++) {
      __privateGet(this, _spatialFrequency)[i] = __privateGet(this, _spatialFrequency)[i] / maxFreq;
    }
  }
};

// ../destination_node.ts
var _animateId, _pendingFrame, _isVisible, _renderFunction, _delayFunc, _renderVideoFrame, renderVideoFrame_fn;
var VideoDestinationNode = class extends VideoNode {
  constructor(context, canvas, options) {
    super({ numberOfInputs: 1, numberOfOutputs: 0 });
    __privateAdd(this, _renderVideoFrame);
    __publicField(this, "canvas");
    __publicField(this, "context");
    __privateAdd(this, _animateId, void 0);
    __privateAdd(this, _pendingFrame, void 0);
    __privateAdd(this, _isVisible, true);
    __privateAdd(this, _renderFunction, void 0);
    __privateAdd(this, _delayFunc, void 0);
    this.context = context;
    this.context._register(this);
    this.canvas = canvas;
    __privateSet(this, _renderFunction, options?.renderFunction ?? VideoRenderFunctions.contain);
  }
  get renderFunction() {
    return __privateGet(this, _renderFunction);
  }
  set renderFunction(fn) {
    __privateSet(this, _renderFunction, fn);
  }
  get delayFunc() {
    return __privateGet(this, _delayFunc);
  }
  set delayFunc(fn) {
    __privateSet(this, _delayFunc, fn);
  }
  get isVisible() {
    return __privateGet(this, _isVisible);
  }
  process(input) {
    if (this.disposed || this.context.state !== "running") {
      return;
    }
    const clonedFrame = input.clone();
    const pendingFrame = __privateGet(this, _pendingFrame);
    __privateSet(this, _pendingFrame, clonedFrame);
    if (pendingFrame) {
      try {
        pendingFrame.close();
      } catch (e) {
        console.error("[VideoDestinationNode] frame close error:", e);
      }
    }
    if (__privateGet(this, _animateId))
      return;
    __privateSet(this, _animateId, requestAnimationFrame(() => {
      __privateSet(this, _animateId, void 0);
      const frame = __privateGet(this, _pendingFrame);
      __privateSet(this, _pendingFrame, void 0);
      void __privateMethod(this, _renderVideoFrame, renderVideoFrame_fn).call(this, frame);
    }));
  }
  setVisible(visible) {
    __privateSet(this, _isVisible, visible);
  }
  dispose() {
    if (this.disposed)
      return;
    if (__privateGet(this, _animateId)) {
      cancelAnimationFrame(__privateGet(this, _animateId));
      __privateSet(this, _animateId, void 0);
    }
    if (__privateGet(this, _pendingFrame)) {
      try {
        __privateGet(this, _pendingFrame).close();
      } catch (e) {
        console.error("[VideoDestinationNode] frame close error:", e);
      } finally {
        __privateSet(this, _pendingFrame, void 0);
      }
    }
    this.context._unregister(this);
    super.dispose();
  }
};
_animateId = new WeakMap();
_pendingFrame = new WeakMap();
_isVisible = new WeakMap();
_renderFunction = new WeakMap();
_delayFunc = new WeakMap();
_renderVideoFrame = new WeakSet();
renderVideoFrame_fn = async function(frame) {
  if (!frame)
    return;
  if (!__privateGet(this, _isVisible)) {
    try {
      frame.close();
    } catch (e) {
      console.error("[VideoDestinationNode] frame close error:", e);
    }
    return;
  }
  if (__privateGet(this, _delayFunc)) {
    try {
      await __privateGet(this, _delayFunc).call(this);
    } catch (error) {
      console.warn("[VideoDestinationNode] delay error:", error);
    }
  }
  const { x, y, width, height } = __privateGet(this, _renderFunction).call(this, frame.displayWidth, frame.displayHeight, this.canvas.width, this.canvas.height);
  const ctx = this.canvas.getContext("2d");
  if (!ctx) {
    try {
      frame.close();
    } catch (_) {
    }
    return;
  }
  ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  ctx.drawImage(frame, x, y, width, height);
  try {
    frame.close();
  } catch (e) {
    console.error("[VideoDestinationNode] frame close error:", e);
  }
};
var VideoRenderFunctions = {
  contain: (frameWidth, frameHeight, canvasWidth, canvasHeight) => {
    const frameAspect = frameWidth / frameHeight;
    const canvasAspect = canvasWidth / canvasHeight;
    if (frameAspect > canvasAspect) {
      const height = canvasWidth / frameAspect;
      const y = (canvasHeight - height) / 2;
      return { x: 0, y, width: canvasWidth, height };
    } else {
      const width = canvasHeight * frameAspect;
      const x = (canvasWidth - width) / 2;
      return { x, y: 0, width, height: canvasHeight };
    }
  },
  cover: (frameWidth, frameHeight, canvasWidth, canvasHeight) => {
    const frameAspect = frameWidth / frameHeight;
    const canvasAspect = canvasWidth / canvasHeight;
    if (frameAspect > canvasAspect) {
      const width = canvasHeight * frameAspect;
      const x = (canvasWidth - width) / 2;
      return { x, y: 0, width, height: canvasHeight };
    } else {
      const height = canvasWidth / frameAspect;
      const y = (canvasHeight - height) / 2;
      return { x: 0, y, width: canvasWidth, height };
    }
  },
  fill: (_frameWidth, _frameHeight, canvasWidth, canvasHeight) => {
    return { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
  },
  scaleDown: (frameWidth, frameHeight, canvasWidth, canvasHeight) => {
    if (frameWidth <= canvasWidth && frameHeight <= canvasHeight) {
      const x = (canvasWidth - frameWidth) / 2;
      const y = (canvasHeight - frameHeight) / 2;
      return { x, y, width: frameWidth, height: frameHeight };
    } else {
      return VideoRenderFunctions.contain(
        frameWidth,
        frameHeight,
        canvasWidth,
        canvasHeight
      );
    }
  }
};

// ../context.ts
var _nodes, _state, _currentTime, _startTime, _pausedTime, _onstatechange, _setState, setState_fn;
var VideoContext = class {
  constructor(options) {
    __privateAdd(this, _setState);
    __publicField(this, "frameRate");
    __publicField(this, "destination");
    __privateAdd(this, _nodes, /* @__PURE__ */ new Set());
    __privateAdd(this, _state, "running");
    __privateAdd(this, _currentTime, 0);
    __privateAdd(this, _startTime, 0);
    __privateAdd(this, _pausedTime, 0);
    __privateAdd(this, _onstatechange, void 0);
    this.frameRate = options?.frameRate ?? 30;
    __privateSet(this, _startTime, performance.now() / 1e3);
    this.destination = new VideoDestinationNode(
      this,
      options?.canvas ?? document.createElement("canvas")
    );
  }
  get state() {
    return __privateGet(this, _state);
  }
  get currentTime() {
    if (__privateGet(this, _state) === "running") {
      return performance.now() / 1e3 - __privateGet(this, _startTime) - __privateGet(this, _pausedTime);
    }
    return __privateGet(this, _currentTime);
  }
  get onstatechange() {
    return __privateGet(this, _onstatechange);
  }
  set onstatechange(callback) {
    __privateSet(this, _onstatechange, callback);
  }
  /** @internal */
  _register(node) {
    __privateGet(this, _nodes).add(node);
  }
  /** @internal */
  _unregister(node) {
    __privateGet(this, _nodes).delete(node);
  }
  resume() {
    if (__privateGet(this, _state) === "closed")
      return Promise.resolve();
    if (__privateGet(this, _state) === "suspended") {
      __privateSet(this, _pausedTime, __privateGet(this, _pausedTime) + (performance.now() / 1e3 - __privateGet(this, _currentTime) - __privateGet(this, _startTime)));
    }
    __privateMethod(this, _setState, setState_fn).call(this, "running");
    return Promise.resolve();
  }
  suspend() {
    if (__privateGet(this, _state) === "closed")
      return Promise.resolve();
    if (__privateGet(this, _state) === "running") {
      __privateSet(this, _currentTime, this.currentTime);
    }
    __privateMethod(this, _setState, setState_fn).call(this, "suspended");
    return Promise.resolve();
  }
  close() {
    if (__privateGet(this, _state) === "closed")
      return Promise.resolve();
    __privateMethod(this, _setState, setState_fn).call(this, "closed");
    for (const node of Array.from(__privateGet(this, _nodes))) {
      try {
        node.dispose();
      } catch (_) {
      }
    }
    __privateGet(this, _nodes).clear();
    return Promise.resolve();
  }
};
_nodes = new WeakMap();
_state = new WeakMap();
_currentTime = new WeakMap();
_startTime = new WeakMap();
_pausedTime = new WeakMap();
_onstatechange = new WeakMap();
_setState = new WeakSet();
setState_fn = function(newState) {
  var _a;
  const oldState = __privateGet(this, _state);
  if (oldState === newState)
    return;
  __privateSet(this, _state, newState);
  try {
    (_a = __privateGet(this, _onstatechange)) == null ? void 0 : _a.call(this, newState);
  } catch (e) {
    console.error("[VideoContext] onstatechange error:", e);
  }
};

// ../decode_node.ts
var _decoder;
var VideoDecodeNode = class extends VideoNode {
  constructor(context) {
    super({ numberOfInputs: 1, numberOfOutputs: 1 });
    __publicField(this, "context");
    __privateAdd(this, _decoder, void 0);
    this.context = context;
    this.context._register(this);
    __privateSet(this, _decoder, new VideoDecoder({
      output: (frame) => {
        this.process(frame);
        frame.close();
      },
      error: (e) => {
        console.error("[VideoDecodeNode] decoder error:", e);
      }
    }));
  }
  get decoderState() {
    return __privateGet(this, _decoder).state;
  }
  get decodeQueueSize() {
    try {
      return __privateGet(this, _decoder).decodeQueueSize;
    } catch (_) {
      return 0;
    }
  }
  configure(config) {
    __privateGet(this, _decoder).configure(config);
  }
  async decodeFrom(stream) {
    let reader;
    try {
      reader = stream.getReader();
      while (this.context.state === "running" && !this.disposed) {
        const { done, value: chunk } = await reader.read();
        if (done)
          break;
        __privateGet(this, _decoder).decode(chunk);
      }
    } catch (e) {
      console.error("[VideoDecodeNode] decodeFrom error:", e);
    } finally {
      reader?.releaseLock();
    }
  }
  process(input) {
    for (const output of Array.from(this.outputs)) {
      try {
        void output.process(input);
      } catch (e) {
        if (e instanceof DOMException && e.name === "InvalidStateError") {
          console.warn("[VideoDecodeNode] Cannot clone closed frame");
        } else {
          console.error("[VideoDecodeNode] process error:", e);
        }
      }
    }
  }
  async flush() {
    try {
      await __privateGet(this, _decoder).flush();
    } catch (e) {
      console.error("[VideoDecodeNode] flush error:", e);
    }
  }
  async close() {
    try {
      await this.flush();
      __privateGet(this, _decoder).close();
    } catch (_) {
    }
  }
  dispose() {
    if (this.disposed)
      return;
    try {
      __privateGet(this, _decoder).close();
    } catch (_) {
    }
    this.context._unregister(this);
    super.dispose();
  }
};
_decoder = new WeakMap();

// ../encode_node.ts
var _encoder, _isKey, _dests;
var VideoEncodeNode = class extends VideoNode {
  constructor(context, options) {
    super({ numberOfInputs: 1, numberOfOutputs: 1 });
    __publicField(this, "context");
    __privateAdd(this, _encoder, void 0);
    __privateAdd(this, _isKey, void 0);
    __privateAdd(this, _dests, /* @__PURE__ */ new Set());
    this.context = context;
    __privateSet(this, _isKey, options?.isKey ?? (() => false));
    this.context._register(this);
    __privateSet(this, _encoder, new VideoEncoder({
      output: async (chunk) => {
        await Promise.allSettled(
          Array.from(__privateGet(this, _dests), (dest) => dest.output(chunk))
        );
      },
      error: (e) => {
        console.error("[VideoEncodeNode] encoder error:", e);
      }
    }));
  }
  get encoderState() {
    return __privateGet(this, _encoder).state;
  }
  get encodeQueueSize() {
    try {
      return __privateGet(this, _encoder).encodeQueueSize;
    } catch (_) {
      return 0;
    }
  }
  configure(config) {
    __privateGet(this, _encoder).configure(config);
  }
  process(input) {
    if (this.disposed) {
      return;
    }
    const clonedFrame = input.clone();
    try {
      __privateGet(this, _encoder).encode(clonedFrame, { keyFrame: __privateGet(this, _isKey).call(this) });
    } catch (e) {
      console.error("[VideoEncodeNode] encode error:", e);
    }
    clonedFrame.close();
  }
  async flush() {
    try {
      await __privateGet(this, _encoder).flush();
    } catch (e) {
      console.error("[VideoEncodeNode] flush error:", e);
    }
  }
  async close() {
    try {
      await this.flush();
      __privateGet(this, _encoder).close();
    } catch (_) {
    }
  }
  dispose() {
    if (this.disposed)
      return;
    try {
      __privateGet(this, _encoder).close();
    } catch (_) {
    }
    this.context._unregister(this);
    super.dispose();
  }
  async encodeTo(dest) {
    __privateGet(this, _dests).add(dest);
    await Promise.allSettled([dest.done]);
    __privateGet(this, _dests).delete(dest);
  }
};
_encoder = new WeakMap();
_isKey = new WeakMap();
_dests = new WeakMap();

// ../overlay_node.ts
var _overlay, _canvas2, _ctx2;
var VideoOverlayNode = class extends VideoNode {
  constructor(options) {
    super({ numberOfInputs: 1, numberOfOutputs: 1 });
    __privateAdd(this, _overlay, void 0);
    __privateAdd(this, _canvas2, void 0);
    __privateAdd(this, _ctx2, void 0);
    __privateSet(this, _overlay, options.overlay);
    __privateSet(this, _canvas2, new OffscreenCanvas(1, 1));
    __privateSet(this, _ctx2, __privateGet(this, _canvas2).getContext("2d"));
  }
  get overlay() {
    return __privateGet(this, _overlay);
  }
  set overlay(fn) {
    __privateSet(this, _overlay, fn);
  }
  /**
   * Composite overlay onto the input VideoFrame and output a new VideoFrame.
   */
  process(input) {
    if (this.disposed) {
      return;
    }
    const clonedFrame = input.clone();
    if (!__privateGet(this, _ctx2)) {
      for (const output of Array.from(this.outputs)) {
        try {
          output.process(clonedFrame);
        } catch (e) {
          console.error("[VideoOverlayNode] process error:", e);
        }
      }
      clonedFrame.close();
      return;
    }
    try {
      const width = clonedFrame.displayWidth;
      const height = clonedFrame.displayHeight;
      if (__privateGet(this, _canvas2).width !== width || __privateGet(this, _canvas2).height !== height) {
        __privateGet(this, _canvas2).width = width;
        __privateGet(this, _canvas2).height = height;
      }
      __privateGet(this, _ctx2).clearRect(0, 0, width, height);
      __privateGet(this, _ctx2).drawImage(clonedFrame, 0, 0, width, height);
      __privateGet(this, _overlay).call(this, __privateGet(this, _ctx2), __privateGet(this, _canvas2));
      const outputFrame = new VideoFrame(__privateGet(this, _canvas2), {
        timestamp: clonedFrame.timestamp,
        duration: clonedFrame.duration ?? void 0
      });
      clonedFrame.close();
      for (const output of Array.from(this.outputs)) {
        try {
          output.process(outputFrame);
        } catch (e) {
          if (e instanceof DOMException && e.name === "InvalidStateError") {
            console.warn("[VideoOverlayNode] Cannot clone closed frame");
          } else {
            console.error("[VideoOverlayNode] process error:", e);
          }
        }
      }
      outputFrame.close();
    } catch (e) {
      console.error("[VideoOverlayNode] overlay composition error:", e);
    }
  }
};
_overlay = new WeakMap();
_canvas2 = new WeakMap();
_ctx2 = new WeakMap();

// ../source_node.ts
var _stream, _running, _reader, _releaseReader, releaseReader_fn;
var VideoSourceNode = class extends VideoNode {
  constructor(context, stream) {
    super({ numberOfInputs: 0, numberOfOutputs: 1 });
    __privateAdd(this, _releaseReader);
    __publicField(this, "context");
    __privateAdd(this, _stream, void 0);
    __privateAdd(this, _running, false);
    __privateAdd(this, _reader, void 0);
    this.context = context;
    __privateSet(this, _stream, stream);
    this.context._register(this);
  }
  /** @internal Accessor for subclasses */
  get _stream() {
    return __privateGet(this, _stream);
  }
  get running() {
    return __privateGet(this, _running);
  }
  process(input) {
    if (this.disposed)
      return;
    for (const output of Array.from(this.outputs)) {
      try {
        output.process(input);
      } catch (e) {
        if (e instanceof DOMException && e.name === "InvalidStateError") {
          console.warn("[VideoSourceNode] Cannot clone closed frame");
        } else {
          console.error("[VideoSourceNode] process error:", e);
        }
      }
    }
  }
  async start() {
    if (__privateGet(this, _running) || this.disposed)
      return;
    __privateSet(this, _running, true);
    try {
      __privateSet(this, _reader, __privateGet(this, _stream).getReader());
      while (__privateGet(this, _running) && this.context.state === "running") {
        const { done, value: frame } = await __privateGet(this, _reader).read();
        if (done)
          break;
        this.process(frame);
        frame.close();
      }
    } catch (e) {
      console.error("[VideoSourceNode] read error:", e);
    } finally {
      __privateSet(this, _running, false);
      __privateMethod(this, _releaseReader, releaseReader_fn).call(this);
    }
  }
  stop() {
    __privateSet(this, _running, false);
  }
  dispose() {
    if (this.disposed)
      return;
    this.stop();
    __privateMethod(this, _releaseReader, releaseReader_fn).call(this);
    this.context._unregister(this);
    super.dispose();
  }
};
_stream = new WeakMap();
_running = new WeakMap();
_reader = new WeakMap();
_releaseReader = new WeakSet();
releaseReader_fn = function() {
  if (__privateGet(this, _reader)) {
    try {
      __privateGet(this, _reader).releaseLock();
    } catch (_) {
    }
    __privateSet(this, _reader, void 0);
  }
};
var MediaStreamVideoSourceNode = class extends VideoSourceNode {
  constructor(track, context) {
    const settings = track.getSettings();
    const frameRate = settings?.frameRate ?? 30;
    const videoContext = context ?? new VideoContext({ frameRate });
    let stream;
    if ("MediaStreamTrackProcessor" in globalThis) {
      stream = new globalThis.MediaStreamTrackProcessor({ track }).readable;
    } else {
      console.warn(
        "[MediaStreamVideoSourceNode] MediaStreamTrackProcessor not available; using polyfill"
      );
      if (!settings) {
        throw new Error("[MediaStreamVideoSourceNode] track has no settings");
      }
      const video = document.createElement("video");
      let lastTimestamp = performance.now();
      stream = new ReadableStream({
        async start() {
          video.srcObject = new MediaStream([track]);
          await Promise.all([
            video.play(),
            new Promise((resolve) => {
              video.onloadedmetadata = () => resolve();
            })
          ]);
          lastTimestamp = performance.now();
        },
        async pull(controller) {
          const frameInterval = 1e3 / frameRate;
          while (performance.now() - lastTimestamp < frameInterval) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          lastTimestamp = performance.now();
          controller.enqueue(
            new VideoFrame(video, {
              timestamp: lastTimestamp * 1e3
            })
          );
        },
        cancel() {
          video.srcObject = null;
        }
      });
    }
    super(videoContext, stream);
    __publicField(this, "track");
    this.track = track;
  }
  dispose() {
    if (this.disposed)
      return;
    this.stop();
    this.track.stop();
    try {
      void this._stream.cancel();
    } catch (_) {
    }
    super.dispose();
  }
};

// ../support.ts
var isChrome = navigator.userAgent.toLowerCase().includes("chrome");
var isFirefox = navigator.userAgent.toLowerCase().includes("firefox");

// ../video_config.ts
var VIDEO_HARDWARE_CODECS = [
  "vp09.00.10.08",
  "vp09",
  "avc1.640028",
  "avc1.4D401F",
  "avc1.42E01E",
  "avc1",
  "av01.0.08M.08",
  "av01",
  "hev1.1.6.L93.B0",
  "hev1",
  "vp8"
];
var VIDEO_SOFTWARE_CODECS = [
  "avc1.640028",
  "avc1.4D401F",
  "avc1.42E01E",
  "avc1",
  "vp8",
  "vp09.00.10.08",
  "vp09",
  "hev1.1.6.L93.B0",
  "hev1",
  "av01.0.08M.08",
  "av01"
];
async function videoEncoderConfig(options) {
  const width = options.width;
  const height = options.height;
  const frameRate = options.frameRate;
  const tryHardware = options.tryHardware ?? true;
  const hardwareCodecs = VIDEO_HARDWARE_CODECS;
  const softwareCodecs = VIDEO_SOFTWARE_CODECS;
  const pixels = width * height;
  const framerateFactor = 30 + (frameRate - 30) / 2;
  const calculatedBitrate = Math.round(pixels * 0.07 * framerateFactor);
  const bitrate = options?.bitrate ?? calculatedBitrate;
  const baseConfig = {
    codec: "none",
    width,
    height,
    bitrate,
    latencyMode: "realtime",
    framerate: frameRate
  };
  if (tryHardware && !isFirefox) {
    for (const codec of hardwareCodecs) {
      const config = upgradeEncoderConfig(
        baseConfig,
        codec,
        bitrate,
        true
      );
      const { supported, config: hardwareConfig } = await VideoEncoder.isConfigSupported(
        config
      );
      if (supported && hardwareConfig) {
        console.debug("using hardware encoding: ", hardwareConfig);
        return hardwareConfig;
      }
    }
  } else if (tryHardware && isFirefox) {
    console.warn("Cannot detect hardware encoding on Firefox.");
  }
  for (const codec of softwareCodecs) {
    const config = upgradeEncoderConfig(baseConfig, codec, bitrate, false);
    const { supported, config: softwareConfig } = await VideoEncoder.isConfigSupported(config);
    if (supported && softwareConfig) {
      console.debug("using software encoding: ", softwareConfig);
      return softwareConfig;
    }
  }
  throw new Error("no supported codec");
}
function upgradeEncoderConfig(base, codec, bitrate, hardware) {
  const config = {
    ...base,
    codec,
    hardwareAcceleration: hardware ? "prefer-hardware" : void 0
  };
  if (config.codec.startsWith("avc1")) {
    config.avc = { format: "annexb" };
  } else if (config.codec.startsWith("hev1")) {
    config.hevc = { format: "annexb" };
  } else if (config.codec.startsWith("vp09")) {
    config.bitrate = bitrate * 0.8;
  } else if (config.codec.startsWith("av01")) {
    config.bitrate = bitrate * 0.6;
  } else if (config.codec === "vp8") {
    config.bitrate = bitrate * 1.1;
  }
  return config;
}

// main.ts
var pipeline = {
  sourceNode: null,
  analyserNode: null,
  encodeNode: null,
  decodeNode: null,
  overlayNode: null,
  outputContext: null,
  stream: null,
  running: false
};
var metrics = {
  encodedFrames: 0,
  decodedFrames: 0,
  encodeQueueSize: 0,
  decodeQueueSize: 0,
  startTime: 0,
  fps: 0
};
var DEBUG_METRICS = false;
var UI_UPDATE_INTERVAL_MS = 250;
function safeGetEncodeQueueSize() {
  try {
    return pipeline.encodeNode?.encodeQueueSize ?? 0;
  } catch {
    return 0;
  }
}
function safeGetDecodeQueueSize() {
  try {
    return pipeline.decodeNode?.decodeQueueSize ?? 0;
  } catch {
    return 0;
  }
}
function getOverlayText() {
  const encQ = safeGetEncodeQueueSize();
  const decQ = safeGetDecodeQueueSize();
  return `enc ${metrics.encodedFrames} | dec ${metrics.decodedFrames} | q ${encQ}/${decQ}`;
}
var elements = {
  status: () => document.getElementById("status"),
  encodedFrames: () => document.getElementById("encodedFrames"),
  decodedFrames: () => document.getElementById("decodedFrames"),
  encodeQueue: () => document.getElementById("encodeQueue"),
  decodeQueue: () => document.getElementById("decodeQueue"),
  codecConfig: () => document.getElementById("codecConfig"),
  sourceCanvas: () => document.getElementById("sourceCanvas"),
  outputCanvas: () => document.getElementById("outputCanvas"),
  brightness: () => document.getElementById("brightness"),
  contrast: () => document.getElementById("contrast"),
  saturation: () => document.getElementById("saturation"),
  dominantColor: () => document.getElementById("dominantColor"),
  colorBar: () => document.getElementById("colorBar"),
  startCameraBtn: () => document.getElementById("startCameraBtn"),
  startScreenBtn: () => document.getElementById("startScreenBtn"),
  stopBtn: () => document.getElementById("stopBtn")
};
function setStatus(message, type = "info") {
  const el = elements.status();
  if (el) {
    el.className = `status ${type}`;
    el.textContent = message;
  }
}
function renderMetrics() {
  const encodedEl = elements.encodedFrames();
  const decodedEl = elements.decodedFrames();
  const encodeQueueEl = elements.encodeQueue();
  const decodeQueueEl = elements.decodeQueue();
  if (encodedEl)
    encodedEl.textContent = metrics.encodedFrames.toString();
  if (decodedEl)
    decodedEl.textContent = metrics.decodedFrames.toString();
  if (encodeQueueEl) {
    encodeQueueEl.textContent = metrics.encodeQueueSize.toString();
  }
  if (decodeQueueEl) {
    decodeQueueEl.textContent = metrics.decodeQueueSize.toString();
  }
}
function updateButtons(running) {
  const startCameraBtn = elements.startCameraBtn();
  const startScreenBtn = elements.startScreenBtn();
  const stopBtn = elements.stopBtn();
  if (startCameraBtn)
    startCameraBtn.disabled = running;
  if (startScreenBtn)
    startScreenBtn.disabled = running;
  if (stopBtn)
    stopBtn.disabled = !running;
}
function collectMetrics() {
  if (pipeline.encodeNode) {
    try {
      metrics.encodeQueueSize = pipeline.encodeNode.encodeQueueSize;
    } catch (_e) {
      metrics.encodeQueueSize = 0;
    }
  }
  if (pipeline.decodeNode) {
    try {
      metrics.decodeQueueSize = pipeline.decodeNode.decodeQueueSize;
    } catch (_e) {
      metrics.decodeQueueSize = 0;
    }
  }
  if (metrics.startTime > 0) {
    const elapsed = (performance.now() - metrics.startTime) / 1e3;
    if (elapsed > 0) {
      metrics.fps = Math.round(metrics.encodedFrames / elapsed);
    }
  }
}
var analysisLoopRunning = false;
function startAnalysisLoop() {
  if (analysisLoopRunning)
    return;
  analysisLoopRunning = true;
  updateAnalysis();
}
function stopAnalysisLoop() {
  analysisLoopRunning = false;
}
function updateAnalysis() {
  if (!analysisLoopRunning || !pipeline.analyserNode)
    return;
  try {
    const brightness = pipeline.analyserNode.brightness;
    const contrast = pipeline.analyserNode.contrast;
    const saturation = pipeline.analyserNode.saturation;
    const dominantColors = pipeline.analyserNode.getDominantColors();
    const brightnessEl = elements.brightness();
    if (brightnessEl)
      brightnessEl.textContent = brightness.toFixed(2);
    const contrastEl = elements.contrast();
    if (contrastEl)
      contrastEl.textContent = contrast.toFixed(2);
    const saturationEl = elements.saturation();
    if (saturationEl)
      saturationEl.textContent = saturation.toFixed(2);
    const dominantColorEl = elements.dominantColor();
    if (dominantColorEl && dominantColors && dominantColors.length > 0) {
      const color = dominantColors[0];
      dominantColorEl.style.backgroundColor = `rgb(${color.r}, ${color.g}, ${color.b})`;
    }
    const colorBarEl = elements.colorBar();
    if (colorBarEl && dominantColors) {
      colorBarEl.innerHTML = "";
      for (let i = 0; i < Math.min(5, dominantColors.length); i++) {
        const color = dominantColors[i];
        const colorDiv = document.createElement("div");
        colorDiv.className = "color-block";
        colorDiv.style.backgroundColor = `rgb(${color.r}, ${color.g}, ${color.b})`;
        colorBarEl.appendChild(colorDiv);
      }
    }
  } catch (e) {
    console.warn("Analysis update error:", e);
  }
  setTimeout(() => updateAnalysis(), 500);
}
async function startPipeline(sourceType) {
  if (pipeline.running) {
    console.warn("Pipeline already running");
    return;
  }
  try {
    metrics.encodedFrames = 0;
    metrics.decodedFrames = 0;
    metrics.encodeQueueSize = 0;
    metrics.decodeQueueSize = 0;
    metrics.startTime = performance.now();
    metrics.fps = 0;
    renderMetrics();
    const emoji = sourceType === "camera" ? "\u{1F3A5}" : "\u{1F5A5}\uFE0F";
    const label = sourceType === "camera" ? "camera" : "screen";
    setStatus(`${emoji} Requesting ${label} access...`, "info");
    pipeline.stream = await getMediaStream(sourceType);
    const track = pipeline.stream.getVideoTracks()[0];
    if (!track)
      throw new Error("No video track found");
    setStatus("\u2699\uFE0F Initializing video pipeline...", "info");
    const sourceContext = new VideoContext({
      frameRate: 30,
      canvas: elements.sourceCanvas()
    });
    pipeline.sourceNode = new MediaStreamVideoSourceNode(track, sourceContext);
    pipeline.sourceNode.connect(sourceContext.destination);
    pipeline.analyserNode = new VideoAnalyserNode(sourceContext, {
      throttle: 10
      // Analyze every 10th frame (~3fps at 30fps) to reduce CPU load
    });
    pipeline.sourceNode.connect(pipeline.analyserNode);
    startAnalysisLoop();
    const encoderConfig = await videoEncoderConfig({
      width: 1280,
      height: 720,
      frameRate: 30
    });
    pipeline.encodeNode = new VideoEncodeNode(sourceContext);
    pipeline.encodeNode.configure(encoderConfig);
    pipeline.sourceNode.connect(pipeline.encodeNode);
    pipeline.outputContext = new VideoContext({
      frameRate: 30,
      canvas: elements.outputCanvas()
    });
    pipeline.decodeNode = new VideoDecodeNode(pipeline.outputContext);
    pipeline.decodeNode.configure({
      codec: encoderConfig.codec,
      codedWidth: encoderConfig.width,
      codedHeight: encoderConfig.height
    });
    let lastText = "";
    let lastMeasuredWidth = 0;
    let lastUiUpdateMs = 0;
    const overlayDraw = (ctx, canvas) => {
      const now = performance.now();
      if (now - lastUiUpdateMs >= UI_UPDATE_INTERVAL_MS) {
        lastUiUpdateMs = now;
        try {
          collectMetrics();
          renderMetrics();
        } catch (e) {
          if (DEBUG_METRICS)
            console.warn("[metrics] update error:", e);
        }
      }
      const text = getOverlayText();
      if (!text)
        return;
      ctx.save();
      ctx.font = "16px monospace";
      ctx.textBaseline = "top";
      const padding = 8;
      const x = 10;
      const y = 10;
      if (text !== lastText) {
        lastText = text;
        lastMeasuredWidth = Math.ceil(ctx.measureText(text).width);
      }
      const metricsWidth = Math.min(
        canvas.width - 20,
        lastMeasuredWidth + padding * 2
      );
      const height = 24 + padding;
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(x, y, metricsWidth, height);
      ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
      ctx.fillText(text, x + padding, y + padding);
      ctx.restore();
    };
    pipeline.overlayNode = new VideoOverlayNode({ overlay: overlayDraw });
    pipeline.decodeNode.connect(pipeline.overlayNode);
    pipeline.overlayNode.connect(pipeline.outputContext.destination);
    const outputDestinationNode = pipeline.outputContext.destination;
    const originalProcess = outputDestinationNode.process.bind(
      outputDestinationNode
    );
    outputDestinationNode.process = (frame) => {
      metrics.decodedFrames++;
      originalProcess(frame);
    };
    const { readable, writable } = new TransformStream();
    const destination = {
      output: async (chunk) => {
        metrics.encodedFrames++;
        const writer = writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
      },
      done: new Promise(() => {
      })
      // Never resolves
    };
    void pipeline.encodeNode.encodeTo(destination);
    void pipeline.decodeNode.decodeFrom(readable);
    await pipeline.sourceNode.start();
    pipeline.running = true;
    collectMetrics();
    renderMetrics();
    setStatus(`\u2705 Pipeline running! Source: ${track.label}`, "success");
    updateButtons(true);
  } catch (error) {
    handleError(error);
    stopPipeline();
  }
}
function stopPipeline() {
  pipeline.running = false;
  stopAnalysisLoop();
  collectMetrics();
  renderMetrics();
  if (pipeline.stream) {
    pipeline.stream.getTracks().forEach((track) => track.stop());
    pipeline.stream = null;
  }
  if (pipeline.sourceNode) {
    pipeline.sourceNode.dispose();
    pipeline.sourceNode = null;
  }
  if (pipeline.analyserNode) {
    pipeline.analyserNode.dispose();
    pipeline.analyserNode = null;
  }
  if (pipeline.encodeNode) {
    void pipeline.encodeNode.close().catch(() => {
    });
    pipeline.encodeNode.dispose();
    pipeline.encodeNode = null;
  }
  if (pipeline.decodeNode) {
    void pipeline.decodeNode.close().catch(() => {
    });
    pipeline.decodeNode.dispose();
    pipeline.decodeNode = null;
  }
  if (pipeline.overlayNode) {
    pipeline.overlayNode.dispose();
    pipeline.overlayNode = null;
  }
  if (pipeline.outputContext) {
    void pipeline.outputContext.close();
    pipeline.outputContext = null;
  }
  updateButtons(false);
  setStatus("\u23F9\uFE0F Pipeline stopped", "info");
}
async function getMediaStream(sourceType) {
  if (!navigator.mediaDevices) {
    throw new Error("mediaDevices API is not supported");
  }
  if (sourceType === "screen") {
    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error("Screen sharing is not supported");
    }
    return navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      }
    });
  }
  if (!navigator.mediaDevices.getUserMedia) {
    throw new Error("Camera access is not supported");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      }
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({ video: true });
  }
}
function handleError(error) {
  let message = error.message;
  switch (error.name) {
    case "NotFoundError":
      message = "Camera not found. Please connect a camera.";
      break;
    case "NotAllowedError":
    case "PermissionDeniedError":
      message = "Permission denied. Please allow access and reload.";
      break;
    case "NotReadableError":
      message = "Device is in use by another application.";
      break;
  }
  setStatus(`\u274C ${message}`, "error");
  console.error("Pipeline error:", error);
}
async function loadCodecConfig() {
  try {
    const config = await videoEncoderConfig({
      width: 1280,
      height: 720,
      frameRate: 30
    });
    const el = elements.codecConfig();
    if (el)
      el.textContent = JSON.stringify(config, null, 2);
  } catch (error) {
    const el = elements.codecConfig();
    if (el)
      el.textContent = `Error: ${error.message}`;
  }
}
function init() {
  elements.startCameraBtn()?.addEventListener(
    "click",
    () => startPipeline("camera")
  );
  elements.startScreenBtn()?.addEventListener(
    "click",
    () => startPipeline("screen")
  );
  elements.stopBtn()?.addEventListener("click", stopPipeline);
  loadCodecConfig();
  if (!("VideoEncoder" in window)) {
    setStatus("\u26A0\uFE0F WebCodecs API not supported. Use Chrome/Edge.", "error");
    updateButtons(true);
    elements.stopBtn().disabled = true;
  }
  renderMetrics();
}
init();

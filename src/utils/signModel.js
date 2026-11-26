/**
 * SignSpeak Neural Network Inference Engine
 * Plain JavaScript implementation of trained Keras model:
 * Conv1D(128, kernel 3, same, relu) -> BatchNorm(eps=0.001) -> BiGRU(128, reset_after=true) -> Dense(128, relu) -> Dense(23, softmax)
 * No TensorFlow / external ML library required.
 */

function sigmoid(x) {
  // Numerically stable sigmoid
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  } else {
    const z = Math.exp(x);
    return z / (1 + z);
  }
}

/**
 * Preprocesses model weights from JSON to optimized typed structures
 */
export function prepareModel(rawLayers) {
  // Layer 0: Conv1D [kernel (3, 138, 128), bias (128)]
  const convLayer = rawLayers[0];
  const [cKernel, cBias] = convLayer.weights;

  // Layer 1: BatchNormalization [gamma, beta, moving_mean, moving_variance]
  const bnLayer = rawLayers[1];
  const [gamma, beta, mean, variance] = bnLayer.weights;
  const eps = 0.001;
  const bnScale = new Float32Array(128);
  const bnOffset = new Float32Array(128);
  for (let f = 0; f < 128; f++) {
    const std = Math.sqrt(variance[f] + eps);
    const s = gamma[f] / std;
    bnScale[f] = s;
    bnOffset[f] = beta[f] - mean[f] * s;
  }

  // Layer 2: Bidirectional GRU
  // Forward: [kernel (128, 384), rec_kernel (128, 384), bias (2, 384)]
  // Backward: [kernel (128, 384), rec_kernel (128, 384), bias (2, 384)]
  const bgruLayer = rawLayers[2];
  const [
    fKernel, fRecKernel, fBias,
    bKernel, bRecKernel, bBias
  ] = bgruLayer.weights;

  // Layer 4: Dense(128, relu) [kernel (256, 128), bias (128)]
  const d1Layer = rawLayers[4];
  const [d1Kernel, d1Bias] = d1Layer.weights;

  // Layer 5: Dense(23, softmax) [kernel (128, 23), bias (23)]
  const d2Layer = rawLayers[5];
  const [d2Kernel, d2Bias] = d2Layer.weights;

  return {
    conv: { kernel: cKernel, bias: cBias },
    bn: { scale: bnScale, offset: bnOffset },
    gruForward: { kernel: fKernel, recKernel: fRecKernel, bias0: fBias[0], bias1: fBias[1] },
    gruBackward: { kernel: bKernel, recKernel: bRecKernel, bias0: bBias[0], bias1: bBias[1] },
    dense1: { kernel: d1Kernel, bias: d1Bias },
    dense2: { kernel: d2Kernel, bias: d2Bias }
  };
}

/**
 * Run single GRU direction over sequence of length 32
 * Gate order: z, r, h
 * x_part = x @ kernel + bias[0]
 * h_part = h_prev @ rec_kernel + bias[1]
 * z = sigmoid(x_z + h_z)
 * r = sigmoid(x_r + h_r)
 * hh = tanh(x_h + r * h_h)
 * h = z * h_prev + (1 - z) * hh
 */
function runGruDirection(seq, gruWeights, reverse = false) {
  const { kernel, recKernel, bias0, bias1 } = gruWeights;
  let h = new Float32Array(128); // Initial state all zeros

  const seqLen = 32;
  const xPart = new Float32Array(384);
  const hPart = new Float32Array(384);

  for (let step = 0; step < seqLen; step++) {
    const t = reverse ? seqLen - 1 - step : step;
    const x = seq[t];

    // Compute x_part (length 384)
    for (let j = 0; j < 384; j++) {
      let sum = bias0[j];
      for (let i = 0; i < 128; i++) {
        sum += x[i] * kernel[i][j];
      }
      xPart[j] = sum;
    }

    // Compute h_part (length 384)
    for (let j = 0; j < 384; j++) {
      let sum = bias1[j];
      for (let i = 0; i < 128; i++) {
        sum += h[i] * recKernel[i][j];
      }
      hPart[j] = sum;
    }

    // Next hidden state (length 128)
    const hNext = new Float32Array(128);
    for (let u = 0; u < 128; u++) {
      const z = sigmoid(xPart[u] + hPart[u]);
      const r = sigmoid(xPart[128 + u] + hPart[128 + u]);
      const hh = Math.tanh(xPart[256 + u] + r * hPart[256 + u]);
      hNext[u] = z * h[u] + (1 - z) * hh;
    }
    h = hNext;
  }

  return h;
}

/**
 * Predict sign word from 32 frames of 138 features
 * @param {Array<Array<number>>} frames32x138 Array of 32 frames, each with 138 numbers
 * @param {Object} model Prepared model weights
 * @param {Array<string>} labels Array of 23 label strings
 * @returns {{ predictions: Array<{word: string, confidence: number, index: number}>, top1: {word: string, confidence: number, index: number} }}
 */
export function predictSign(frames32x138, model, labels) {
  if (!frames32x138 || frames32x138.length !== 32) {
    throw new Error(`Expected 32 frames, got ${frames32x138 ? frames32x138.length : 0}`);
  }

  // 1. Conv1D(128, kernel 3, padding 'same', relu)
  // Input: 32 x 138 -> Output: 32 x 128
  const { kernel: cKernel, bias: cBias } = model.conv;
  const convOut = Array.from({ length: 32 }, () => new Float32Array(128));

  for (let t = 0; t < 32; t++) {
    for (let f = 0; f < 128; f++) {
      let sum = cBias[f];
      for (let k = 0; k < 3; k++) {
        const inT = t + k - 1; // Center at k=1
        if (inT >= 0 && inT < 32) {
          const inFrame = frames32x138[inT];
          const kWeights = cKernel[k];
          for (let c = 0; c < 138; c++) {
            sum += inFrame[c] * kWeights[c][f];
          }
        }
      }
      convOut[t][f] = sum > 0 ? sum : 0; // ReLU
    }
  }

  // 2. Batch Normalization (eps = 0.001)
  // Input: 32 x 128 -> Output: 32 x 128
  const { scale: bnScale, offset: bnOffset } = model.bn;
  const bnOut = Array.from({ length: 32 }, () => new Float32Array(128));

  for (let f = 0; f < 128; f++) {
    const s = bnScale[f];
    const o = bnOffset[f];
    for (let t = 0; t < 32; t++) {
      bnOut[t][f] = convOut[t][f] * s + o;
    }
  }

  // 3. Bidirectional GRU (128 units, reset_after=true)
  // Forward state: 128, Backward state: 128 -> Concatenated: 256
  const forwardFinal = runGruDirection(bnOut, model.gruForward, false);
  const backwardFinal = runGruDirection(bnOut, model.gruBackward, true);

  const gruConcat = new Float32Array(256);
  gruConcat.set(forwardFinal, 0);
  gruConcat.set(backwardFinal, 128);

  // 4. Dense(128, relu)
  // Input: 256 -> Output: 128
  const { kernel: d1Kernel, bias: d1Bias } = model.dense1;
  const d1Out = new Float32Array(128);
  for (let j = 0; j < 128; j++) {
    let sum = d1Bias[j];
    for (let i = 0; i < 256; i++) {
      sum += gruConcat[i] * d1Kernel[i][j];
    }
    d1Out[j] = sum > 0 ? sum : 0; // ReLU
  }

  // 5. Dense(23, softmax)
  // Input: 128 -> Output: 23
  const { kernel: d2Kernel, bias: d2Bias } = model.dense2;
  const numClasses = labels.length;
  const logits = new Float32Array(numClasses);
  let maxLogit = -Infinity;

  for (let j = 0; j < numClasses; j++) {
    let sum = d2Bias[j];
    for (let i = 0; i < 128; i++) {
      sum += d1Out[i] * d2Kernel[i][j];
    }
    logits[j] = sum;
    if (sum > maxLogit) {
      maxLogit = sum;
    }
  }

  // Softmax
  let sumExps = 0;
  const exps = new Float32Array(numClasses);
  for (let j = 0; j < numClasses; j++) {
    const e = Math.exp(logits[j] - maxLogit);
    exps[j] = e;
    sumExps += e;
  }

  const predictions = [];
  const rawProbs = new Float32Array(numClasses);
  for (let j = 0; j < numClasses; j++) {
    const confidence = sumExps > 0 ? exps[j] / sumExps : 0;
    rawProbs[j] = confidence;
    predictions.push({
      word: labels[j] || `word_${j}`,
      confidence,
      index: j
    });
  }

  // Sort descending by confidence
  predictions.sort((a, b) => b.confidence - a.confidence);

  return {
    predictions,
    top1: predictions[0],
    rawProbs
  };
}

/**
 * Loads labels.json and model_weights.json from public directory
 */
export async function loadModelAssets() {
  const [labelsRes, weightsRes] = await Promise.all([
    fetch('/labels.json'),
    fetch('/model_weights.json')
  ]);

  if (!labelsRes.ok) {
    throw new Error(`Failed to load labels.json (${labelsRes.status} ${labelsRes.statusText})`);
  }
  if (!weightsRes.ok) {
    throw new Error(`Failed to load model_weights.json (${weightsRes.status} ${weightsRes.statusText})`);
  }

  const labels = await labelsRes.json();
  const rawWeights = await weightsRes.json();
  const prepared = prepareModel(rawWeights);

  return { labels, model: prepared };
}

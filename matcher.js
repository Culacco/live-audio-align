const DEFAULT_BANDS = [
  [80, 180],
  [180, 350],
  [350, 700],
  [700, 1400],
  [1400, 2600],
  [2600, 3900]
];

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function fft(real, imag) {
  const length = real.length;
  let bitReversed = 0;

  for (let index = 1; index < length; index += 1) {
    let bit = length >> 1;
    while (bitReversed & bit) {
      bitReversed ^= bit;
      bit >>= 1;
    }
    bitReversed ^= bit;
    if (index < bitReversed) {
      [real[index], real[bitReversed]] = [real[bitReversed], real[index]];
      [imag[index], imag[bitReversed]] = [imag[bitReversed], imag[index]];
    }
  }

  for (let size = 2; size <= length; size *= 2) {
    const angle = (-2 * Math.PI) / size;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);

    for (let offset = 0; offset < length; offset += size) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      const half = size / 2;

      for (let index = 0; index < half; index += 1) {
        const evenIndex = offset + index;
        const oddIndex = evenIndex + half;
        const oddReal =
          real[oddIndex] * twiddleReal - imag[oddIndex] * twiddleImag;
        const oddImag =
          real[oddIndex] * twiddleImag + imag[oddIndex] * twiddleReal;
        const evenReal = real[evenIndex];
        const evenImag = imag[evenIndex];

        real[evenIndex] = evenReal + oddReal;
        imag[evenIndex] = evenImag + oddImag;
        real[oddIndex] = evenReal - oddReal;
        imag[oddIndex] = evenImag - oddImag;

        const nextReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / samples.length);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function standardize(features, dimensions) {
  const frameCount = features.length / dimensions;
  const means = new Float64Array(dimensions);
  const deviations = new Float64Array(dimensions);

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let band = 0; band < dimensions; band += 1) {
      means[band] += features[frame * dimensions + band];
    }
  }
  for (let band = 0; band < dimensions; band += 1) means[band] /= frameCount;

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let band = 0; band < dimensions; band += 1) {
      const difference = features[frame * dimensions + band] - means[band];
      deviations[band] += difference * difference;
    }
  }
  for (let band = 0; band < dimensions; band += 1) {
    deviations[band] = Math.sqrt(deviations[band] / Math.max(1, frameCount - 1));
  }

  const result = new Float32Array(features.length);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let band = 0; band < dimensions; band += 1) {
      const value = features[frame * dimensions + band];
      const normalized = (value - means[band]) / Math.max(1e-5, deviations[band]);
      result[frame * dimensions + band] = clamp(normalized, -4, 4);
    }
  }
  return result;
}

export function extractSpectralFlux(
  samples,
  sampleRate,
  startTime,
  { frameSize = 512, hopSize = 400, bands = DEFAULT_BANDS } = {}
) {
  const fftSize = nextPowerOfTwo(frameSize);
  const frameCount = Math.max(0, Math.floor((samples.length - frameSize) / hopSize) + 1);
  const dimensions = bands.length;
  const energies = new Float32Array(frameCount * dimensions);
  if (!frameCount) {
    return {
      values: energies,
      dimensions,
      frameCount,
      hopSeconds: hopSize / sampleRate,
      startTime
    };
  }
  const window = new Float32Array(frameSize);
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  const bandBins = bands.map(([lowHz, highHz]) => [
    Math.max(1, Math.floor((lowHz * fftSize) / sampleRate)),
    Math.min(fftSize / 2 - 1, Math.ceil((highHz * fftSize) / sampleRate))
  ]);

  for (let index = 0; index < frameSize; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (frameSize - 1));
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    real.fill(0);
    imag.fill(0);
    const frameOffset = frame * hopSize;

    for (let index = 0; index < frameSize; index += 1) {
      real[index] = samples[frameOffset + index] * window[index];
    }
    fft(real, imag);

    for (let band = 0; band < dimensions; band += 1) {
      const [lowBin, highBin] = bandBins[band];
      let energy = 0;
      for (let bin = lowBin; bin <= highBin; bin += 1) {
        energy += real[bin] * real[bin] + imag[bin] * imag[bin];
      }
      energies[frame * dimensions + band] = Math.log1p(energy);
    }
  }

  const flux = new Float32Array(energies.length);
  for (let frame = 1; frame < frameCount; frame += 1) {
    for (let band = 0; band < dimensions; band += 1) {
      const current = energies[frame * dimensions + band];
      const previous = energies[(frame - 1) * dimensions + band];
      flux[frame * dimensions + band] = Math.max(0, current - previous);
    }
  }

  return {
    values: standardize(flux, dimensions),
    dimensions,
    frameCount,
    hopSeconds: hopSize / sampleRate,
    startTime: startTime + frameSize / sampleRate / 2
  };
}

function similarityForDelay(tv, bilibili, delaySec, minimumOverlapSec) {
  const hop = tv.hopSeconds;
  const dimensions = tv.dimensions;
  const shift = Math.round((tv.startTime - delaySec - bilibili.startTime) / hop);
  const tvStart = Math.max(0, -shift);
  const tvEnd = Math.min(tv.frameCount, bilibili.frameCount - shift);
  const count = tvEnd - tvStart;
  if (count * hop < minimumOverlapSec) return null;

  let dot = 0;
  let tvNorm = 0;
  let bilibiliNorm = 0;
  let activeFrames = 0;
  const windowScores = [];
  const framesPerWindow = Math.max(1, Math.round(4 / hop));
  let windowDot = 0;
  let windowTvNorm = 0;
  let windowBilibiliNorm = 0;
  let windowActiveFrames = 0;
  let windowFrameCount = 0;

  function finishWindow() {
    const denominator = Math.sqrt(windowTvNorm * windowBilibiliNorm);
    const enoughActivity =
      windowActiveFrames >= Math.max(4, Math.floor(windowFrameCount * 0.06));
    if (windowFrameCount * hop >= 2.5 && enoughActivity && denominator > 1e-8) {
      windowScores.push(windowDot / denominator);
    } else {
      windowScores.push(null);
    }
    windowDot = 0;
    windowTvNorm = 0;
    windowBilibiliNorm = 0;
    windowActiveFrames = 0;
    windowFrameCount = 0;
  }

  for (let tvFrame = tvStart; tvFrame < tvEnd; tvFrame += 1) {
    const bilibiliFrame = tvFrame + shift;
    let frameEnergy = 0;

    for (let band = 0; band < dimensions; band += 1) {
      const tvValue = tv.values[tvFrame * dimensions + band];
      const bilibiliValue = bilibili.values[bilibiliFrame * dimensions + band];
      dot += tvValue * bilibiliValue;
      tvNorm += tvValue * tvValue;
      bilibiliNorm += bilibiliValue * bilibiliValue;
      windowDot += tvValue * bilibiliValue;
      windowTvNorm += tvValue * tvValue;
      windowBilibiliNorm += bilibiliValue * bilibiliValue;
      frameEnergy += Math.abs(tvValue) + Math.abs(bilibiliValue);
    }
    if (frameEnergy > dimensions * 0.8) {
      activeFrames += 1;
      windowActiveFrames += 1;
    }
    windowFrameCount += 1;
    if (windowFrameCount === framesPerWindow) finishWindow();
  }
  if (windowFrameCount) finishWindow();

  if (activeFrames < Math.max(20, count * 0.08)) return null;
  const denominator = Math.sqrt(tvNorm * bilibiliNorm);
  if (denominator < 1e-8) return null;

  return {
    score: dot / denominator,
    overlapSec: count * hop,
    activeFrames,
    windowScores,
    windowMedian: median(windowScores.filter(Number.isFinite))
  };
}

function scanDelays(tv, bilibili, minimum, maximum, step, minimumOverlapSec) {
  const results = [];
  for (let delay = minimum; delay <= maximum + 1e-6; delay += step) {
    const similarity = similarityForDelay(tv, bilibili, delay, minimumOverlapSec);
    if (similarity) results.push({ delaySec: delay, ...similarity });
  }
  return results;
}

function combineScores(monoResults, sideResults, useSide) {
  const sideByDelay = new Map(
    sideResults.map((result) => [result.delaySec.toFixed(3), result])
  );
  return monoResults.map((mono) => {
    const side = sideByDelay.get(mono.delaySec.toFixed(3));
    const baseScore =
      useSide && side ? mono.score * 0.38 + side.score * 0.62 : mono.score;
    const windowCount = Math.max(
      mono.windowScores?.length || 0,
      side?.windowScores?.length || 0
    );
    const windowScores = [];
    for (let index = 0; index < windowCount; index += 1) {
      const monoWindow = mono.windowScores?.[index];
      const sideWindow = side?.windowScores?.[index];
      if (Number.isFinite(monoWindow) && useSide && Number.isFinite(sideWindow)) {
        windowScores.push(monoWindow * 0.38 + sideWindow * 0.62);
      } else if (Number.isFinite(monoWindow)) {
        windowScores.push(monoWindow);
      } else if (Number.isFinite(sideWindow)) {
        windowScores.push(sideWindow);
      }
    }
    const windowMedian = median(windowScores);
    const score = baseScore * 0.78 + windowMedian * 0.22;
    const stableThreshold = Math.max(0.012, windowMedian * 0.42);
    const stableWindowCount = windowScores.filter(
      (windowScore) => windowScore >= stableThreshold
    ).length;
    return {
      ...mono,
      score,
      baseScore,
      monoScore: mono.score,
      sideScore: side?.score ?? null,
      overlapSec: Math.min(mono.overlapSec, side?.overlapSec ?? mono.overlapSec),
      windowScores,
      windowMedian,
      windowCount: windowScores.length,
      stableWindowCount
    };
  });
}

function sliceByTime(samples, sampleRate, sourceStartTime, startTime, endTime) {
  const startIndex = clamp(
    Math.floor((startTime - sourceStartTime) * sampleRate),
    0,
    samples.length
  );
  const endIndex = clamp(
    Math.ceil((endTime - sourceStartTime) * sampleRate),
    startIndex,
    samples.length
  );
  return {
    samples: samples.subarray(startIndex, endIndex),
    startTime: sourceStartTime + startIndex / sampleRate
  };
}

export function updateDelayConsensus(
  history,
  candidate,
  { toleranceSec = 0.14, maxHistory = 4 } = {}
) {
  const normalizedCandidate = {
    delaySec: Number(candidate?.delaySec),
    confidence: clamp(Number(candidate?.confidence) || 0, 0, 1)
  };
  const previousHistory = Array.isArray(history)
    ? history.filter(
        (item) =>
          Number.isFinite(item?.delaySec) && Number.isFinite(item?.confidence)
      )
    : [];

  if (!Number.isFinite(normalizedCandidate.delaySec)) {
    return {
      confirmed: false,
      reason: "invalid-candidate",
      history: previousHistory.slice(-maxHistory)
    };
  }

  const nextHistory = [...previousHistory, normalizedCandidate].slice(-maxHistory);
  if (nextHistory.length < 2) {
    return {
      confirmed: false,
      reason: "needs-second-window",
      history: nextHistory
    };
  }

  const previous = nextHistory[nextHistory.length - 2];
  const differenceSec = Math.abs(previous.delaySec - normalizedCandidate.delaySec);
  if (differenceSec > toleranceSec) {
    return {
      confirmed: false,
      reason: "candidates-disagree",
      differenceSec,
      history: nextHistory
    };
  }

  const cluster = nextHistory.filter(
    (item) => Math.abs(item.delaySec - normalizedCandidate.delaySec) <= toleranceSec
  );
  let weightedDelay = 0;
  let totalWeight = 0;
  for (const item of cluster) {
    const weight = Math.max(0.1, item.confidence);
    weightedDelay += item.delaySec * weight;
    totalWeight += weight;
  }
  const delaySec = weightedDelay / totalWeight;
  const delays = cluster.map((item) => item.delaySec);

  return {
    confirmed: true,
    reason: "confirmed",
    history: nextHistory,
    delaySec,
    confirmations: cluster.length,
    spreadSec: Math.max(...delays) - Math.min(...delays)
  };
}

export function estimateDelay({
  tvMono,
  tvSide,
  tvStartTime,
  bilibiliMono,
  bilibiliSide,
  bilibiliStartTime,
  sampleRate = 8000,
  initialDelaySec = 0,
  searchRadiusSec = 15,
  minimumOverlapSec = 8,
  maximumDelaySec = 119
}) {
  const options = { frameSize: 512, hopSize: 400 };
  const tvMonoFeatures = extractSpectralFlux(tvMono, sampleRate, tvStartTime, options);
  const bilibiliMonoFeatures = extractSpectralFlux(
    bilibiliMono,
    sampleRate,
    bilibiliStartTime,
    options
  );
  const sideRatio =
    Math.min(rms(tvSide), rms(bilibiliSide)) /
    Math.max(1e-7, Math.min(rms(tvMono), rms(bilibiliMono)));
  const useSide = sideRatio > 0.035;
  const tvSideFeatures = useSide
    ? extractSpectralFlux(tvSide, sampleRate, tvStartTime, options)
    : null;
  const bilibiliSideFeatures = useSide
    ? extractSpectralFlux(bilibiliSide, sampleRate, bilibiliStartTime, options)
    : null;

  const minimum = Math.max(0, initialDelaySec - searchRadiusSec);
  const maximum = Math.min(maximumDelaySec, initialDelaySec + searchRadiusSec);
  const coarseStep = 0.1;
  const monoCoarse = scanDelays(
    tvMonoFeatures,
    bilibiliMonoFeatures,
    minimum,
    maximum,
    coarseStep,
    minimumOverlapSec
  );
  const sideCoarse = useSide
    ? scanDelays(
        tvSideFeatures,
        bilibiliSideFeatures,
        minimum,
        maximum,
        coarseStep,
        minimumOverlapSec
      )
    : [];
  const coarseCombined = combineScores(monoCoarse, sideCoarse, useSide).sort(
    (a, b) => b.score - a.score
  );

  if (!coarseCombined.length) {
    return { ok: false, reason: "not-enough-overlap", confidence: 0 };
  }

  const coarseBest = coarseCombined[0];
  const fineRadius = 0.55;
  const fineMinimum = Math.max(minimum, coarseBest.delaySec - fineRadius);
  const fineMaximum = Math.min(maximum, coarseBest.delaySec + fineRadius);
  const tvEndTime = tvStartTime + tvMono.length / sampleRate;
  const bilibiliEndTime =
    bilibiliStartTime + bilibiliMono.length / sampleRate;
  const fineOverlapStart = Math.max(
    tvStartTime,
    bilibiliStartTime + coarseBest.delaySec + fineRadius
  );
  const fineOverlapEnd = Math.min(
    tvEndTime,
    bilibiliEndTime + coarseBest.delaySec - fineRadius
  );
  const fineWindowEnd = fineOverlapEnd;
  const fineWindowStart = Math.max(fineOverlapStart, fineWindowEnd - 30);
  let fineCombined = [];

  if (fineWindowEnd - fineWindowStart >= Math.max(6, minimumOverlapSec)) {
    const margin = fineRadius + 0.15;
    const tvMonoSlice = sliceByTime(
      tvMono,
      sampleRate,
      tvStartTime,
      fineWindowStart,
      fineWindowEnd
    );
    const bilibiliMonoSlice = sliceByTime(
      bilibiliMono,
      sampleRate,
      bilibiliStartTime,
      fineWindowStart - coarseBest.delaySec - margin,
      fineWindowEnd - coarseBest.delaySec + margin
    );
    const fineOptions = { frameSize: 256, hopSize: 80 };
    const tvMonoFineFeatures = extractSpectralFlux(
      tvMonoSlice.samples,
      sampleRate,
      tvMonoSlice.startTime,
      fineOptions
    );
    const bilibiliMonoFineFeatures = extractSpectralFlux(
      bilibiliMonoSlice.samples,
      sampleRate,
      bilibiliMonoSlice.startTime,
      fineOptions
    );
    let tvSideFineFeatures = null;
    let bilibiliSideFineFeatures = null;
    if (useSide) {
      const tvSideSlice = sliceByTime(
        tvSide,
        sampleRate,
        tvStartTime,
        fineWindowStart,
        fineWindowEnd
      );
      const bilibiliSideSlice = sliceByTime(
        bilibiliSide,
        sampleRate,
        bilibiliStartTime,
        fineWindowStart - coarseBest.delaySec - margin,
        fineWindowEnd - coarseBest.delaySec + margin
      );
      tvSideFineFeatures = extractSpectralFlux(
        tvSideSlice.samples,
        sampleRate,
        tvSideSlice.startTime,
        fineOptions
      );
      bilibiliSideFineFeatures = extractSpectralFlux(
        bilibiliSideSlice.samples,
        sampleRate,
        bilibiliSideSlice.startTime,
        fineOptions
      );
    }

    const fineMinimumOverlap = Math.min(
      minimumOverlapSec,
      Math.max(5, fineWindowEnd - fineWindowStart - 1)
    );
    const monoFine = scanDelays(
      tvMonoFineFeatures,
      bilibiliMonoFineFeatures,
      fineMinimum,
      fineMaximum,
      tvMonoFineFeatures.hopSeconds,
      fineMinimumOverlap
    );
    const sideFine = useSide
      ? scanDelays(
          tvSideFineFeatures,
          bilibiliSideFineFeatures,
          fineMinimum,
          fineMaximum,
          tvMonoFineFeatures.hopSeconds,
          fineMinimumOverlap
        )
      : [];
    fineCombined = combineScores(monoFine, sideFine, useSide).sort(
      (a, b) => b.score - a.score
    );
  }

  const best = fineCombined[0] || coarseBest;
  const comparisonPool = fineCombined.length ? fineCombined : coarseCombined;
  const runnerUp = comparisonPool
    .filter((candidate) => Math.abs(candidate.delaySec - best.delaySec) >= 0.18)
    .sort((a, b) => b.score - a.score)[0];

  const prominence = best.score - (runnerUp?.score ?? 0);
  const scoreQuality = clamp((best.score - 0.015) / 0.22, 0, 1);
  const prominenceQuality = clamp(prominence / 0.055, 0, 1);
  const overlapQuality = clamp((best.overlapSec - minimumOverlapSec) / 18, 0, 1);
  const windowLevelQuality = clamp((best.windowMedian - 0.008) / 0.16, 0, 1);
  const windowCoverageQuality = best.windowCount
    ? clamp(best.stableWindowCount / Math.min(4, best.windowCount), 0, 1)
    : 0;
  const consistencyQuality =
    windowLevelQuality * 0.55 + windowCoverageQuality * 0.45;
  const confidence = clamp(
    scoreQuality * 0.38 +
      prominenceQuality * 0.25 +
      overlapQuality * 0.12 +
      consistencyQuality * 0.25,
    0,
    1
  );

  return {
    ok: true,
    delaySec: Math.max(0, best.delaySec),
    confidence,
    score: best.score,
    prominence,
    overlapSec: best.overlapSec,
    useSide,
    sideRatio,
    resolutionMs: Math.round(
      (fineCombined.length ? 80 / sampleRate : coarseStep) * 1000
    ),
    windowMedian: best.windowMedian,
    stableWindowCount: best.stableWindowCount,
    windowCount: best.windowCount
  };
}

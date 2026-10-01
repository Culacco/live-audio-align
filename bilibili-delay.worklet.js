class BilibiliDelayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions || {};
    this.role = "bilibili";
    this.targetRate = processorOptions.targetRate || 8000;
    this.maxDelaySec = processorOptions.maxDelaySec || 74.5;
    this.capacity = Math.ceil((this.maxDelaySec + 0.5) * sampleRate);
    this.leftBuffer = new Float32Array(this.capacity);
    this.rightBuffer = new Float32Array(this.capacity);
    this.writeIndex = 0;
    this.totalWritten = 0;

    const initialDelaySec = Math.max(
      0,
      Math.min(this.maxDelaySec, Number(processorOptions.initialDelaySec) || 0)
    );
    const initialDelaySamples = Math.round(initialDelaySec * sampleRate);
    this.currentDelaySamples = initialDelaySamples;
    this.previousDelaySamples = initialDelaySamples;
    this.targetDelaySamples = initialDelaySamples;
    this.crossfadeTotal = Math.max(1, Math.round(sampleRate * 0.16));
    this.crossfadeRemaining = 0;

    this.analysisEnabled = false;
    this.downsampleStep = this.targetRate / sampleRate;
    this.downsamplePhase = 0;
    this.monoSum = 0;
    this.sideSum = 0;
    this.sumCount = 0;
    this.chunkSize = 1024;
    this.monoChunk = new Float32Array(this.chunkSize);
    this.sideChunk = new Float32Array(this.chunkSize);
    this.chunkIndex = 0;
    this.chunkStartTime = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data?.type === "SET_ENABLED") {
        this.analysisEnabled = Boolean(data.enabled);
        if (!this.analysisEnabled) this.resetAnalysisChunk();
      }
      if (data?.type === "SET_DELAY") {
        const seconds = Math.max(0, Math.min(this.maxDelaySec, Number(data.seconds) || 0));
        const samples = Math.round(seconds * sampleRate);
        if (samples === this.targetDelaySamples && this.crossfadeRemaining === 0) return;
        this.previousDelaySamples =
          this.crossfadeRemaining > 0 ? this.targetDelaySamples : this.currentDelaySamples;
        this.targetDelaySamples = samples;
        this.crossfadeRemaining = data.crossfade === false ? 0 : this.crossfadeTotal;
        if (!this.crossfadeRemaining) this.currentDelaySamples = samples;
      }
    };
  }

  resetAnalysisChunk() {
    this.chunkIndex = 0;
    this.monoSum = 0;
    this.sideSum = 0;
    this.sumCount = 0;
  }

  emitAnalysisChunk() {
    const mono = this.monoChunk;
    const side = this.sideChunk;
    this.port.postMessage(
      {
        type: "PCM",
        role: this.role,
        startTime: this.chunkStartTime,
        sampleRate: this.targetRate,
        mono: mono.buffer,
        side: side.buffer
      },
      [mono.buffer, side.buffer]
    );
    this.monoChunk = new Float32Array(this.chunkSize);
    this.sideChunk = new Float32Array(this.chunkSize);
    this.chunkIndex = 0;
  }

  collectAnalysis(left, right, inputIndex) {
    if (!this.analysisEnabled) return;
    this.monoSum += (left + right) * 0.5;
    this.sideSum += (left - right) * 0.5;
    this.sumCount += 1;
    this.downsamplePhase += this.downsampleStep;
    if (this.downsamplePhase < 1) return;

    this.downsamplePhase -= 1;
    if (this.chunkIndex === 0) {
      this.chunkStartTime = currentTime + inputIndex / sampleRate;
    }
    this.monoChunk[this.chunkIndex] = this.monoSum / this.sumCount;
    this.sideChunk[this.chunkIndex] = this.sideSum / this.sumCount;
    this.chunkIndex += 1;
    this.monoSum = 0;
    this.sideSum = 0;
    this.sumCount = 0;
    if (this.chunkIndex === this.chunkSize) this.emitAnalysisChunk();
  }

  readDelayed(buffer, delaySamples) {
    if (this.totalWritten <= delaySamples) return 0;
    let readIndex = this.writeIndex - delaySamples - 1;
    if (readIndex < 0) readIndex += this.capacity;
    return buffer[readIndex];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;

    const outputLeft = output[0];
    const outputRight = output[1] || outputLeft;
    // Missing input is silence on the same timeline: keep draining buffered sound.
    const inputLeft = input?.[0];
    const inputRight = input?.[1] || inputLeft;

    for (let index = 0; index < outputLeft.length; index += 1) {
      const left = inputLeft?.[index] || 0;
      const right = inputRight === inputLeft ? left : inputRight?.[index] || 0;
      this.leftBuffer[this.writeIndex] = left;
      this.rightBuffer[this.writeIndex] = right;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.totalWritten += 1;
      this.collectAnalysis(left, right, index);

      if (this.crossfadeRemaining > 0) {
        const progress = 1 - this.crossfadeRemaining / this.crossfadeTotal;
        const oldLeft = this.readDelayed(this.leftBuffer, this.previousDelaySamples);
        const oldRight = this.readDelayed(this.rightBuffer, this.previousDelaySamples);
        const newLeft = this.readDelayed(this.leftBuffer, this.targetDelaySamples);
        const newRight = this.readDelayed(this.rightBuffer, this.targetDelaySamples);
        outputLeft[index] = oldLeft + (newLeft - oldLeft) * progress;
        outputRight[index] = oldRight + (newRight - oldRight) * progress;
        this.crossfadeRemaining -= 1;
        if (this.crossfadeRemaining === 0) {
          this.currentDelaySamples = this.targetDelaySamples;
        }
      } else {
        outputLeft[index] = this.readDelayed(this.leftBuffer, this.currentDelaySamples);
        outputRight[index] = this.readDelayed(this.rightBuffer, this.currentDelaySamples);
      }
    }

    return true;
  }
}

registerProcessor("bilibili-delay", BilibiliDelayProcessor);

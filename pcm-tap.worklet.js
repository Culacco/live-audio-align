class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions || {};
    this.role = processorOptions.role || "unknown";
    this.targetRate = processorOptions.targetRate || 8000;
    this.step = this.targetRate / sampleRate;
    this.phase = 0;
    this.monoSum = 0;
    this.sideSum = 0;
    this.sumCount = 0;
    this.chunkSize = 1024;
    this.monoChunk = new Float32Array(this.chunkSize);
    this.sideChunk = new Float32Array(this.chunkSize);
    this.chunkIndex = 0;
    this.chunkStartTime = 0;
    this.enabled = false;

    this.port.onmessage = (event) => {
      if (event.data?.type === "SET_ENABLED") {
        this.enabled = Boolean(event.data.enabled);
        if (!this.enabled) this.resetChunk();
      }
    };
  }

  resetChunk() {
    this.chunkIndex = 0;
    this.monoSum = 0;
    this.sideSum = 0;
    this.sumCount = 0;
  }

  emitChunk() {
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

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (output) {
      for (const channel of output) channel.fill(0);
    }

    if (!this.enabled || !input?.length || !input[0]?.length) return true;

    const left = input[0];
    const right = input[1] || left;

    for (let index = 0; index < left.length; index += 1) {
      const mono = (left[index] + right[index]) * 0.5;
      const side = (left[index] - right[index]) * 0.5;
      this.monoSum += mono;
      this.sideSum += side;
      this.sumCount += 1;
      this.phase += this.step;

      if (this.phase < 1) continue;

      this.phase -= 1;
      if (this.chunkIndex === 0) {
        this.chunkStartTime = currentTime + index / sampleRate;
      }
      this.monoChunk[this.chunkIndex] = this.monoSum / this.sumCount;
      this.sideChunk[this.chunkIndex] = this.sideSum / this.sumCount;
      this.chunkIndex += 1;
      this.monoSum = 0;
      this.sideSum = 0;
      this.sumCount = 0;

      if (this.chunkIndex === this.chunkSize) this.emitChunk();
    }

    return true;
  }
}

registerProcessor("pcm-tap", PcmTapProcessor);

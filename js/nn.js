'use strict';

// Tiny fully-connected feed-forward network with tanh activations.
// Weights live in one flat Float32Array so cloning, mutation and
// crossover are cheap — that matters when evolving hundreds of cars.
class NeuralNet {
  constructor(sizes, weights) {
    this.sizes = sizes.slice();
    const n = NeuralNet.paramCount(sizes);
    if (weights) {
      this.w = Float32Array.from(weights);
      if (this.w.length !== n) throw new Error('Weight count does not match network shape');
    } else {
      this.w = new Float32Array(n);
      let o = 0;
      for (let l = 0; l < sizes.length - 1; l++) {
        const inp = sizes[l], out = sizes[l + 1];
        const scale = Math.sqrt(1 / inp) * 1.2;
        for (let j = 0; j < out; j++) {
          for (let i = 0; i < inp; i++) this.w[o++] = randn() * scale;
          this.w[o++] = randn() * 0.1; // bias
        }
      }
    }
    this.acts = sizes.map(s => new Float32Array(s));
    this.deltas = sizes.map(s => new Float32Array(s));
    this.offsets = [];
    for (let l = 0, o = 0; l < sizes.length - 1; l++) { this.offsets.push(o); o += (sizes[l] + 1) * sizes[l + 1]; }
  }

  static paramCount(sizes) {
    let n = 0;
    for (let l = 0; l < sizes.length - 1; l++) n += (sizes[l] + 1) * sizes[l + 1];
    return n;
  }

  forward(input) {
    const sizes = this.sizes, w = this.w, acts = this.acts;
    const a0 = acts[0];
    for (let i = 0; i < sizes[0]; i++) a0[i] = input[i];
    let o = 0;
    for (let l = 0; l < sizes.length - 1; l++) {
      const prev = acts[l], cur = acts[l + 1], inp = sizes[l], out = sizes[l + 1];
      for (let j = 0; j < out; j++) {
        let s = 0;
        for (let i = 0; i < inp; i++) s += prev[i] * w[o++];
        s += w[o++];
        cur[j] = Math.tanh(s);
      }
    }
    return acts[acts.length - 1];
  }

  clone() { return new NeuralNet(this.sizes, this.w); }

  // One step of gradient descent (backpropagation, squared error) towards
  // `target` for this input. This is how a car learns from a lesson.
  train(input, target, lr) {
    const sizes = this.sizes, w = this.w, acts = this.acts, deltas = this.deltas, L = sizes.length;
    const out = this.forward(input);
    let delta = deltas[L - 1];
    for (let j = 0; j < sizes[L - 1]; j++) delta[j] = (out[j] - target[j]) * (1 - out[j] * out[j]);
    for (let l = L - 2; l >= 0; l--) {
      const inp = sizes[l], outN = sizes[l + 1], prev = acts[l], base = this.offsets[l];
      const back = l > 0 ? deltas[l] : null;
      if (back) back.fill(0);
      for (let j = 0; j < outN; j++) {
        const d = delta[j], o = base + j * (inp + 1);
        if (d === 0) continue;
        for (let i = 0; i < inp; i++) {
          if (back) back[i] += w[o + i] * d;
          w[o + i] = clamp(w[o + i] - lr * d * prev[i], -5, 5);
        }
        w[o + inp] = clamp(w[o + inp] - lr * d, -5, 5);
      }
      if (back) for (let i = 0; i < inp; i++) back[i] *= 1 - prev[i] * prev[i];
      delta = back;
    }
  }

  mutate(rate, strength) {
    const w = this.w;
    for (let i = 0; i < w.length; i++) {
      if (Math.random() < rate) {
        if (Math.random() < 0.04) w[i] = randn();          // occasional fresh gene
        else w[i] += randn() * strength;                   // usual small nudge
        w[i] = clamp(w[i], -5, 5);
      }
    }
    return this;
  }

  // Neuron-level crossover: each neuron's incoming weights come intact from
  // one parent, which keeps useful feature detectors from being shredded.
  static crossover(a, b) {
    const child = a.clone();
    const sizes = a.sizes;
    let o = 0;
    for (let l = 0; l < sizes.length - 1; l++) {
      const block = sizes[l] + 1;
      for (let j = 0; j < sizes[l + 1]; j++) {
        if (Math.random() < 0.5) {
          for (let k = 0; k < block; k++) child.w[o + k] = b.w[o + k];
        }
        o += block;
      }
    }
    return child;
  }

  toJSON() {
    return { sizes: this.sizes, w: Array.from(this.w, v => Math.round(v * 1e5) / 1e5) };
  }

  static fromJSON(obj) { return new NeuralNet(obj.sizes, obj.w); }
}

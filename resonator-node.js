// Wrapper node for the ResonatorProcessor
// Exposes AudioParams and per-branch setters

export class ResonatorNode extends AudioWorkletNode {
  static async create(context) {
    // Ensure the processor module is loaded; ignore error if already loaded
    try {
      await context.audioWorklet.addModule('resonator-processor.js');
    } catch (_) {
      // no-op
    }
    return new ResonatorNode(context);
  }

  constructor(context) {
    super(context, 'resonator-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        nbranches: 4,
        noiseLevel: 0.1,
        rmix: 1,
        dryWet: 1,
        quantize: 0,
        exciterCutoff: 4000,
        exciterHP: 50,
        exciterBurst: 0,
        burstRate: 4,
        burstDurMs: 12,
        exciterMode: 0,
        impulseGain: 0.3,
        monitorExciter: 0,
        octaves: 0,
        freqScale: 1,
        freqCenter: 0,
        decayScale: 1
        , exciterBandQ: 25
      }
    });
  }

  // AudioParam helpers
  get nbranches() { return this.parameters.get('nbranches'); }
  get noiseLevel() { return this.parameters.get('noiseLevel'); }
  get rmix() { return this.parameters.get('rmix'); }
  get dryWet() { return this.parameters.get('dryWet'); }
  get quantize() { return this.parameters.get('quantize'); }
  get exciterCutoff() { return this.parameters.get('exciterCutoff'); }
  get exciterHP() { return this.parameters.get('exciterHP'); }
  get octaves() { return this.parameters.get('octaves'); }
  get exciterBurst() { return this.parameters.get('exciterBurst'); }
  get burstRate() { return this.parameters.get('burstRate'); }
  get burstDurMs() { return this.parameters.get('burstDurMs'); }
  get exciterMode() { return this.parameters.get('exciterMode'); }
  get impulseGain() { return this.parameters.get('impulseGain'); }
  get monitorExciter() { return this.parameters.get('monitorExciter'); }
  get freqScale() { return this.parameters.get('freqScale'); }
  get freqCenter() { return this.parameters.get('freqCenter'); }
  get decayScale() { return this.parameters.get('decayScale'); }
  get exciterBandQ() { return this.parameters.get('exciterBandQ'); }
  get exciterBandQ() { return this.parameters.get('exciterBandQ'); }

  // Per-branch setters
  setBranchParams(index, { freq, decay, amp, pan }) {
    this.port.postMessage({
      type: 'setBranchParams',
      index,
      params: { freq, decay, amp, pan }
    });
  }

  setAllBranches(branches) {
    this.port.postMessage({ type: 'setAllBranches', branches });
  }

  // Send scale selection to the processor
  setScale({ name, root }) {
    this.port.postMessage({ type: 'setScale', name, root });
  }
}



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
      numberOfOutputs: 3,
      outputChannelCount: [2, 2, 5],
      parameterData: {
        nbranches: 4,
        noiseLevel: 0.03,
        noiseType: 1,
        lfoEnabled: 1,
        lfoRate: 0.1,
        lfoDepth: 0.7,
        lfoWave: 0,
        rmix: 1,
        quantize: 0,
        exciterCutoff: 4000,
        exciterHP: 50,
        // Raindrop exciter defaults
        rainEnabled: 1,
        rainGain: 0.62,
        rainRate: 0.83,
        rainDurMs: 61,
        rainSpread: 0.71,
        rainCenter: 0.49,
        rainLimbs: 10,
        monitorExciter: 0,
        groupEnabled: 0,
        groupSplit: 0,
        octaves: 0,
        freqScale: 1,
        freqCenter: 0,
        decayScale: 1,
        exciterBandQNoise: 30,
        exciterBandQRain: 30
      }
    });
  }

  // AudioParam helpers
  get nbranches() { return this.parameters.get('nbranches'); }
  get noiseLevel() { return this.parameters.get('noiseLevel'); }
  get noiseType() { return this.parameters.get('noiseType'); }
  get lfoEnabled() { return this.parameters.get('lfoEnabled'); }
  get lfoRate() { return this.parameters.get('lfoRate'); }
  get lfoDepth() { return this.parameters.get('lfoDepth'); }
  get lfoWave() { return this.parameters.get('lfoWave'); }
  get rmix() { return this.parameters.get('rmix'); }
  get quantize() { return this.parameters.get('quantize'); }
  get exciterCutoff() { return this.parameters.get('exciterCutoff'); }
  get exciterHP() { return this.parameters.get('exciterHP'); }
  get groupEnabled() { return this.parameters.get('groupEnabled'); }
  get groupSplit() { return this.parameters.get('groupSplit'); }
  get octaves() { return this.parameters.get('octaves'); }
  // Raindrop
  get rainEnabled() { return this.parameters.get('rainEnabled'); }
  get rainGain() { return this.parameters.get('rainGain'); }
  get rainRate() { return this.parameters.get('rainRate'); }
  get rainDurMs() { return this.parameters.get('rainDurMs'); }
  get rainSpread() { return this.parameters.get('rainSpread'); }
  get rainCenter() { return this.parameters.get('rainCenter'); }
  get rainLimbs() { return this.parameters.get('rainLimbs'); }
  get monitorExciter() { return this.parameters.get('monitorExciter'); }
  get freqScale() { return this.parameters.get('freqScale'); }
  get freqCenter() { return this.parameters.get('freqCenter'); }
  get decayScale() { return this.parameters.get('decayScale'); }
  get exciterBandQNoise() { return this.parameters.get('exciterBandQNoise'); }
  get exciterBandQRain() { return this.parameters.get('exciterBandQRain'); }

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



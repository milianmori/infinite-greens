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
        nbranches: 16,
        noiseLevel: 0.1,
        rmix: 0.5,
        freqScale: 1,
        freqCenter: 0,
        decayScale: 1
      }
    });
  }

  // AudioParam helpers
  get nbranches() { return this.parameters.get('nbranches'); }
  get noiseLevel() { return this.parameters.get('noiseLevel'); }
  get rmix() { return this.parameters.get('rmix'); }
  get freqScale() { return this.parameters.get('freqScale'); }
  get freqCenter() { return this.parameters.get('freqCenter'); }
  get decayScale() { return this.parameters.get('decayScale'); }

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
}



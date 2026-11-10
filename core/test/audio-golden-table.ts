// The material and scripts of the audio goldens: sounds that convolve, grains cut from a sample, recipes that lay a sample over their body, and songs
// with audio clips and a convolution room. The samples are generated here from integers and the engine's own sine (audio-material.ts).

import { AUDIO_BANK } from './audio-material.ts';

export { AUDIO_BANK };

const ONE = (extra: string): string => `sound new s voice=layered seed=1\nsound set s duration=0.5\nlayer add s osc wave=saw freq=220 dur=0.15\nenv s 1.amp "0:0 0.002:1 0.15:0@exp"\n${extra}`;

/** Sounds, by name: a script that makes the sound `s`. */
export const RENDER_TABLE: Record<string, string> = {
  'convolve-layer-room': ONE('fx add s layer=1 convolve ir=room mix=0.6 len=0.4'),
  'convolve-layer-predelay-gain': ONE('fx add s layer=1 convolve ir=room mix=1 len=0.3 predelay=0.04 gain=-3'),
  'convolve-layer-envelope': ONE('fx add s layer=1 convolve ir=room len=0.4\nenv s 1.fx1.mix "0:0 0.3:1"'),
  'convolve-master-stereo-hall': ONE('fx add s convolve ir=hall mix=0.5 len=0.5'),
  'convolve-master-mono-room': ONE('fx add s convolve ir=room mix=0.5 len=0.5'),
  'convolve-impulse-late': ONE('fx add s layer=1 convolve ir=late mix=1 len=0.2'),

  'grain-bed': GRAIN('layer add s grain sample=bed dur=1 density=30 size=0.06 position=0.4 spread=0.3 jitter=0.4'),
  'grain-pitched-envelopes': GRAIN('layer add s grain sample=tone dur=1 density=25 size=0.08 pitch=-5 spread=0.2\nenv s 1.position "0:0.1 1:0.8"\nenv s 1.density "0:10 1:60"'),
  'grain-linear-left': GRAIN('layer add s grain sample=wide dur=1 density=40 size=0.04 side=left interp=linear'),
  'recipe-door-with-sample': 'sound new s voice=layered preset=door seed=3 sample=beat',
};

function GRAIN(layer: string): string {
  return `sound new s voice=layered seed=7\nsound set s duration=1\n${layer}\n`;
}

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
};

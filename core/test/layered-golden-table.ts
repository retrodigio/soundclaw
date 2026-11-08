// The command scripts whose layered renders are hashed in the layered goldens (one sound, `s`, each).

import { RECIPE_NAMES } from '../src/index.ts';

const FLAT = 'env s 1.amp "0:1"\n';
const HEAD = 'sound new s voice=layered seed=11\n';
const one = (layer: string, extra = '') => `${HEAD}layer add s ${layer}\n${FLAT}${extra}`;

export const TABLE: Record<string, string> = {
  'classic-pickup': `${HEAD}layer add s classic preset=pickup presetseed=5\n`,
  'classic-noise-seeded': `${HEAD}layer add s classic wave=noise seed=77 decay=0.2\n`,
  'ks-pluck': one('ks freq=262 dur=0.5 decay=1 bright=0.7'),
  'sample-plain': one('sample sample=thump'),
  'sample-trim-pitch-reverse': one('sample sample=thump start=0.05 end=0.3 pitch=7 reverse=1'),
  'sample-pitch-envelope': one('sample sample=thump', 'env s 1.pitch "0:12 0.4:-12"\n'),
  'fm-chain-2': one('fm freq=300 dur=0.3 index2=3'),
  'fm-chain-4': one('fm freq=300 ops=4 algo=chain index2=2 index3=3 index4=1 ratio2=2 ratio3=3 ratio4=0.5 dur=0.3'),
  'fm-fan-4': one('fm freq=300 ops=4 algo=fan index2=2 index3=3 index4=1 dur=0.3'),
  'fm-pairs-4': one('fm freq=300 ops=4 algo=pairs index2=2 index4=3 dur=0.3'),
  'fm-parallel-3': one('fm freq=300 ops=3 algo=parallel dur=0.3'),
  'fm-index-envelope': one('fm freq=300 ratio2=3.5 dur=0.4', 'env s 1.index2 "0:6 0.4:0@exp"\n'),
  'wave-wavetable-custom': one('osc wave=wavetable table=0,0.8,1,0.2,-0.5,-1,-0.3,0 freq=220 dur=0.2'),
  'filter-lp-envelope': one('osc wave=saw freq=110 dur=0.4 filter=lp q=3', 'env s 1.cutoff "0:5000 0.4:200@exp"\n'),
  'pan-sweep-stereo': one('osc wave=triangle freq=330 dur=0.4', 'env s 1.pan "0:-1 0.4:1@ease"\n'),
  'two-layers-offset-pan': `${HEAD}layer add s osc wave=sine freq=100 dur=0.2 pan=-0.5\nlayer add s osc wave=square freq=800 dur=0.1 offset=0.1 pan=0.7\n`,
  'solo-and-mute': `${HEAD}layer add s osc wave=sine freq=100 dur=0.1\nlayer add s osc wave=saw freq=200 dur=0.1\nlayer add s osc wave=square freq=300 dur=0.1\nlayer mute s 1\nlayer solo s 3\n`,
  'master-chain': `${one('osc wave=saw freq=150 dur=0.3')}fx add s chorus mix=0.5\nfx add s delay time=0.07 feedback=0.4 mix=0.3\nfx add s reverb size=0.4 mix=0.2\nsound set s gain=0.8\n`,
  'layer-and-sound-duration': `${one('osc wave=sine freq=500 dur=0.2')}sound set s duration=0.35\n`,
};
for (const w of ['sine', 'square', 'saw', 'triangle', 'pulse', 'wavetable', 'white', 'pink', 'brown', 'metal']) TABLE[`wave-${w}`] = one(`osc wave=${w} freq=330 duty=0.3 dur=0.2 seed=4`);
for (const c of ['lin', 'exp', 'hold', 'ease']) TABLE[`curve-${c}`] = one('osc wave=saw freq=200 dur=0.3', `env s 1.freq "0:200 0.15:800@${c} 0.3:300@${c}"\nenv s 1.gain "0:1 0.3:0.2@${c}"\n`);
TABLE['curve-exp-to-zero'] = one('osc wave=square freq=200 dur=0.3', 'env s 1.amp "0:1 0.3:0@exp"\n');
TABLE['amp-adsr'] = one('osc wave=saw freq=200 dur=0.5', 'env s 1.amp adsr(0.02,0.1,0.4,0.2,0.1)\n');
for (const t of ['lp', 'hp', 'bp', 'notch']) {
  TABLE[`filter-layer-${t}`] = one(`osc wave=white dur=0.2 seed=3 filter=${t} cutoff=1500 q=2`);
  TABLE[`filter-fx-${t}`] = one('osc wave=white dur=0.2 seed=3', `fx add s layer=1 filter type=${t} cutoff=1500 q=2\n`);
}
for (const sh of ['soft', 'hard', 'fold', 'cubic']) TABLE[`fx-distort-${sh}`] = one('osc wave=sine freq=220 dur=0.2', `env s 1.amp "0:0.8"\nfx add s layer=1 distort shape=${sh} drive=5 mix=0.8\n`);
TABLE['fx-bitcrush'] = one('osc wave=saw freq=220 dur=0.2', 'fx add s layer=1 bitcrush bits=5 rate=11025\n');
TABLE['fx-chorus'] = one('osc wave=saw freq=220 dur=0.3', 'fx add s layer=1 chorus rate=1.2 depth=4 delay=12 mix=0.5\n');
TABLE['fx-delay'] = one('osc wave=square freq=330 dur=0.05', 'fx add s layer=1 delay time=0.08 feedback=0.5 mix=0.5\n');
TABLE['fx-reverb'] = one('osc wave=white dur=0.05 seed=2', 'fx add s layer=1 reverb size=0.7 damp=0.3 mix=0.4\n');
TABLE['fx-envelope-mix'] = one('osc wave=saw freq=220 dur=0.3', 'fx add s layer=1 distort shape=fold drive=6\nenv s 1.fx1.mix "0:0 0.3:1"\n');
TABLE['fx-compress'] = one('osc wave=saw freq=110 dur=0.4', 'fx add s layer=1 compress threshold=-24 ratio=6 attack=2 release=80 makeup=3\n');
TABLE['fx-limit'] = one('osc wave=white dur=0.3 seed=4 gain=3', 'fx add s layer=1 limit ceiling=-3 release=40 lookahead=4\n');
TABLE['master-compress-limit'] = `${one('osc wave=saw freq=150 dur=0.3 pan=0.3')}fx add s compress threshold=-20 ratio=3\nfx add s limit ceiling=-1\nsound set s gain=3\n`;
TABLE['env-bursts'] = one('osc wave=white dur=1 seed=9', 'env s 1.amp bursts(count=6 over=0.9 jitter=0.4 attack=0.002 decay=0.06 level=0.5..1 seed=3)\n');
TABLE['auto-trim-exp'] = one('osc wave=sine freq=330 dur=2', 'env s 1.amp "0:1 0.4:0@exp"\n');
TABLE['bell-exp-60db'] = one('osc wave=sine freq=523 dur=2.6', 'env s 1.amp "0:0 0.002:1 2.6:0@exp"\n');
TABLE['loop-raised-layer'] = one('osc wave=pink dur=0.3 seed=3', 'sound loop s 1.5 fade=0.2\n');
TABLE['loop-white-fold'] = one('osc wave=white dur=1 seed=3 gain=0.4', 'sound loop s 0.5 fade=0.1\n');
TABLE['loop-sine-fold-stereo'] = one('osc wave=sine freq=441.7 dur=1 pan=0.4', 'sound loop s 0.5 fade=0.05\n');
for (const r of RECIPE_NAMES) for (const seed of [1, 2, 3]) TABLE[`recipe-${r}-${seed}`] = `sound new s voice=layered preset=${r} seed=${seed}\n`;

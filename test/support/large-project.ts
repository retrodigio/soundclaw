// A large project built from the tool's own commands and generated art (no outside data): 400
// sounds (100 classic, 300 layered, most with sample layers, some stereo, some 30 s loops), 100
// samples and a tape of about 3,000 commands. Used by the server tests and the browser tests.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWavChannels } from '../../core/src/wav.ts';
import { Writer, createProject } from '../../server/src/index.ts';

export interface LargeOptions {
  sounds?: number;
  samples?: number;
  /** Commands on the tape, about. */
  tape?: number;
}

const CATEGORIES = ['pickup', 'laser', 'explosion', 'powerup', 'hit', 'jump', 'blip'];

/** A sample's audio: a decaying tone with a little noise, `seconds` long, mono or stereo. */
function sampleAudio(n: number, seconds: number, stereo: boolean): Float32Array[] {
  const rate = 44100;
  const frames = Math.round(seconds * rate);
  const chs = [new Float32Array(frames), ...(stereo ? [new Float32Array(frames)] : [])];
  let s = n * 2654435761 + 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const f = 110 * 2 ** ((n % 24) / 12);
  chs.forEach((c, k) => {
    for (let i = 0; i < frames; i++) c[i] = 0.4 * Math.sin((i / rate) * f * (k + 1) * Math.PI * 2) * Math.exp(-(i / rate) * (seconds > 5 ? 0.05 : 3)) + 0.05 * rnd();
  });
  return chs;
}

export interface LargeProject {
  dir: string;
  writer: Writer;
  commands: number;
  sounds: string[];
  samples: string[];
}

export function buildLargeProject(dir: string, o: LargeOptions = {}): LargeProject {
  const nSounds = o.sounds ?? 400;
  const nSamples = o.samples ?? 100;
  const nTape = o.tape ?? 3000;
  const w = new Writer(createProject(dir));
  const by = 'agent:builder';
  let commands = 0;
  const run = (text: string) => {
    const r = w.run({ commands: text, by });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    commands += text.split('\n').filter(Boolean).length;
  };
  const tmp = join(dir, '..', 'large-samples');
  mkdirSync(tmp, { recursive: true });
  const samples: string[] = [];
  for (let i = 0; i < nSamples; i++) {
    // every tenth sample is a 30 s loop (stereo for every other one), the rest are short hits
    const long = i % 10 === 0;
    const stereo = i % 5 === 0 || (long && i % 20 === 0);
    const name = `S${String(i).padStart(3, '0')}${stereo ? '_st' : ''}`;
    const file = join(tmp, `${name}.wav`);
    writeFileSync(file, encodeWavChannels(sampleAudio(i, long ? 30 : 0.3 + (i % 7) * 0.2, stereo)));
    w.samples.import(file, name);
    samples.push(name);
  }
  w.samplesChanged();
  const ids: string[] = [];
  const nClassic = Math.round(nSounds / 4);
  for (let i = 0; i < nSounds; i++) {
    const classic = i < nClassic;
    const id = `${classic ? 'cl' : 'ly'}_${String(i).padStart(3, '0')}`;
    ids.push(id);
    if (classic) {
      run(`sound new ${id} voice=classic preset=${CATEGORIES[i % CATEGORIES.length]} seed=${i + 1}`);
      continue;
    }
    const lines = [`sound new ${id} voice=layered seed=${i + 1}`];
    const sample = samples[(i * 7) % samples.length]!;
    if (i % 4 !== 3) lines.push(`layer add ${id} osc freq=${110 + (i % 30) * 20} dur=0.4`);
    if (i % 4 !== 0) {
      if (sample.endsWith('_st')) lines.push(`layer add ${id} sample sample=${sample} side=left pan=-1`, `layer add ${id} sample sample=${sample} side=right pan=1`);
      else lines.push(`layer add ${id} sample sample=${sample}`);
    }
    // a third of the layered sounds with a 30 s sample are loops
    if (sample === samples[(i * 7) % samples.length] && Number(sample.slice(1, 4)) % 10 === 0 && i % 4 !== 0) lines.push(`sound loop ${id} 30 fade=1`);
    run(lines.join('\n'));
  }
  // the rest of the tape: edits and marks, one batch each (a history of work)
  let k = 0;
  while (commands < nTape) {
    const id = ids[k % ids.length]!;
    if (id.startsWith('cl_')) run(`sound set ${id} volume=${(0.3 + (k % 5) * 0.05).toFixed(2)}`);
    else if (k % 3 === 0) run(`sound mark ${id} ${k % 2 ? 'approved' : 'draft'}`);
    else run(`sound set ${id} gain=${(0.5 + (k % 5) * 0.1).toFixed(2)}`);
    k++;
  }
  return { dir, writer: w, commands, sounds: ids, samples };
}

// Run as a script (`node test/support/large-project.ts <dir>`): the browser tests build the project in a
// process of their own, where this takes 25 s (inside the test runner's loader it is several times slower).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const p = buildLargeProject(process.argv[2]!);
  console.log(`${p.sounds.length} sounds, ${p.samples.length} samples, ${p.commands} commands`);
}

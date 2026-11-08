// The hidden #/kit page: every component in every state, for tests and screenshots. The live
// controls log what they commit, so a test can check the input rules (drag, Shift, double-click,
// wheel, typed values, arrows) without touching a project.

import { useMemo, useState, type ReactNode } from 'react';
import { AuthorChip, AuthorMark, Badge, Banner, Button, Chip, Fader, IconButton, Kbd, Keys, Knob, LetterToggle, LoudnessTarget, Meter, Popover, Segmented, Slider, Tabs, Toggle, Tooltip, useToast, type CheckKind } from './controls.tsx';
import { Play, Stop } from './icons.tsx';
import { VirtualList, WaveView } from './layout.tsx';
import type { ValueSpec } from './values.ts';

const SWATCHES = ['ground', 'panel', 'raised', 'control', 'line', 'line2', 'text', 'text2', 'text3', 'ember', 'agent', 'you', 'pass', 'warn', 'fail', 'wave'];
const SIZES = [11, 12, 13, 15, 18, 22, 28];

function Sec({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return <section className="kit-sec" aria-labelledby={`kit-${id}`}><h2 id={`kit-${id}`}>{title}</h2><div className="kit-body">{children}</div></section>;
}

/** A knob that keeps its own value and reports every commit and draft. */
function LiveKnob({ name, spec, min, max, def, step, bipolar, log }: { name: string; spec: ValueSpec; min: number; max: number; def: number; step: number; bipolar?: boolean; log(s: string): void }) {
  const [v, setV] = useState(def);
  return <Knob testId={`kit-knob-${name}`} label={name} value={v} min={min} max={max} def={def} step={step} spec={spec} bipolar={bipolar} onDraft={() => log(`${name} draft`)} onCommit={(x) => { setV(x); log(`${name}=${x}`); }} />;
}

function wavePeaks(seed: number, n: number, decay: number): { min: number[]; max: number[] } {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const max: number[] = [], min: number[] = [];
  for (let i = 0; i < n; i++) { const t = i / n; const a = Math.min(1, t * 20) * Math.exp(-t * decay) * (0.55 + 0.45 * r()); max.push(a); min.push(-a * (0.8 + 0.2 * r())); }
  return { min, max };
}

export function Kit() {
  const toast = useToast();
  const [log, setLog] = useState<string[]>([]);
  const push = (s: string) => setLog((l) => [...l.slice(-30), s]);
  const commits = log.filter((l) => !l.endsWith(' draft')).length;
  const [slider, setSlider] = useState(0.58);
  const [bipolar, setBipolar] = useState(-0.42);
  const [fader, setFader] = useState(-3);
  const [seg, setSeg] = useState('wave');
  const [tab, setTab] = useState('sounds');
  const [on, setOn] = useState(true);
  const [solo, setSolo] = useState(true);
  const [chip, setChip] = useState(true);
  const [pop, setPop] = useState(false);
  const wave = useMemo(() => wavePeaks(7, 240, 3), []);
  const kinds: CheckKind[] = ['pass', 'warn', 'fail', 'checking'];
  return (
    <div className="kit" data-testid="kit">
      <header className="kit-head">
        <h1>SoundClaw <span className="dim">Studio</span> kit</h1>
        <p className="dim">Every component in every state, in the current theme and density. The page is hidden; open it at <code>#/kit</code>.</p>
      </header>

      <Sec id="colour" title="Colour">
        <div className="swatches">{SWATCHES.map((n) => <div key={n} className="swatch"><span style={{ background: `var(--${n})` }} /><b>{n}</b></div>)}</div>
      </Sec>

      <Sec id="type" title="Type">
        <div className="type-demo">
          <span style={{ fontFamily: 'var(--font-title)', fontWeight: 600, fontSize: 28 }}>battle loop</span>
          <span style={{ fontFamily: 'var(--font-title)', fontWeight: 600, fontSize: 15 }}>Envelope</span>
          <span>footstep grass 03</span>
          <span className="cap">Attack</span>
          <span className="mono">{'−'}16.2 LUFS {'·'} 0:01.240</span>
          <span className="dim">{SIZES.join(' · ')} px</span>
        </div>
      </Sec>

      <Sec id="who" title="Who did it">
        <div className="row-w"><AuthorChip by="agent" /><AuthorChip by="you" /><AuthorChip by="agent" proposed /><AuthorMark by="agent" /><AuthorMark by="you" /></div>
      </Sec>

      <Sec id="checks" title="Checks">
        <div className="row-w">{kinds.map((k) => <Badge key={k} kind={k} testId={`kit-badge-${k}`}>{k === 'pass' ? 'loudness' : k === 'warn' ? 'tail 0.94 s' : k === 'fail' ? 'click 0.14 s' : 'harsh'}</Badge>)}</div>
      </Sec>

      <Sec id="knobs" title="Knob states">
        <div className="row-w knobs">
          <Knob label="Rest" value={0.35} min={0} max={1} def={0.5} onCommit={() => undefined} testId="kit-state-rest" />
          <Knob label="Hover" demo="hover" value={0.55} min={0} max={1} def={0.5} onCommit={() => undefined} testId="kit-state-hover" />
          <Knob label="Dragging" demo="dragging" value={0.62} min={0} max={1} def={0.5} onCommit={() => undefined} testId="kit-state-drag" />
          <Knob label="Set by agent" value={0.78} min={0} max={1} def={0.5} agent={{ prev: 0.4 }} onCommit={() => undefined} testId="kit-state-agent" onHearBefore={() => push('hear-before')} />
          <Knob label="Focused" demo="focus" value={0.42} min={0} max={1} def={0.5} onCommit={() => undefined} testId="kit-state-focus" />
          <Knob label="Off" disabled value={0.2} min={0} max={1} def={0.5} onCommit={() => undefined} testId="kit-state-off" />
          <Knob label="Bipolar" bipolar value={-0.42} min={-1} max={1} def={0} onCommit={() => undefined} testId="kit-state-bipolar" />
        </div>
      </Sec>

      <Sec id="live" title="Live controls (drag, Shift for fine, double-click resets, wheel, click to type, arrows)">
        <div className="row-w knobs">
          <LiveKnob name="amount" spec={{ unit: 'plain', digits: 2 }} min={0} max={1} def={0.5} step={0.01} log={push} />
          <LiveKnob name="time" spec={{ unit: 's' }} min={0} max={2} def={0.1} step={0.01} log={push} />
          <LiveKnob name="freq" spec={{ unit: 'hz' }} min={20} max={8000} def={440} step={10} log={push} />
          <LiveKnob name="level" spec={{ unit: 'db' }} min={-24} max={12} def={0} step={0.5} log={push} />
          <LiveKnob name="pitch" spec={{ unit: 'st' }} min={-12} max={12} def={0} step={1} bipolar log={push} />
          <LiveKnob name="mix" spec={{ unit: 'pct' }} min={0} max={1} def={0.5} step={0.01} log={push} />
        </div>
        <div className="log-box">
          <span className="cap">Commits <span className="mono" data-testid="kit-commit-count">{commits}</span></span>
          <output className="mono" data-testid="kit-log" aria-live="off">{log.length ? log.join('\n') : 'nothing yet'}</output>
          <button type="button" className="btn btn-quiet" onClick={() => setLog([])} data-testid="kit-log-clear">Clear</button>
        </div>
      </Sec>

      <Sec id="sliders" title="Sliders and value entry">
        <div className="sliders">
          <Slider testId="kit-slider" label="Low-pass cutoff" value={slider} min={0} max={1} def={0.5} step={0.01} spec={{ unit: 'plain', digits: 2 }} onCommit={(v) => { setSlider(v); push(`slider=${v}`); }} />
          <Slider testId="kit-slider-bipolar" label="Pitch slide (bipolar)" bipolar value={bipolar} min={-1} max={1} def={0} step={0.01} agent={{ prev: -0.1 }} spec={{ unit: 'plain', digits: 2 }} onCommit={(v) => { setBipolar(v); push(`bipolar=${v}`); }} />
          <Slider label="Off" disabled value={0.3} min={0} max={1} def={0.5} onCommit={() => undefined} />
        </div>
      </Sec>

      <Sec id="fader" title="Fader, meter and loudness target">
        <div className="row-w fader-demo">
          <Fader testId="kit-fader" label="Master" value={fader} def={0} onCommit={(v) => { setFader(v); push(`fader=${v}`); }} meter={{ levels: [-4.2, -5.6], label: 'Master level' }} />
          <Meter levels={[-18, -12]} height={160} label="Quiet" testId="kit-meter-ok" />
          <Meter levels={[-3, -2]} height={160} label="Hot" testId="kit-meter-warm" />
          <Meter levels={[0.5, -1]} height={160} label="Clipping" testId="kit-meter-hot" />
          <div className="loud-stack">
            <LoudnessTarget value={-16.2} target={-16} testId="kit-loud-pass" />
            <LoudnessTarget value={-13.1} target={-16} testId="kit-loud-warn" />
            <LoudnessTarget value={-24} target={-16} testId="kit-loud-fail" />
            <LoudnessTarget value={null} target={-16} testId="kit-loud-checking" />
          </div>
        </div>
      </Sec>

      <Sec id="buttons" title="Buttons, toggles, segments, tabs, chips">
        <div className="row-w">
          <Button kind="primary">Approve</Button><Button kind="agent">Ask for changes</Button><Button>Export</Button><Button kind="quiet">Quiet</Button><Button disabled>Disabled</Button><Button kind="danger">Revert</Button>
          <IconButton label="Play" kind="primary"><Play /></IconButton><IconButton label="Stop"><Stop size={9} /></IconButton>
        </div>
        <div className="row-w">
          <Segmented label="Lens" value={seg} onChange={setSeg} testId="kit-seg" options={[{ value: 'wave', label: 'Wave' }, { value: 'spectrum', label: 'Spectrum' }, { value: 'pitch', label: 'Pitch' }, { value: 'compare', label: 'Compare' }]} />
          <span className="row-w"><LetterToggle letter="S" on={solo} onChange={setSolo} label="Solo" /><LetterToggle letter="M" on={false} onChange={() => undefined} label="Mute" tone="fail" /></span>
          <Toggle checked={on} onChange={setOn} label="Loop" testId="kit-toggle" />
        </div>
        <div className="row-w">
          <Tabs label="Library" value={tab} onChange={setTab} testId="kit-tabs" tabs={[{ value: 'sounds', label: 'Sounds', count: 412 }, { value: 'sets', label: 'Sets', count: 18 }, { value: 'songs', label: 'Songs', count: 3 }]} />
          <Chip on={chip} tone="ember" onClick={() => setChip(!chip)}>Needs attention {'·'} 23</Chip><Chip>classic</Chip><Chip onRemove={() => undefined}>{'×'} click</Chip><Chip tone="agent">agent</Chip><Chip tone="you">you</Chip>
        </div>
      </Sec>

      <Sec id="overlays" title="Keycap, tooltip, popover, toast, banner">
        <div className="row-w">
          <Kbd>{'⌘'}</Kbd><Keys combo={'⇧ ⌘ Z'} />
          <Tooltip text="Play the selection" shortcut="Space"><Button>Hover me</Button></Tooltip>
          <Popover open={pop} onClose={() => setPop(false)} label="Example popover" trigger={<Button onClick={() => setPop(!pop)}>Popover</Button>}><p className="pad">A box anchored to its trigger. Esc closes it.</p></Popover>
          <Button onClick={() => toast('Sent to the agent: “make the coin brighter” on coin_pickup')} testId="kit-toast">Toast</Button>
        </div>
        <Banner kind="warn" title="Lost the SoundClaw server at localhost:7427" actions={<Button kind="primary">Retry now</Button>}>Everything open keeps playing from the local render.</Banner>
        <Banner kind="info" title="Heads up">A polite note that does not take focus.</Banner>
      </Sec>

      <Sec id="views" title="Wave view and the windowed list">
        <WaveView wave={wave} duration={0.6} height={110} label="coin pickup" testId="kit-wave" cursor={0.12} selection={{ a: 0.2, b: 0.3 }}
          markers={[{ t: 0.142, kind: 'fail', label: 'click 0.142 s' }, { t: 0.38, end: 0.44, kind: 'warn', label: 'tail' }]} />
        <VirtualList count={5000} rowHeight={24} label="Five thousand rows" testId="kit-vlist" className="kit-vlist" renderRow={(i) => <div className="lib-row"><span className="new-dot" style={{ opacity: 0 }} /><span className="lib-name">sound_{String(i).padStart(4, '0')}</span><span className="mono lib-lufs">{'−'}{(14 + (i % 7)).toFixed(1)}</span></div>} />
      </Sec>
    </div>
  );
}

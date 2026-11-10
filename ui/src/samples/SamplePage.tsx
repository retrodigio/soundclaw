// `#/sample/<name>`: one sample. The lenses on a shared time axis with handles for trim, the loop and the slices (each gesture is one command, as an agent
// would write it), the numbers, the words, the advisory checks, where the audio came from and how its licence stands, and the actions: derive, make an
// instrument, generate again, ask for changes. Opened from a layer (`#/sample/<name>/layer/<sound>/<n>`), the trim handles write that layer's start and end.

import { useEffect, useMemo, useState } from 'react';
import { checkSample, type SampleCheck } from '@soundclaw/core';
import type { SampleDetail, SampleInfo } from '@soundclaw/server/protocol';
import type { Axis } from '../sound/Lenses.tsx';
import type { Store } from '../store.ts';
import { Badge, Button, Segmented, useToast } from '../studio/controls.tsx';
import { Play, Stop } from '../studio/icons.tsx';
import { LicenceBadge } from '../studio/Library.tsx';
import { useActions, type Action } from '../studio/registry.ts';
import { SourceMark } from '../studio/Samples.tsx';
import { fetchDetail, rowNumbers } from '../studio/samplesApi.ts';
import { markSampleSeen } from '../studio/sampleSeen.ts';
import { Dialog } from './Dialog.tsx';
import { DeriveDialog, GenerateAgainDialog, freeName } from './SampleDialogs.tsx';
import { AskDialog, RequestsPanel } from './SampleRequests.tsx';
import { SampleLens, type LensDrafts, type Tool } from './SampleLens.tsx';
import type { SampleLensReply } from './sample.worker.ts';
import { sampleWorker } from './sampleWorker.ts';

const MINUS = '−';
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1).replace('-', MINUS) : `${v < 0 ? MINUS : ''}∞`);

const TOOLS: { value: Tool; label: string; hint: string }[] = [
  { value: 'select', label: 'Select', hint: 'drag on the lens to choose a region; Play selection loops it' },
  { value: 'trim', label: 'Trim', hint: 'move the start and end handles' },
  { value: 'loop', label: 'Loop', hint: 'move the loop points; each release writes sample loop' },
  { value: 'slice', label: 'Slice', hint: 'click to add a marker, drag to move one, Delete removes the focused one' },
];

export function SamplePage({ store, name, layer }: { store: Store; name: string; layer?: { sound: string; n: number } | undefined }) {
  const info = store.samples.find((x) => x.name === name);
  useEffect(() => { markSampleSeen(store, name); }, [store, name]);
  if (!info) {
    return (
      <section className="sample-page" data-testid="sample-page" data-sample={name}>
        <a href="#/" className="back">{'←'} all sounds</a>
        <p className="empty" data-testid="sample-missing">{store.status === 'open' ? `No sample “${name}” in this project.` : 'Connecting…'}</p>
      </section>
    );
  }
  return <SampleView key={`${info.name}:${info.sha256}`} store={store} info={info} {...(layer ? { layer } : {})} />;
}

function SampleView({ store, info, layer }: { store: Store; info: SampleInfo; layer?: { sound: string; n: number } }) {
  const toast = useToast();
  const [detail, setDetail] = useState<SampleDetail | null>(null);
  const [lens, setLens] = useState<SampleLensReply | null>(null);
  const [lensError, setLensError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>(layer ? 'trim' : 'select');
  const [axis, setAxis] = useState<Axis>({ cursor: null, sel: null, t0: 0, t1: 0, level: 1 });
  const [dialog, setDialog] = useState<'derive' | 'again' | 'ask' | 'instrument' | null>(null);
  const [askAgain, setAskAgain] = useState<string | undefined>(undefined);
  const duration = lens?.duration ?? info.seconds;

  // the layer this page was opened from: its trim now
  const layerDoc = layer ? store.doc(layer.sound) : undefined;
  const layerLayer = layerDoc && layerDoc.voice === 'layered' ? layerDoc.layers[layer!.n - 1] : undefined;
  const layerTrim: [number, number] = [Number(layerLayer?.p.start ?? 0), Number(layerLayer?.p.end ?? 0) || duration];
  const [drafts, setDrafts] = useState<LensDrafts>({ trim: null, loop: null, slices: null });
  const [newName, setNewName] = useState(() => freeName(store, `${info.name}_trim`));
  useEffect(() => { if (layer) void store.docNow(layer.sound); }, [store, layer?.sound]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    setLensError(null);
    void sampleWorker.lens(store.token, info.sha256).then((l) => { if (live) setLens(l); }, (e: Error) => { if (live) setLensError(e.message); });
    return () => { live = false; };
  }, [store, info.sha256]);
  // the detail follows the tape: a licence set, a loop moved, a name used by a new sound
  useEffect(() => {
    let live = true;
    void fetchDetail(store, info.name).then((d) => { if (live) setDetail(d); }, () => undefined);
    return () => { live = false; };
  }, [store, info.name, store.tapeTotal, info.licence]);
  // the trim handles start at the whole sample (or the layer's own start and end)
  useEffect(() => {
    setDrafts((d) => ({ ...d, trim: d.trim ?? (layer ? layerTrim : [0, duration]), loop: null, slices: null }));
  }, [duration, layerTrim[0], layerTrim[1], tool]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (cmd: string, done?: string): Promise<boolean> => {
    const r = await store.run(cmd);
    if (r.ok) { if (done) toast(done); return true; }
    toast(r.errors.map((e) => e.message).join('; '), 'error');
    return false;
  };
  const frame = (t: number): number => Math.max(0, Math.min(info.frames, Math.round(t * info.rate)));

  const onTrim = (a: number, b: number) => {
    setDrafts((d) => ({ ...d, trim: [a, b] }));
    if (layer) void run(`layer set ${layer.sound} ${layer.n} start=${a.toFixed(4)} end=${(b >= duration - 1e-6 ? 0 : b).toFixed(4)}`);
  };
  const onLoop = (s: number, e: number) => {
    setDrafts((d) => ({ ...d, loop: [s / info.rate, e / info.rate] }));
    void run(`sample loop ${info.name} ${s}f ${e}f`).then(() => setDrafts((d) => ({ ...d, loop: null })));
  };
  const onSlices = (pts: number[]) => {
    void run(`sample slice ${info.name} at=${pts.map((f) => `${f}f`).join(',')}`).then(() => setDrafts((d) => ({ ...d, slices: null })));
  };
  const makeTrim = async () => {
    const [a, b] = drafts.trim ?? [0, duration];
    if (await run(`sample derive ${newName} from=${info.name} op="trim ${frame(a)}f ${frame(b)}f"`, `Made ${newName}`)) location.hash = `#/sample/${newName}`;
  };

  // a trim dragged on this page is a draft: nothing is written until Make (a derive), so say so while it differs from the whole sample
  const trimDirty = !layer && !!drafts.trim && (drafts.trim[0] > 1e-6 || drafts.trim[1] < duration - 1e-6);

  const checks: SampleCheck[] = useMemo(() => (lens ? checkSample(lens.measure, { frames: info.frames, rate: info.rate, ...(info.slices ? { slices: info.slices } : {}) }, []) : []), [lens, info.frames, info.rate, info.slices]);
  const playing = store.playing === `sample:${info.name}`;
  const playSelection = () => {
    if (axis.sel && axis.sel.b > axis.sel.a) void store.playSample(info.name, { region: [axis.sel.a, axis.sel.b], loop: true });
    else void store.playSample(info.name);
  };
  const actions: Action[] = [
    { id: 'sample.play', label: 'Sample: play (the selection loops)', group: 'Samples', run: playSelection, keywords: 'audition selection' },
    { id: 'transport.loop', label: 'Play the focused item looping (the selection, if there is one)', group: 'Transport', shortcut: 'L', key: 'l', override: true, run: () => { if (axis.sel) playSelection(); else void store.playSample(info.name, { loop: true }); } },
    { id: 'sample.derive', label: 'Sample: derive a new sample from this one', group: 'Samples', run: () => setDialog('derive'), keywords: 'trim fade normalize reverse pitch' },
    { id: 'sample.tool.trim', label: 'Sample tool: trim', group: 'Samples', run: () => setTool('trim') },
    { id: 'sample.tool.loop', label: 'Sample tool: loop points', group: 'Samples', run: () => setTool('loop') },
    { id: 'sample.tool.slice', label: 'Sample tool: slice markers', group: 'Samples', run: () => setTool('slice') },
    { id: 'sample.tool.select', label: 'Sample tool: select a region', group: 'Samples', run: () => setTool('select') },
  ];
  useActions(actions);

  const fmtSecs = (v: number): string => (v < 10 ? v.toFixed(3) : v.toFixed(2));
  const m = lens?.measure;
  const used = detail ? detail.usedBy.sounds.length + detail.usedBy.instruments.length + detail.usedBy.songs.length + detail.usedBy.samples.length : 0;

  return (
    <section className="sample-page" data-testid="sample-page" data-sample={info.name}>
      <header className="sp-head">
        <a href="#/" className="back" data-testid="sample-back">{'←'} library</a>
        <h1 data-testid="sample-title">{info.name}</h1>
        <SourceMark source={info.source} />
        <LicenceBadge state={info.licenceState} licence={info.licence} testId="sample-page-licence" />
        <span className="mono dim" data-testid="sample-meta">{rowNumbers(info.seconds, lens ? { hash: info.sha256, m: lens.measure, peaks: { min: [], max: [] } } : undefined, info.root)} {'·'} {Number((info.rate / 1000).toFixed(1))} kHz {'·'} {info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} ch`} {'·'} {info.format}</span>
        {layer && <span className="chip-c tone-you" data-testid="sample-from-layer">trim writes {layer.sound} layer {layer.n}</span>}
        {trimDirty && <button type="button" className="chip-c tone-warn" data-testid="sample-unsaved-trim" onClick={() => setTool('trim')} title="A trim you have not made yet: open the Trim tool to Make or Reset it"><span className="mono" aria-hidden>{'●'}</span>unsaved trim</button>}
      </header>
      <div className="sp-actions">
        <Button kind="secondary" testId="sample-play" icon={playing ? <Stop size={9} /> : <Play size={9} />} onClick={playSelection} title="Play the sample, or loop the selected region">{playing ? 'Stop' : axis.sel ? 'Play selection' : 'Play'}</Button>
        <Button kind="secondary" testId="sample-derive" onClick={() => setDialog('derive')}>Derive{'…'}</Button>
        <Button kind="secondary" testId="sample-instrument" onClick={() => setDialog('instrument')}>Make instrument{'…'}</Button>
        {info.source === 'generated' && <Button kind="agent" testId="sample-again" onClick={() => setDialog('again')}>Generate again{'…'}</Button>}
        <Button kind="quiet" testId="sample-ask" onClick={() => { setAskAgain(undefined); setDialog('ask'); }} title="Ask the agent to change this sample (or a sound that plays it)">Ask for changes{'…'}</Button>
      </div>

      <div className="sp-tools">
        <Segmented<Tool> label="Tool" value={tool} onChange={setTool} testId="sample-tools" options={TOOLS.map((t) => ({ value: t.value, label: t.label, testId: `tool-${t.value}` }))} />
        <span className="dim sp-tool-hint">{TOOLS.find((t) => t.value === tool)!.hint}</span>
      </div>

      <SampleLens store={store} info={info} lens={lens} loading={lensError ?? null} tool={tool} drafts={drafts} setDrafts={(f) => setDrafts(f)} onTrim={onTrim} onLoop={onLoop} onSlices={onSlices} onAxis={setAxis} />
      {lensError && <p className="smp-error" role="alert" data-testid="sample-lens-error"><span className="mono" aria-hidden>!</span> {lensError}</p>}

      <div className="sp-toolbar" data-testid="tool-bar" data-tool={tool}>
        {tool === 'select' && (
          <>
            <span className="mono" data-testid="tool-select-info">{axis.sel ? `selected ${fmtSecs(axis.sel.a)}–${fmtSecs(axis.sel.b)} s (${((axis.sel.b - axis.sel.a) * 1000).toFixed(0)} ms)` : 'nothing selected'}</span>
            <Button kind="quiet" testId="select-play" disabled={!axis.sel} onClick={playSelection}>Play selection (loops)</Button>
            <Button kind="quiet" testId="select-trim" disabled={!axis.sel} onClick={() => { if (axis.sel) { setDrafts((d) => ({ ...d, trim: [axis.sel!.a, axis.sel!.b] })); setTool('trim'); } }}>Trim to selection</Button>
          </>
        )}
        {tool === 'trim' && (
          <>
            <span className="mono" data-testid="trim-info">{drafts.trim ? `${fmtSecs(drafts.trim[0])}–${fmtSecs(drafts.trim[1])} s (${fmtSecs(drafts.trim[1] - drafts.trim[0])} s kept)` : ''}</span>
            {layer ? (
              <span className="dim" data-testid="trim-layer-note">each release writes <code className="mono">layer set {layer.sound} {layer.n} start= end=</code></span>
            ) : (
              <>
                <label className="sp-inline">as<input value={newName} onChange={(e) => setNewName(e.target.value.toLowerCase())} data-testid="trim-name" spellCheck={false} aria-label="Name of the trimmed sample" /></label>
                <Button kind="primary" testId="trim-make" disabled={!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(newName) || store.samples.some((x) => x.name === newName) || !drafts.trim || (drafts.trim[0] <= 0 && drafts.trim[1] >= duration - 1e-6)} onClick={() => void makeTrim()}>Make {newName}</Button>
                {trimDirty ? <span className="chip-c tone-warn" role="status" data-testid="trim-unsaved"><span className="mono" aria-hidden>{'●'}</span>unsaved trim: nothing is written until Make</span> : <span className="dim" data-testid="trim-saved-note">drag the handles; Make writes a new sample and the original stays as it is</span>}
              </>
            )}
            <Button kind="quiet" testId="trim-reset" disabled={!layer && !trimDirty} onClick={() => setDrafts((d) => ({ ...d, trim: [0, duration] }))}>Reset</Button>
          </>
        )}
        {tool === 'loop' && (
          <>
            <span className="mono" data-testid="loop-info">{info.loop ? `loop ${info.loop[0]}–${info.loop[1]} frames (${((info.loop[1] - info.loop[0]) / info.rate).toFixed(3)} s)${info.loopMode ? `, ${info.loopMode}` : ''}` : 'no loop'}</span>
            <Button kind="secondary" testId="loop-find" onClick={() => void run(`sample loop ${info.name} find`, 'Looked for the best loop')}>Find loop</Button>
            <Button kind="quiet" testId="loop-from-selection" disabled={!axis.sel} onClick={() => axis.sel && onLoop(frame(axis.sel.a), frame(axis.sel.b))}>Set from selection</Button>
            <Button kind="quiet" testId="loop-clear" disabled={!info.loop} onClick={() => void run(`sample set ${info.name} loop=none loopmode=none`)}>Clear</Button>
          </>
        )}
        {tool === 'slice' && (
          <>
            <span className="mono" data-testid="slice-info">{info.slices?.length ? `${info.slices.length} slice${info.slices.length === 1 ? '' : 's'}` : 'no slices'}</span>
            <Button kind="secondary" testId="slice-onsets" onClick={() => void run(`sample slice ${info.name} at=onsets`, 'Slices at the onsets')}>Find onsets</Button>
            <Button kind="quiet" testId="slice-clear" disabled={!info.slices?.length} onClick={() => void run(`sample set ${info.name} slices=none`)}>Clear</Button>
          </>
        )}
      </div>

      <div className="sp-lower">
        <div className="sp-col">
          <h2 className="cap">Numbers</h2>
          <div className="sp-numbers" data-testid="sample-numbers">
            {!m ? <span className="dim">measuring{'…'}</span> : (
              [
                ['length', `${m.duration.toFixed(3)} s`], ['loudness', `${f1(m.lufs)} LUFS`], ['peak', `${f1(m.peakDb)} dBFS`], ['true peak', `${f1(m.truePeakDb)} dBTP`],
                ['centroid', m.centroid >= 1000 ? `${(m.centroid / 1000).toFixed(1)} kHz` : `${Math.round(m.centroid)} Hz`], ['attack', `${m.attackMs < 10 ? m.attackMs.toFixed(1) : Math.round(m.attackMs)} ms`],
                ['pitch', m.pitch ? `${m.pitch.note}${Math.round(m.pitch.cents) ? ` ${Math.round(m.pitch.cents) > 0 ? '+' : ''}${Math.round(m.pitch.cents)}c` : ''}${m.pitched ? '' : ' (weak)'}` : 'none'],
                ['onsets', `${m.onsets.count}${m.tempo ? ` · ${Math.round(m.tempo)} bpm` : ''}`], ['noise floor', `${f1(m.noiseFloorDb)} dBFS`], ['harmonic/noise', `${f1(m.hnrDb)} dB`],
                ['silence', `${Math.round(m.silenceStartMs)} / ${Math.round(m.silenceEndMs)} ms`], ['stereo width', m.channels > 1 ? m.stereoWidth.toFixed(2) : 'mono'],
              ].map(([k, v]) => <div key={k} className="num-card" data-testid={`snum-${k!.replace(/[ /]/g, '-')}`}><span className="cap">{k}</span><span className="mono num-v">{v}</span></div>)
            )}
          </div>
          {lens && <p className="sp-words" data-testid="sample-words">{lens.words.join(' ')}</p>}
          <h2 className="cap">Checks <span className="dim">advice only: a sample is material</span></h2>
          <ul className="sp-checks" data-testid="sample-checks">
            {checks.map((c) => (
              <li key={c.name} data-ok={c.ok} data-testid={`scheck-${c.name}`}><Badge kind={c.ok ? 'pass' : c.severity === 'warn' ? 'warn' : 'pass'}>{c.name}</Badge><span>{c.message}</span></li>
            ))}
            {!lens && <li className="dim">measuring{'…'}</li>}
          </ul>
        </div>

        <div className="sp-col">
          <Provenance store={store} info={info} detail={detail} run={run} />
          <RequestsPanel store={store} name={info.name} onAgain={(id) => { setAskAgain(id); setDialog('ask'); }} />
          <h2 className="cap">Used by</h2>
          <div className="sp-usedby" data-testid="sample-usedby">
            {detail && used === 0 && <span className="dim">nothing plays it yet</span>}
            {detail?.usedBy.sounds.map((s) => <a key={`s${s}`} className="chip-c" href={`#/sound/${s}`} data-testid={`used-sound-${s}`}>sound {s}</a>)}
            {detail?.usedBy.instruments.map((s) => <span key={`i${s}`} className="chip-c" data-testid={`used-instrument-${s}`}>instrument {s}</span>)}
            {detail?.usedBy.songs.map((s) => <a key={`g${s}`} className="chip-c" href={`#/song/${s}`} data-testid={`used-song-${s}`}>song {s}</a>)}
            {detail?.usedBy.samples.map((s) => <a key={`m${s}`} className="chip-c" href={`#/sample/${s}`} data-testid={`used-sample-${s}`}>made into {s}</a>)}
          </div>
        </div>
      </div>

      {dialog === 'derive' && <DeriveDialog store={store} info={info} onClose={() => setDialog(null)} onMade={(n) => { setDialog(null); location.hash = `#/sample/${n}`; }} />}
      {dialog === 'again' && <GenerateAgainDialog store={store} info={info} onClose={() => setDialog(null)} />}
      {dialog === 'ask' && <AskDialog store={store} info={info} sounds={detail?.usedBy.sounds ?? []} selection={axis.sel && axis.sel.b > axis.sel.a ? [axis.sel.a, axis.sel.b] : null} again={askAgain} onClose={() => { setDialog(null); setAskAgain(undefined); }} />}
      {dialog === 'instrument' && <InstrumentDialog store={store} info={info} onClose={() => setDialog(null)} />}
    </section>
  );
}

// ---- where it came from and how it stands ---------------------------------------------------------------------------------

const LICENCES = ['own', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'unknown'];

function Provenance({ store, info, detail, run }: { store: Store; info: SampleInfo; detail: SampleDetail | null; run(cmd: string, done?: string): Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [lic, setLic] = useState(info.licence);
  const [attr, setAttr] = useState('');
  const p = detail?.prov;
  const row = (k: string, v: React.ReactNode, id: string) => (v === undefined || v === null || v === '' ? null : <div key={id} className="sp-row" data-testid={`prov-${id}`}><dt>{k}</dt><dd>{v}</dd></div>);
  const save = async () => {
    const cmd = `sample set ${info.name} licence=${lic}${attr.trim() ? ` attribution=${JSON.stringify(attr.trim())}` : ''}`;
    if (await run(cmd, `Licence of ${info.name} set to ${lic}`)) setEditing(false);
  };
  const credit = (id: string) => (id === 'unknown' ? 'unknown' : id);
  return (
    <>
      <h2 className="cap">Where it came from</h2>
      {!detail || !p ? <p className="dim">loading{'…'}</p> : (
        <dl className="sp-prov" data-testid="sample-provenance">
          {row('source', <SourceMark source={p.source} />, 'source')}
          {row('origin', p.origin ? <span className="mono">{p.origin}</span> : null, 'origin')}
          {row('prompt', p.prompt ? <q>{p.prompt}</q> : null, 'prompt')}
          {row('made by', p.provider ? <span className="mono">{p.provider}{p.endpoint ? ` ${p.endpoint}` : ''}{p.model ? ` (${p.model})` : ''}</span> : null, 'provider')}
          {row('kept from', p.keptFrom ? <span className="mono">take {p.keptFrom}</span> : null, 'kept-from')}
          {row('take', p.take ? <span className="mono">{p.take}{p.credits !== undefined ? ` · ${p.credits} credits` : ''}{p.seed !== undefined ? ` · seed ${p.seed}` : ''}</span> : null, 'take')}
          {row('request', p.request ? <span className="mono">{p.request}</span> : null, 'request')}
          {row('parents', p.parents ? p.parents.map((x, i) => (x.name ? <a key={i} href={`#/sample/${x.name}`}>{x.name}</a> : <span key={i} className="mono">{x.hash.slice(0, 12)}</span>)).reduce<React.ReactNode[]>((a, n, i) => (i ? [...a, ', ', n] : [n]), []) : null, 'parents')}
          {row('operations', p.ops ? <span className="mono">{p.ops}</span> : null, 'ops')}
          {row('original', p.origHash ? <span className="mono" title={p.origHash}>{p.origHash.slice(0, 12)}{p.origFormat ? ` · ${p.origFormat}` : ''}</span> : null, 'orig')}
          {row('instrument file', p.containerHash ? <span className="mono" title={p.containerHash}>{p.containerHash.slice(0, 12)}</span> : null, 'container')}
          {row('added', <span className="mono">{p.author ?? 'unknown'}{p.date ? ` · ${p.date.slice(0, 10)}` : ''}</span>, 'added')}
          {row('audio', <span className="mono" title={info.sha256}>{info.sha256.slice(0, 12)}</span>, 'hash')}
          {row('note', detail.meta.note, 'note')}
        </dl>
      )}
      <h2 className="cap">Licence</h2>
      <div className="sp-licence" data-testid="sample-licence-panel">
        <div className="sp-lic-line"><LicenceBadge state={info.licenceState} licence={info.licence} testId="sample-licence-state" /><span className="mono">{credit(info.licence)}</span>
          <button type="button" className="link-btn" data-testid="licence-edit" onClick={() => { setLic(info.licence); setAttr(detail?.licence.attribution ?? ''); setEditing(!editing); }}>{editing ? 'cancel' : 'set'}</button></div>
        {detail && <p className="dim sp-lic-why" data-testid="licence-reason">{detail.licence.reason}</p>}
        {detail?.licence.attribution && <p className="sp-lic-attr">{detail.licence.attribution}</p>}
        {detail?.licence.terms && <p className="dim mono">{detail.licence.terms}</p>}
        {editing && (
          <form className="smp-form" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="licence-form">
            <label>licence<select value={LICENCES.includes(lic) ? lic : 'custom'} onChange={(e) => setLic(e.target.value)} data-testid="licence-select">{[...(LICENCES.includes(lic) ? [] : [lic]), ...LICENCES].map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
            <label>attribution<input value={attr} onChange={(e) => setAttr(e.target.value)} data-testid="licence-attribution" placeholder="who to credit, if the licence asks" /></label>
            <div className="smp-form-actions"><button type="submit" className="btn btn-primary" data-testid="licence-save">Set licence</button></div>
            <p className="dim smp-hint">SoundClaw records licences and gives no legal advice. It never guesses one.</p>
          </form>
        )}
      </div>
    </>
  );
}

// ---- the dialogs that are small -------------------------------------------------------------------------------------------

function InstrumentDialog({ store, info, onClose }: { store: Store; info: SampleInfo; onClose(): void }) {
  const toast = useToast();
  const base = `i_${info.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 44);
  const taken = (id: string) => store.instruments.some((x) => x.id === id);
  const [id, setId] = useState(() => { let n = base, k = 2; while (taken(n)) n = `${base}_${k++}`; return n; });
  const [find, setFind] = useState(!info.loop);
  const [root, setRoot] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rootOk = !root.trim() || /^[A-G][#b]?-?\d$/.test(root.trim());
  const valid = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(id) && !taken(id) && rootOk;
  const go = async () => {
    // a root note given here is set on the sample first, in the same batch (one undo group)
    const r = await store.run([...(root.trim() ? [`sample set ${info.name} root=${root.trim()}`] : []), `instrument from-sample ${id} ${info.name}${find ? ' loop=find' : ''}`].join('\n'));
    if (r.ok) { toast(`Made instrument ${id} from ${info.name}`); onClose(); } else setError(r.errors.map((e) => e.message).join('; '));
  };
  return (
    <Dialog title={`Make an instrument from ${info.name}`} onClose={onClose} testId="instrument-dialog">
      <form className="smp-form" onSubmit={(e) => { e.preventDefault(); if (valid) void go(); }}>
        <label>instrument<input value={id} onChange={(e) => setId(e.target.value)} data-testid="instrument-id" aria-invalid={!valid} spellCheck={false} /></label>
        {info.root === undefined && <label>root note (if it has no steady pitch)<input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="C4" data-testid="instrument-root" aria-invalid={!rootOk} spellCheck={false} /></label>}
        <label className="smp-confirm"><input type="checkbox" checked={find} onChange={(e) => setFind(e.target.checked)} data-testid="instrument-loop" />look for a loop so a held note sustains{info.loop ? ' (it has one already: this finds a better one)' : ''}</label>
        <p className="dim smp-hint">One zone across the keyboard, rooted where the sample sounds. Add more samples and zones later. The command is <code className="mono">instrument from-sample {id} {info.name}</code>.</p>
        {error && <p className="smp-error" role="alert"><span className="mono" aria-hidden>!</span> {error}</p>}
        <div className="smp-form-actions"><button type="submit" className="btn btn-primary" disabled={!valid} data-testid="instrument-go">Make instrument</button><button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button></div>
      </form>
    </Dialog>
  );
}


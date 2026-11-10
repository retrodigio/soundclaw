// The Samples views' overlays: the window-wide drop target, the import dialog (what the files are, under which licence) and the microphone recorder.
// Files dropped anywhere on the window, or chosen from the palette, are uploaded as the person; a recording is uploaded the same way as `recorded`.

import { useEffect, useMemo, useRef, useState } from 'react';
import { pcmFromFloats, pcmToWav } from '@soundclaw/core';
import type { Store } from '../store.ts';
import { useToast } from '../studio/controls.tsx';
import { Dialog } from './Dialog.tsx';
import { Recorder } from './recorder.ts';
import { closeImport, closeRecorder, filesOfDrop, openImport, setDragging, useSamplesUi } from './samplesUi.ts';

const LICENCES: { id: string; note: string }[] = [
  { id: 'unknown', note: 'not known yet: the tool never guesses, and a manifest export refuses it until you set one' },
  { id: 'own', note: 'you made it' },
  { id: 'CC0-1.0', note: 'public domain' },
  { id: 'CC-BY-4.0', note: 'ships with credit' },
  { id: 'CC-BY-SA-4.0', note: 'ships with credit' },
  { id: 'CC-BY-NC-4.0', note: 'non-commercial: blocked from shipping by default' },
];
const MAX_BYTES = 200 * 1048576;
const AUDIO_EXT = /\.(wav|aiff?|aifc|flac|ogg|oga|opus|mp3|m4a|aac)$/i;

const sizeText = (n: number): string => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

function ImportDialog({ store, files, onClose }: { store: Store; files: File[]; onClose(): void }) {
  const toast = useToast();
  const audio = useMemo(() => files.filter((f) => AUDIO_EXT.test(f.name)), [files]);
  const skipped = files.length - audio.length;
  const [licence, setLicence] = useState('unknown');
  const [attribution, setAttribution] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errors, setErrors] = useState<{ file: string; error: string }[]>([]);
  const single = audio.length === 1;
  const [as, setAs] = useState(() => (single ? audio[0]!.name.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').toLowerCase().slice(0, 48) : ''));
  const go = async () => {
    setBusy(true); setErrors([]);
    const bad: { file: string; error: string }[] = [];
    const made: string[] = [];
    for (let i = 0; i < audio.length; i++) {
      setProgress(i);
      const f = audio[i]!;
      if (f.size > MAX_BYTES) { bad.push({ file: f.name, error: `larger than ${MAX_BYTES / 1048576} MB` }); continue; }
      const r = await store.uploadSample(f, f.name, { licence, ...(attribution.trim() ? { attribution: attribution.trim() } : {}), ...(tags.trim() ? { tags: tags.trim() } : {}), ...(single && as ? { as } : {}) });
      if (r.ok) made.push(...r.names); else bad.push({ file: f.name, error: r.error });
    }
    setBusy(false);
    if (made.length) toast(`Imported ${made.length} sample${made.length === 1 ? '' : 's'}${licence === 'unknown' ? ' (licence unknown: set it before you ship)' : ''}`);
    if (bad.length) setErrors(bad); else onClose();
    if (made.length && single) location.hash = `#/sample/${made[0]}`;
  };
  return (
    <Dialog title={`Import ${audio.length} audio file${audio.length === 1 ? '' : 's'}`} onClose={onClose} testId="import-dialog" wide>
      <form className="smp-form" onSubmit={(e) => { e.preventDefault(); if (audio.length && !busy) void go(); }}>
        <ul className="smp-files" data-testid="import-files">
          {audio.slice(0, 12).map((f) => <li key={f.name + f.size}><span className="mono">{f.name}</span><span className="dim mono">{sizeText(f.size)}</span></li>)}
          {audio.length > 12 && <li className="dim">and {audio.length - 12} more</li>}
        </ul>
        {skipped > 0 && <p className="smp-error warn" role="status" data-testid="import-skipped"><span className="mono" aria-hidden>!</span> {skipped} file{skipped === 1 ? ' is' : 's are'} not WAV, AIFF, FLAC, OGG, MP3 or M4A and will not be imported</p>}
        {single && <label>name<input value={as} onChange={(e) => setAs(e.target.value.toLowerCase())} data-testid="import-name" spellCheck={false} /></label>}
        <label>licence
          <select value={licence} onChange={(e) => setLicence(e.target.value)} data-testid="import-licence">{LICENCES.map((l) => <option key={l.id} value={l.id}>{l.id}</option>)}</select>
        </label>
        <p className="dim smp-hint" data-testid="import-licence-note">{LICENCES.find((l) => l.id === licence)?.note}. SoundClaw records licences and gives no legal advice.</p>
        {licence.startsWith('CC-BY') && <label>attribution<input value={attribution} onChange={(e) => setAttribution(e.target.value)} data-testid="import-attribution" placeholder="who to credit" /></label>}
        <label>tags (optional)<input value={tags} onChange={(e) => setTags(e.target.value)} data-testid="import-tags" placeholder="door, wood, close" spellCheck={false} /></label>
        {busy && <p className="mono dim" role="status" data-testid="import-progress">importing {progress + 1} of {audio.length}{'…'}</p>}
        {errors.map((x) => <p key={x.file} className="smp-error" role="alert" data-testid="import-error"><span className="mono" aria-hidden>!</span> {x.file}: {x.error}</p>)}
        <div className="smp-form-actions"><button type="submit" className="btn btn-primary" disabled={!audio.length || busy} data-testid="import-go">Import</button><button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button></div>
      </form>
    </Dialog>
  );
}

// ---- recording -----------------------------------------------------------------------------------------------------------

type Phase = 'opening' | 'ready' | 'counting' | 'recording' | 'done' | 'error';

function RecordDialog({ store, onClose }: { store: Store; onClose(): void }) {
  const toast = useToast();
  const rec = useRef<Recorder>(new Recorder());
  const [phase, setPhase] = useState<Phase>('opening');
  const [error, setError] = useState<string | null>(null);
  const [countIn, setCountIn] = useState(0);
  const [count, setCount] = useState(0);
  const [secs, setSecs] = useState(0);
  const [result, setResult] = useState<{ rate: number; channels: Float32Array[]; seconds: number } | null>(null);
  const [name, setName] = useState(() => { let n = 1; while (store.samples.some((x) => x.name === `rec_${n}`)) n++; return `rec_${n}`; });
  const [own, setOwn] = useState(false);
  const [busy, setBusy] = useState(false);
  const meter = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<Phase>('opening');
  phaseRef.current = phase;

  useEffect(() => {
    const r = rec.current;
    let live = true;
    r.open().then(() => { if (live) setPhase('ready'); }, (e: Error) => { if (live) { setError(e.name === 'NotAllowedError' ? 'The microphone was not allowed. Allow it for this address in the browser, then try again.' : e.name === 'NotFoundError' ? 'No microphone was found.' : e.message); setPhase('error'); } });
    // the input meter and the length, read straight off the recorder every frame
    let raf = 0, started = 0, db = -90;
    const tick = () => {
      const lv = r.level();
      const now = lv > 0 ? 20 * Math.log10(lv) : -90;
      db = Math.max(now, db - 1.2);
      if (meter.current) { meter.current.style.setProperty('--level', `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`); meter.current.dataset.db = db.toFixed(0); meter.current.dataset.clip = lv >= 0.99 ? 'true' : 'false'; }
      if (phaseRef.current === 'recording') { started ||= performance.now(); setSecs((performance.now() - started) / 1000); } else started = 0;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { live = false; cancelAnimationFrame(raf); void r.close(); };
  }, []);

  const start = () => {
    const r = rec.current;
    if (countIn === 0) { r.capture(); setPhase('recording'); return; }
    setPhase('counting');
    let n = countIn;
    setCount(n);
    r.tick(true);
    const t = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(t); r.capture(); setPhase('recording'); return; }
      setCount(n); r.tick();
    }, 1000);
  };
  const stop = () => { setResult(rec.current.finish()); setPhase('done'); };
  const valid = /^[a-z0-9][a-z0-9_-]{0,47}$/.test(name) && !store.samples.some((x) => x.name === name) && !!result && result.seconds > 0;
  const save = async () => {
    if (!result || !valid || !own) return;
    setBusy(true);
    const wav = pcmToWav(pcmFromFloats(result.channels, result.rate, 'f32'));
    const r = await store.uploadSample(new Blob([wav as BlobPart], { type: 'audio/wav' }), `${name}.wav`, { as: name, licence: 'own', source: 'recorded', origin: 'microphone', tags: 'recorded' });
    setBusy(false);
    if (r.ok) { toast(`Saved ${r.names[0] ?? name}: ${result.seconds.toFixed(1)} s at ${result.rate} Hz`); onClose(); location.hash = `#/sample/${r.names[0] ?? name}`; } else toast(r.error, 'error');
  };
  // the take plays through the page's own player before it is saved
  const preview = () => {
    if (!result) return;
    const ctx = new AudioContext({ sampleRate: result.rate });
    const buf = ctx.createBuffer(result.channels.length, result.channels[0]!.length, result.rate);
    result.channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => void ctx.close();
    src.start();
  };
  return (
    <Dialog title="Record from the microphone" onClose={onClose} testId="record-dialog">
      <div className="smp-form">
        {phase === 'opening' && <p className="dim" data-testid="record-opening">starting the microphone{'…'}</p>}
        {phase === 'error' && <p className="smp-error" role="alert" data-testid="record-error"><span className="mono" aria-hidden>!</span> {error}</p>}
        {phase !== 'error' && phase !== 'opening' && (
          <>
            <div className="smp-meter" ref={meter} role="meter" aria-label="Input level" aria-valuemin={-60} aria-valuemax={0} data-testid="record-meter" data-db="-90"><span className="smp-meter-fill" /><span className="mono smp-meter-clip" aria-hidden>clip</span></div>
            <p className="mono dim" data-testid="record-status" data-phase={phase}>
              {phase === 'ready' && `listening at ${rec.current.rate} Hz`}
              {phase === 'counting' && `starting in ${count}…`}
              {phase === 'recording' && `recording ${secs.toFixed(1)} s`}
              {phase === 'done' && result && (result.seconds > 0 ? `${result.seconds.toFixed(2)} s recorded at ${result.rate} Hz, ${result.channels.length === 1 ? 'mono' : 'stereo'}; nothing is trimmed` : 'nothing was recorded: no audio came while recording')}
            </p>
          </>
        )}
        {(phase === 'ready' || phase === 'counting' || phase === 'recording') && (
          <div className="smp-form-actions">
            {phase === 'ready' && <>
              <label className="sp-inline">count-in<select value={countIn} onChange={(e) => setCountIn(Number(e.target.value))} data-testid="record-countin"><option value={0}>none</option><option value={1}>1 beat</option><option value={3}>3 beats</option></select></label>
              <button type="button" className="btn btn-primary" onClick={start} data-testid="record-start">Record</button>
            </>}
            {phase === 'recording' && <button type="button" className="btn btn-danger" onClick={stop} data-testid="record-stop">Stop</button>}
          </div>
        )}
        {phase === 'done' && result && (
          <form className="smp-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <label>name<input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} data-testid="record-name" aria-invalid={!valid} spellCheck={false} /></label>
            <label className="smp-confirm"><input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} data-testid="record-own" />I recorded this myself: the licence is {'“'}own{'”'}</label>
            <div className="smp-form-actions">
              <button type="button" className="btn btn-secondary" onClick={preview} data-testid="record-preview">Listen</button>
              <button type="submit" className="btn btn-primary" disabled={!valid || !own || busy} data-testid="record-save">Save as a sample</button>
              <button type="button" className="btn btn-quiet" onClick={() => { setResult(null); setOwn(false); setPhase('ready'); }} data-testid="record-again">Record again</button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}

// ---- the host ------------------------------------------------------------------------------------------------------------

export function SamplesHost({ store }: { store: Store }) {
  const ui = useSamplesUi();
  // files dragged over the window (not a dragged sample row, which carries no file)
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; depth++; setDragging(true); };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; setDragging(false);
      void filesOfDrop(e.dataTransfer!).then(openImport);
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, []);
  return (
    <>
      {ui.dragging && <div className="smp-dropveil" data-testid="drop-veil" role="presentation"><div><b>Drop audio to import</b><span>WAV, AIFF, FLAC, OGG, MP3 or M4A, or a folder of them</span></div></div>}
      {ui.files && <ImportDialog store={store} files={ui.files} onClose={closeImport} />}
      {ui.recording && <RecordDialog store={store} onClose={closeRecorder} />}
    </>
  );
}

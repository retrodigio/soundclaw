// `#/sound/<id>/analysis`: the five lenses of one sound on a page of their own, with the command
// that prints the same numbers.

import type { Store } from '../store.ts';
import { LensPanel } from './Lenses.tsx';

export function AnalysisPage({ store, id }: { store: Store; id: string }) {
  const sound = store.sounds.find((s) => s.id === id);
  if (!sound) return <section className="editor"><a href="#/" className="back">← all sounds</a><p className="empty" data-testid="editor-missing">No sound “{id}”.</p></section>;
  const prov = store.provenance(id);
  const data = store.lens(sound);
  const kind = sound.voice === 'classic' ? 'classic' : sound.voice === 'layered' ? `layered · ${sound.layers.length} layer${sound.layers.length === 1 ? '' : 's'}` : 'tone';
  const seed = sound.voice === 'classic' ? ` · seed ${sound.patch.seed ?? 'auto'}` : sound.voice === 'layered' ? ` · seed ${sound.seed}` : '';
  const dir = store.project?.dir ?? '<project>';
  return (
    <section className="analysis" data-testid="analysis-page" data-sound={id}>
      <header className="analysis-head">
        <a href={`#/sound/${id}`} className="back" data-testid="back-to-editor">← editor</a>
        <h1>{id}</h1>
        <span className="mono dim" data-testid="analysis-meta">{kind}{data ? ` · ${data.duration.toFixed(2)} s` : ''}{seed}</span>
      </header>
      <LensPanel store={store} sound={sound} height="fill" prov={prov} outline={prov.beforeAgent} previous={prov.before} />
      <div className="lens-foot">
        <span>1–5 switch lens · the cursor, selection and zoom stay put</span>
        <span>Click a flag to jump to it and loop it</span>
        <span>These are the numbers the agent reads: <code className="mono" data-testid="measure-command">soundclaw measure {dir} {id} --json</code></span>
      </div>
    </section>
  );
}

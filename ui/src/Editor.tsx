// The editor page of a sound: the layer editor for layered sounds, the classic editor (modules,
// drawn envelope, inspector) for the rest, and the placeholder tone voice's note.

import { LayeredEditor } from './LayeredEditor.tsx';
import { ClassicEditor } from './sound/ClassicEditor.tsx';
import type { Store } from './store.ts';

/** The editor page of a sound: the layer editor for layered sounds, the sliders of the classic voice for the rest. */
export function Editor({ store, id }: { store: Store; id: string }) {
  const sound = store.sounds.find((s) => s.id === id);
  if (sound?.voice === 'layered') return <LayeredEditor store={store} id={id} />;
  return <ClassicEditor store={store} id={id} />;
}

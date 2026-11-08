import type { Store } from './store.ts';
import { Shell } from './studio/Shell.tsx';

/** The dashboard: the shell hosts the pages (see studio/Shell.tsx). */
export function App({ store }: { store: Store }) {
  return <Shell store={store} />;
}

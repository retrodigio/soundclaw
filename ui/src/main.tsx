import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Store } from './store.ts';
import './studio/tokens.css';
import './styles.css';
import './studio/studio.css';
import './studio/shell.css';
import './studio/agent.css';
import './sound/sound.css';
import './sets/sets.css';
import './song/song.css';
import './samples/samples.css';

const token = new URLSearchParams(location.search).get('token') ?? '';
const store = new Store();
store.connect(token);
// For tests and debugging: the store behind the page.
(window as unknown as { soundclaw: Store }).soundclaw = store;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

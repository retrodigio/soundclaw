import type { Sound } from '@soundclaw/core';
import type { Store } from './store.ts';

/** The sound's loudness class: which rule holds it (class, target, why) and a menu to change it, written as `sound set <id> class=<name>` like any edit. */
export function LoudnessClass({ store, sound }: { store: Store; sound: Sound }) {
  const rule = store.rule(sound);
  return (
    <span className="dim" data-testid="loudness-rule">
      <label>class{' '}
        <select data-testid="loudness-class" value={sound.loudClass ?? ''} onChange={(e) => void store.run(`sound set ${sound.id} class=${e.target.value || 'none'}`)}>
          <option value="">default ({store.style.defaultClass})</option>
          {store.classNames().map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      {' '}<span data-testid="loudness-target" title={rule.basis}>{rule.target.toFixed(1)} LUFS ±{rule.tolerance}</span>
    </span>
  );
}

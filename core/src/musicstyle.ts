// The project's music style guide and music bible: two Markdown files people write and the agent
// reads. Data lines are `key: value` (a leading `- ` is allowed); everything else is prose.
//
// music-style.md: what the music of the project is held to, by the `style` check.
//   tempo: 80-140          scales: major, dorian, pentatonic-major      key: D:major (the project's key)
//   instruments: square_lead, saw_pad, triangle_bass, kick, snare, hat   loudness: music, stinger
//   swing: 0-0.3           forbid: drums in town     forbid: accidentals     forbid: locrian
//   ## town                (rules for songs tagged town: they replace the ones above, forbids add up)
//
// music-bible.md: one entry per track, a `## <id>` heading and its data:
//   mood: warm, unhurried   tempo: 96   key: D:major   time: 4/4   tags: town
//   instruments: lead=square_lead, pad=saw_pad, bass=triangle_bass, drums=kit
//   motif: theme tpb=4 D5 - F#5 A5 B5 - A5 -          region: the harbour town
// `song new <id> from-bible=<entry>` sets the song up from its entry.

import { quote } from './commands.ts';
import { parseMotifCells } from './compose.ts';
import { SCALES, parseKey } from './music.ts';
import type { MusicCheck, MusicRange } from './musicchecks.ts';
import { arrange, channelNotes, drumInstrument, motifText, SONG_ID_RE, TAG_RE, type SongDoc } from './song.ts';

export const STYLE_FILE = 'music-style.md';
export const BIBLE_FILE = 'music-bible.md';

export interface StyleRules {
  tempo: [number, number] | null;
  scales: string[] | null;
  instruments: string[] | null;
  loudness: string[] | null;
  swing: [number, number] | null;
  key: string | null;
  forbid: { what: string; tag: string | null }[];
}

export interface StyleGuide {
  rules: StyleRules;
  /** Rules for songs with a tag (a stinger also counts as tagged `stinger`). */
  sections: Map<string, StyleRules>;
}

export interface BibleEntry {
  id: string;
  title: string;
  mood: string | null;
  tempo: [number, number] | null;
  key: string | null;
  time: string | null;
  tags: string[];
  /** Channel name and the instrument it plays (`kit` for drums). */
  instruments: [string, string][];
  motifs: { name: string; tpb: number; cells: string }[];
  region: string | null;
  swing: number | null;
  class: string | null;
}

export interface MusicGuide {
  style: StyleGuide | null;
  bible: Map<string, BibleEntry>;
  /** Lines of the files that could not be read, with where they are. */
  problems: string[];
}

export const emptyGuide = (): MusicGuide => ({ style: null, bible: new Map(), problems: [] });

const emptyRules = (): StyleRules => ({ tempo: null, scales: null, instruments: null, loudness: null, swing: null, key: null, forbid: [] });

/** The data lines of a Markdown file: headings and `key: value` lines, with their line numbers. */
function dataLines(text: string): ({ kind: 'heading'; level: number; text: string; line: number } | { kind: 'data'; key: string; value: string; line: number })[] {
  const out: ReturnType<typeof dataLines> = [];
  text.split(/\r?\n/).forEach((src, i) => {
    const h = /^(#{1,6})\s+(.*?)\s*$/.exec(src);
    if (h) { out.push({ kind: 'heading', level: h[1]!.length, text: h[2]!, line: i + 1 }); return; }
    const d = /^\s*(?:[-*]\s+)?([A-Za-z][A-Za-z ]{0,20}?)\s*:\s*(.+?)\s*$/.exec(src);
    if (d) out.push({ kind: 'data', key: d[1]!.toLowerCase(), value: d[2]!, line: i + 1 });
  });
  return out;
}

const list = (v: string): string[] => v.split(',').map((x) => x.trim()).filter(Boolean);

function numRange(v: string): [number, number] | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*(?:(?:-|to|–)\s*(-?\d+(?:\.\d+)?))?\s*(?:bpm)?$/i.exec(v.trim());
  if (!m) return null;
  const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
  return a <= b ? [a, b] : [b, a];
}

export function parseStyleGuide(text: string, file = STYLE_FILE): { guide: StyleGuide; problems: string[] } {
  const guide: StyleGuide = { rules: emptyRules(), sections: new Map() };
  const problems: string[] = [];
  let cur = guide.rules;
  for (const l of dataLines(text)) {
    const at = `${file}:${l.line}`;
    if (l.kind === 'heading') {
      if (l.level === 1) { cur = guide.rules; continue; }
      const tag = l.text.split(/\s/)[0]!.toLowerCase();
      if (!TAG_RE.test(tag)) { problems.push(`${at}: '${l.text}' is not a tag to scope rules by (a-z, 0-9, _ and -)`); cur = emptyRules(); continue; }
      cur = guide.sections.get(tag) ?? emptyRules();
      guide.sections.set(tag, cur);
      continue;
    }
    const v = l.value;
    switch (l.key) {
      case 'tempo': { const r = numRange(v); if (!r || r[0] < 30 || r[1] > 300) problems.push(`${at}: tempo is a number or a range like 80-140 (bpm, 30 to 300)`); else cur.tempo = r; break; }
      case 'swing': { const r = numRange(v); if (!r || r[0] < 0 || r[1] > 0.6) problems.push(`${at}: swing is a range like 0-0.3`); else cur.swing = r; break; }
      case 'scales': case 'scale': case 'modes': {
        const xs = list(v);
        const bad = xs.filter((x) => !SCALES[x]);
        if (bad.length) problems.push(`${at}: no scale ${bad.join(', ')} (scales: ${Object.keys(SCALES).join(', ')})`);
        cur.scales = xs.filter((x) => SCALES[x]);
        break;
      }
      case 'instruments': case 'palette': cur.instruments = list(v); break;
      case 'loudness': case 'classes': case 'mix': cur.loudness = list(v); break;
      case 'key': { try { parseKey(v); cur.key = v; } catch (e) { problems.push(`${at}: ${(e as Error).message}`); } break; }
      case 'forbid': case 'forbidden': case 'never': {
        const m = /^(?:no\s+)?([A-Za-z][A-Za-z0-9_-]*)(?:\s+in\s+([a-z][a-z0-9_-]*)(?:\s+(?:themes?|songs?|tracks?|music))?)?$/.exec(v.trim());
        if (!m) { problems.push(`${at}: forbid is drums, accidentals, swing, a scale or an instrument, optionally 'in <tag>' (like: forbid: drums in town)`); break; }
        cur.forbid.push({ what: m[1]!, tag: m[2] ?? null });
        break;
      }
      default: break;
    }
  }
  return { guide, problems };
}

export function parseBible(text: string, file = BIBLE_FILE): { entries: Map<string, BibleEntry>; problems: string[] } {
  const entries = new Map<string, BibleEntry>();
  const problems: string[] = [];
  let cur: BibleEntry | null = null;
  for (const l of dataLines(text)) {
    const at = `${file}:${l.line}`;
    if (l.kind === 'heading') {
      if (l.level === 1) { cur = null; continue; }
      const id = l.text.split(/[\s:—–]+/)[0]!;
      if (!SONG_ID_RE.test(id)) { problems.push(`${at}: '${l.text}' does not start with an entry id (letters, digits, _ and -)`); cur = null; continue; }
      if (entries.has(id)) problems.push(`${at}: entry ${id} is in the bible twice (the later one is used)`);
      cur = { id, title: l.text, mood: null, tempo: null, key: null, time: null, tags: [], instruments: [], motifs: [], region: null, swing: null, class: null };
      entries.set(id, cur);
      continue;
    }
    if (!cur) continue;
    const v = l.value;
    switch (l.key) {
      case 'mood': cur.mood = v; break;
      case 'region': cur.region = v; break;
      case 'tempo': { const r = numRange(v); if (!r || r[0] < 30 || r[1] > 300) problems.push(`${at}: tempo is a number like 96 or a range like 90-100`); else cur.tempo = r; break; }
      case 'key': { try { parseKey(v); cur.key = v; } catch (e) { problems.push(`${at}: ${(e as Error).message}`); } break; }
      case 'time': if (/^\d{1,2}\/(2|4|8|16)$/.test(v)) cur.time = v; else problems.push(`${at}: time is like 4/4 or 3/4`); break;
      case 'tags': {
        const xs = list(v.toLowerCase());
        const bad = xs.filter((x) => !TAG_RE.test(x));
        if (bad.length) problems.push(`${at}: '${bad[0]}' is not a tag (a-z, 0-9, _ and -)`);
        cur.tags = xs.filter((x) => TAG_RE.test(x));
        break;
      }
      case 'swing': { const n = Number(v); if (!(n >= 0 && n <= 0.6)) problems.push(`${at}: swing is 0 to 0.6`); else cur.swing = n; break; }
      case 'class': case 'loudness': cur.class = v; break;
      case 'instruments': {
        for (const w of list(v)) {
          const m = /^([A-Za-z][A-Za-z0-9_]{0,23})\s*=\s*([A-Za-z][A-Za-z0-9_-]{0,47})$/.exec(w);
          if (!m) { problems.push(`${at}: '${w}' is not <channel>=<instrument> (drums=kit for a drum channel)`); continue; }
          cur.instruments.push([m[1]!, m[2]!]);
        }
        break;
      }
      case 'motif': {
        const m = /^([A-Za-z][A-Za-z0-9_-]{0,31})\s*(?:=\s*)?(.*)$/.exec(v);
        if (!m) { problems.push(`${at}: motif is <name> [tpb=<n>] <notes>, like: theme tpb=4 D5 - F#5 A5`); break; }
        try {
          const mo = parseMotifCells(m[2]!, 4, m[1]!);
          cur.motifs.push({ name: m[1]!, tpb: mo.tpb, cells: motifText(mo) });
        } catch (e) { problems.push(`${at}: ${(e as Error).message}`); }
        break;
      }
      default: break;
    }
  }
  return { entries, problems };
}

/** The guide from the two files' texts (null when a file is missing). */
export function musicGuide(styleText: string | null, bibleText: string | null): MusicGuide {
  const g = emptyGuide();
  if (styleText !== null) { const s = parseStyleGuide(styleText); g.style = s.guide; g.problems.push(...s.problems); }
  if (bibleText !== null) { const b = parseBible(bibleText); g.bible = b.entries; g.problems.push(...b.problems); }
  return g;
}

/** The project's key: the style guide's `key:`, or null. */
export const projectKey = (g: MusicGuide | undefined): string | null => g?.style?.rules.key ?? null;

/** The commands that set a song up from a bible entry; `given` are the song new values the command named itself (they win). */
export function bibleCommands(id: string, e: BibleEntry, given: Map<string, string>): string[] {
  const v = new Map<string, string>();
  if (e.tempo) v.set('tempo', String(Math.round((e.tempo[0] + e.tempo[1]) / 2)));
  if (e.time) v.set('time', e.time);
  if (e.key) v.set('key', e.key);
  if (e.swing !== null) v.set('swing', String(e.swing));
  if (e.class) v.set('class', e.class);
  v.set('tags', (e.tags.length ? e.tags : [e.id.toLowerCase().replace(/[^a-z0-9_-]/g, '')]).join(','));
  for (const [k, x] of given) v.set(k, x);
  v.set('bible', e.id);
  const lines = [`song new ${id}${[...v].map(([k, x]) => ` ${k}=${x}`).join('')}`];
  for (const [ch, inst] of e.instruments) lines.push(`song channel add ${id} ${ch} ${inst === 'kit' || inst === 'drums' ? 'kit=default' : `inst=${inst}`}`);
  for (const m of e.motifs) lines.push(`motif set ${id} ${m.name} ${quote(m.cells)} tpb=${m.tpb}`);
  return lines;
}

// ---- the style check ------------------------------------------------------------------------------------------------

/** The rules a song is held to: the guide's, then each section the song's tags (and kind) name. */
export function rulesFor(g: StyleGuide, song: SongDoc): { rules: StyleRules; from: string[] } {
  const r: StyleRules = { ...g.rules, forbid: [...g.rules.forbid] };
  const from = ['the style guide'];
  for (const t of [...song.tags, ...(song.kind === 'stinger' ? ['stinger'] : [])]) {
    const s = g.sections.get(t);
    if (!s) continue;
    from.push(`## ${t}`);
    for (const k of ['tempo', 'scales', 'instruments', 'loudness', 'swing', 'key'] as const) if (s[k] !== null) (r as unknown as Record<string, unknown>)[k] = s[k];
    r.forbid.push(...s.forbid);
  }
  return { rules: r, from };
}

const fmtRange = (r: [number, number]): string => (r[0] === r[1] ? String(r[0]) : `${r[0]}-${r[1]}`);

/** Every instrument a song plays (a drum channel: the instruments of the hits it plays). */
function instrumentsUsed(song: SongDoc, arr: ReturnType<typeof arrange>): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const ch of song.channels) {
    if (ch.inst) { used.set(ch.inst, [...(used.get(ch.inst) ?? []), ch.name]); continue; }
    const hits = new Set(channelNotes(song, arr, ch.name).map((e) => e.drum).filter((d): d is string => !!d));
    for (const h of hits) { const i = drumInstrument(ch, h); if (i && !(used.get(i) ?? []).includes(ch.name)) used.set(i, [...(used.get(i) ?? []), ch.name]); }
  }
  return used;
}

export function styleCheck(song: SongDoc, guide: MusicGuide | undefined): MusicCheck {
  const base = { name: 'style' as const, advisory: false };
  const entry = song.bible ? guide?.bible.get(song.bible) : undefined;
  if (!guide?.style && !song.bible) return { ...base, pass: true, skipped: true, score: 1, value: 'no music style guide (music-style.md) and the song is not from the music bible', threshold: 'write music-style.md in the project to hold songs to it', ranges: [] };
  const arr = arrange(song);
  const whole = { from: 0, to: Math.round(arr.total * 10000) / 10000 };
  const ranges: MusicRange[] = [];
  const flag = (note: string, r = whole): void => { ranges.push({ ...r, note }); };
  const mode = song.key ? song.key.split(':')[1]! : null;
  let checked = 0;
  let threshold = '';
  if (guide?.style) {
    const { rules, from } = rulesFor(guide.style, song);
    const by = from.join(' + ');
    threshold = `the rules of ${by}`;
    if (rules.tempo) { checked++; if (song.tempo < rules.tempo[0] || song.tempo > rules.tempo[1]) flag(`tempo ${song.tempo} is outside ${fmtRange(rules.tempo)} bpm (${by})`); }
    if (rules.swing) { checked++; if (song.swing < rules.swing[0] || song.swing > rules.swing[1]) flag(`swing ${song.swing} is outside ${fmtRange(rules.swing)}`); }
    if (rules.scales) { checked++; if (!mode) flag(`the song has no key (the style's scales: ${rules.scales.join(', ')})`); else if (!rules.scales.includes(mode)) flag(`the scale ${mode} is not one of the style's (${rules.scales.join(', ')})`); }
    if (rules.loudness) { checked++; const cls = song.loudClass ?? 'music'; if (!rules.loudness.includes(cls)) flag(`the loudness class ${cls} is not one of the style's (${rules.loudness.join(', ')}): song set ${song.id} class=${rules.loudness[0]}`); }
    const used = instrumentsUsed(song, arr);
    if (rules.instruments) {
      checked++;
      for (const [i, chs] of used) if (!rules.instruments.includes(i)) flag(`${i} (channel ${chs.join(', ')}) is not in the style's instrument palette (${rules.instruments.join(', ')})`);
    }
    for (const f of rules.forbid) {
      if (f.tag && !song.tags.includes(f.tag) && !(f.tag === 'stinger' && song.kind === 'stinger')) continue;
      checked++;
      const where = f.tag ? ` in ${f.tag}` : '';
      if (f.what === 'drums') {
        for (const ch of song.channels.filter((c) => c.kit)) {
          const hits = channelNotes(song, arr, ch.name);
          if (hits.length) flag(`drums${where} are forbidden: channel ${ch.name} plays ${hits.length} hits`, { from: Math.round(hits[0]!.t * 10000) / 10000, to: Math.round((hits[hits.length - 1]!.t + hits[hits.length - 1]!.len) * 10000) / 10000 });
        }
      } else if (f.what === 'accidentals') {
        for (const ch of song.channels.filter((c) => c.inst)) for (const e of channelNotes(song, arr, ch.name)) if (e.accidental) flag(`a note outside the key (${ch.name}, ${e.at.pattern} step ${e.at.step}) is forbidden${where}`, { from: Math.round(e.t * 10000) / 10000, to: Math.round((e.t + e.len) * 10000) / 10000 });
      } else if (f.what === 'swing') {
        if (song.swing > 0) flag(`swing is forbidden${where} (the song swings ${song.swing})`);
      } else if (SCALES[f.what]) {
        if (mode === f.what) flag(`the ${f.what} scale is forbidden${where}`);
      } else if (used.has(f.what)) flag(`${f.what} (channel ${used.get(f.what)!.join(', ')}) is forbidden${where}`);
    }
  }
  if (song.bible) {
    checked++;
    const bt = `music bible entry ${song.bible}`;
    threshold = threshold ? `${threshold}, and the ${bt}` : `the ${bt}`;
    if (!entry) flag(`the song is from bible entry ${song.bible}, which ${guide?.bible.size ? 'the bible does not have' : 'cannot be read (no music-bible.md)'}`);
    else {
      if (entry.tempo && (song.tempo < entry.tempo[0] || song.tempo > entry.tempo[1])) flag(`tempo ${song.tempo}; the bible says ${fmtRange(entry.tempo)}`);
      if (entry.key && song.key !== entry.key) flag(`key ${song.key ?? 'none'}; the bible says ${entry.key}`);
      if (entry.time && `${song.time[0]}/${song.time[1]}` !== entry.time) flag(`time ${song.time[0]}/${song.time[1]}; the bible says ${entry.time}`);
      for (const [ch, inst] of entry.instruments) {
        const c = song.channels.find((x) => x.name === ch);
        const kit = inst === 'kit' || inst === 'drums';
        if (!c) flag(`the bible gives channel ${ch} (${inst}); the song has none`);
        else if (kit ? !c.kit : c.inst !== inst) flag(`channel ${ch} plays ${c.inst ?? 'drums'}; the bible says ${inst}`);
      }
      for (const m of entry.motifs) if (!song.motifs.some((x) => x.name === m.name)) flag(`the bible's motif ${m.name} is not in the song`);
    }
  }
  const pass = ranges.length === 0;
  return {
    ...base, pass, skipped: false, score: pass ? 1 : Math.max(0, 1 - ranges.length / Math.max(4, checked * 2)),
    value: pass ? `the song keeps ${checked} rule${checked === 1 ? '' : 's'} (${threshold})` : `${ranges.length} thing${ranges.length === 1 ? '' : 's'} against ${threshold}`,
    threshold: threshold || 'the style guide', ranges: ranges.slice(0, 40),
  };
}

/** The guide as text, for `soundclaw style`. */
export function guideText(g: MusicGuide): string {
  const out: string[] = [];
  const rules = (r: StyleRules, pad: string): void => {
    if (r.tempo) out.push(`${pad}tempo ${fmtRange(r.tempo)} bpm`);
    if (r.key) out.push(`${pad}key ${r.key}`);
    if (r.scales) out.push(`${pad}scales ${r.scales.join(', ')}`);
    if (r.instruments) out.push(`${pad}instruments ${r.instruments.join(', ')}`);
    if (r.loudness) out.push(`${pad}loudness classes ${r.loudness.join(', ')}`);
    if (r.swing) out.push(`${pad}swing ${fmtRange(r.swing)}`);
    for (const f of r.forbid) out.push(`${pad}forbid ${f.what}${f.tag ? ` in ${f.tag}` : ''}`);
  };
  if (g.style) {
    out.push(`style guide (${STYLE_FILE}):`);
    rules(g.style.rules, '  ');
    for (const [t, r] of g.style.sections) { out.push(`  ## ${t} (songs tagged ${t}):`); rules(r, '    '); }
  } else out.push(`no style guide (${STYLE_FILE} in the project folder)`);
  if (g.bible.size) {
    out.push(`music bible (${BIBLE_FILE}): ${g.bible.size} entr${g.bible.size === 1 ? 'y' : 'ies'}`);
    for (const e of g.bible.values()) {
      out.push(`  ${e.id}: ${[e.mood && `mood ${e.mood}`, e.tempo && `tempo ${fmtRange(e.tempo)}`, e.key && `key ${e.key}`, e.time, e.tags.length && `tags ${e.tags.join(',')}`].filter(Boolean).join('; ')}`);
      if (e.instruments.length) out.push(`    instruments ${e.instruments.map(([c, i]) => `${c}=${i}`).join(', ')}`);
      for (const m of e.motifs) out.push(`    motif ${m.name} (tpb=${m.tpb}): ${m.cells}`);
      if (e.region) out.push(`    region ${e.region}`);
    }
  } else out.push(`no music bible (${BIBLE_FILE} in the project folder)`);
  if (g.problems.length) out.push('problems:', ...g.problems.map((p) => `  ${p}`));
  return out.join('\n');
}

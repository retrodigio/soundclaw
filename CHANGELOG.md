# Changelog

All notable changes to SoundClaw are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### The SFX editor
- A sound's page in the dashboard (`#/sound/<id>`, "Edit" on its card): the classic voice's 25
  parameters as sliders in sfxr's groups, each showing its value and range, double-click or ↺ for the
  default; wave buttons and a seed; the category buttons and `random`; mutate with an amount.
  Every change re-renders in the browser with the same core and replays (a *play on change*
  toggle, a stop button, space plays). Download the WAV (the pre-rendered form), the patch text
  or a CSV row.
- Human edits are commands: the page sends `sound set` / `sound generate` / `sound mutate` as
  `human:<name>`, the lines an agent would write; a drag is coalesced into one command (on release,
  or after a pause). Undo and redo work from the page.
- A/B: pin a snapshot (or another sound) as A, switch playback between A and the live B, *Keep A*
  restores A's parameters as one command.
- `sound generate <id> <category|random> [seed=<n>]`, and `random` (sfxr's randomize, with its ranges as
  data) as a preset.
- `changes <project> [--since …] [--by human] [--as …] [--peek]` and the MCP `changes` tool: what
  other hands changed since the agent last looked (a per-agent cursor), with parameters and numbers
  before and after and a compare PNG. The skill says to call it before editing a sound a person touched.
- Listening feedback on cards: quick tags (too loud, too quiet, too long, too short, too harsh, too
  dull, too similar to another sound, good) with free text become requests carrying the tags, shown on
  the card and delivered through `await`; `request --tag` from the CLI and `tags` on the MCP tool.
- A `synth.csv` with a repeated sound id is read as the engine reads it (first position, last row's
  values) with a warning naming both lines, instead of being rejected.

### The classic voice and the agent's ears
- The classic voice: sfxr's 25 parameters rendered sample-exactly (a port of a reference
  synthesiser, with a platform-proof sine and cube), noise seeded by FNV-1a, `sound new <id>
  voice=classic`, `sound set` with every parameter and `wave=` names, `sound patch`, and
  seeded generators by category (`preset=pickup|laser|explosion|powerup|hit|jump|blip`) whose
  ranges are data. `sound mutate` (or `mutate`) makes small seeded changes.
- sfxr single-patch text and `synth.csv`: `import <project> sfxr …`, and `export --format
  wav|patch|csv` (a classic WAV is the pre-rendered form, `trunc(s × 32000)`).
- The ears: numbers with every render (duration, loudness in LUFS, true peak, crest factor, DC,
  attack, tail, brightness, pitch, onsets), `view` (wave, spec, pitch, compare as PNG), `describe`,
  and a check summary line at the end of every render result.
- Checks (clip, loudness, dc, click, tail) with scores, thresholds and flagged time ranges:
  `check`; the targets come from `style` in `project.json`. `work done` is refused while the
  sound's checks fail.
- The dashboard card shows the classic parameters read-only, a spectrogram thumbnail and a check
  badge.
- The default port is 7427.


### The first skeleton (early; nothing is released yet)
- A project folder (`soundclaw new`): `sounds/`, `instruments/`, `songs/`, `sets/`, a history tape
  with authors (`agent:<name>`, `human:<name>`), `requests.jsonl`, and `exports/` ignored by git.
- The single writer: `soundclaw run <project> <file|->` applies a batch of commands as one undo
  group, and any error applies nothing. `undo`, `redo` and `history`.
- A placeholder voice: `sound new <id>` and `sound set <id> frequency= duration= volume=` make a
  sine tone, so the plumbing is real end to end.
- A deterministic pure-TypeScript renderer (44,100 Hz mono `Float32Array`; the same samples in Node
  and in the browser), 16-bit WAV export, and a content-hash render cache.
- `soundclaw serve`: MCP over stdio, HTTP and WebSocket, token and lock files, and the dashboard
  (sound cards with a play button, waveform, status, and the history).
- Requests: "Ask for changes" and "Approve" on a card; `soundclaw await` (exits with events) and the
  MCP `await_requests`; `soundclaw work list|claim|progress|block|done` and the MCP `work`.
- Per-command `--help` and `--version`; a Claude Code skill (`soundclaw skill install`).

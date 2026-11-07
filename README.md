# SoundClaw

A sound effects and music workbench for AI agents. An agent makes sounds by **text commands**
(through a command line and an MCP server); people **watch, listen and edit** in a live browser
view. Sounds are made from parameters, so they cost nothing to render, reproduce exactly on every
machine, and can be edited and checked by a person and an agent alike.

> **Status: early.** The project folder, history, rendering, the server and dashboard, the request
> loop between a person and an agent, the classic (sfxr-style) voice, and the views and checks an
> agent "hears" with are in, and so is the sound editor (sliders, A/B, feedback tags). The enhanced
> voices and the music tracker come next. Expect the commands and documents to change.

## What works today

- **A project is a folder** you can keep in git: `sounds/`, `instruments/`, `songs/`, `sets/`,
  a history tape with authors (`agent:<name>`, `human:<name>`), `requests.jsonl`, and `exports/`
  (ignored).
- **One writer, one undo step per batch.** `soundclaw run` applies a batch of commands as one undo
  group; any error applies nothing. `undo`, `redo` and `history` are commands and a view of the tape.
- **The classic voice.** sfxr's 25 parameters, rendered sample-exactly (the sine and the cube are
  done in arithmetic that every platform agrees on), with generators by category (pickup, laser,
  explosion, powerup, hit, jump, blip), seeded `mutate`, and import and export of sfxr patch text and
  `synth.csv`.
- **Ears for an agent that cannot listen.** Every result carries numbers (loudness in LUFS, true
  peak, attack, tail, brightness, pitch, onsets) and a check summary; `view` draws the waveform, a
  mel spectrogram, the pitch track, or two sounds compared; `describe` says it in words; `check`
  flags clips, loudness, DC, clicks and cut tails with the exact time ranges, and `work done` waits
  for them to pass.
- **Deterministic rendering.** A sound renders to 44,100 Hz mono samples by pure TypeScript, the
  same samples in Node and in the browser (tested), cached by the content hash of the document, and
  exported as 16-bit WAV.
- **A live dashboard.** `soundclaw serve` shows every sound as a card with a play button, a
  waveform, a spectrogram, its checks and the history. The browser renders with the same code as the agent, so what plays is
  what the agent rendered (the card and the CLI print the same hash).
- **A sound editor.** Open a classic sound from its card: its 25 parameters as sliders in sfxr's
  groups that replay as you move them, the category buttons and `random`, mutate, A/B, and WAV,
  patch text and CSV downloads. Every edit is a command written as `human:<name>`, the line an
  agent would write (a drag is one command), so `soundclaw changes` shows an agent what you did.
- **People and agents talk through requests.** "Ask for changes", quick feedback tags (too loud, too harsh, good, …) and "Approve" on a card reach an
  agent that is waiting with `soundclaw await` (it exits with the events, which wakes the agent) or
  the MCP `await_requests`; the agent takes them with `soundclaw work` or the MCP `work` tool.

## Try it

You need Node.js 22.18 or later.

```sh
npx soundclaw new demo.sclaw
npx soundclaw serve --project demo.sclaw &      # prints the dashboard link, with its token
npx soundclaw run demo.sclaw -e 'sound new zap voice=classic preset=laser seed=1; sound set zap volume=0.2'
```

```
applied 2 commands as group g1 by agent:claude
  #1 sound new zap voice=classic preset=laser seed=1
  #2 sound set zap volume=0.2
zap: classic wave=sine sustain=0.225 punch=0.298 decay=0.001 freq=0.984 minFreq=0.228 slide=-0.227 highPass=0.042 volume=0.2 → 5065 samples, peak 0.633, rms 0.368, hash 254675a10aed
    checks: 3/5 pass; failing: loudness -5.8 LUFS (10.2 LU too loud); click start 0.171, end 0.000
warnings: none
```

Open the link: the sound is a card. Press play. Ask for changes, and run `soundclaw await demo.sclaw`
to receive the request. `soundclaw describe demo.sclaw zap` says what it sounds like in numbers and
words, `soundclaw view demo.sclaw zap spec` draws its spectrogram, and `soundclaw export demo.sclaw`
writes `exports/zap.wav`.

### With Claude Code

```sh
claude mcp add soundclaw -- npx soundclaw serve --project demo.sclaw
npx soundclaw skill install
```

The skill tells the agent how to drive the tool, including to keep `soundclaw await` running in
the background on a served project.

## Documentation

- [docs/commands.md](docs/commands.md): the command language, the CLI, the MCP tools and the HTTP API.
- [docs/design.md](docs/design.md): how the parts fit together.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
pnpm install
npx playwright install chromium
pnpm test          # build, vitest, Playwright
pnpm typecheck
```

## Licence

[MIT](LICENSE).

# SoundClaw

A sound effects and music workbench for AI agents. An agent makes sounds by **text commands**
(through a command line and an MCP server); people **watch, listen and edit** in a live browser
view. Sounds are made from parameters, so they cost nothing to render, reproduce exactly on every
machine, and can be edited and checked by a person and an agent alike.

> **Status: early.** This is the skeleton: the project folder, history, rendering, export, the
> server and dashboard, and the request loop between a person and an agent. The only voice is a
> placeholder sine tone. The real synth, the views an agent can "hear" with, the music tracker
> and the editors come next. Expect the commands and documents to change.

## What works today

- **A project is a folder** you can keep in git: `sounds/`, `instruments/`, `songs/`, `sets/`,
  a history tape with authors (`agent:<name>`, `human:<name>`), `requests.jsonl`, and `exports/`
  (ignored).
- **One writer, one undo step per batch.** `soundclaw run` applies a batch of commands as one undo
  group; any error applies nothing. `undo`, `redo` and `history` are commands and a view of the tape.
- **Deterministic rendering.** A sound renders to 44,100 Hz mono `Float32Array` by pure TypeScript,
  the same samples in Node and in the browser (tested), cached by the content hash of the document,
  and exported as 16-bit WAV.
- **A live dashboard.** `soundclaw serve` shows every sound as a card with a play button, a
  waveform and the history. The browser renders with the same code as the agent, so what plays is
  what the agent rendered (the card and the CLI print the same hash).
- **People and agents talk through requests.** "Ask for changes" and "Approve" on a card reach an
  agent that is waiting with `soundclaw await` (it exits with the events, which wakes the agent) or
  the MCP `await_requests`; the agent takes them with `soundclaw work` or the MCP `work` tool.

## Try it

You need Node.js 22.18 or later.

```sh
npx soundclaw new demo.sclaw
npx soundclaw serve --project demo.sclaw &      # prints the dashboard link, with its token
npx soundclaw run demo.sclaw -e 'sound new beep; sound set beep frequency=880 volume=0.4'
```

```
applied 2 commands as group g1 by agent:claude
  #1 sound new beep
  #2 sound set beep frequency=880 volume=0.4
beep: tone 880 Hz, 0.5 s, volume 0.4 → 22050 samples, peak 0.400, rms 0.283, hash f4c7b3408089
warnings: none
```

Open the link: the sound is a card. Press play. Ask for changes, and run `soundclaw await demo.sclaw`
to receive the request. `soundclaw export demo.sclaw` writes `exports/beep.wav`.

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

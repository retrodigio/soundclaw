# SoundClaw: notes for agents working on the code

SoundClaw is a sound effects and music workbench built for an AI agent to drive by text command
(an MCP server and a CLI), with a live browser view where people listen, watch and edit.
TypeScript, pnpm workspaces: `core`, `server`, `ui`, `cli`, plus `skill/` (the Claude Code skill).
Start with [README.md](README.md), [docs/design.md](docs/design.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

- `core/`: the sound document, command language, history tape (groups, undo, redo, replay), the
  request state machine, the deterministic renderers (the classic voice, the layered voice and the tone), generators,
  the WAV encoder, SHA-256, music (instruments, the pattern text, songs and their renderer, MIDI), and the measurements (analysis, checks, PNG views, the music checks and views). Pure TypeScript, no
  DOM or Node APIs.
- `server/`: the project folder, the single writer, the render cache, requests and await, the MCP
  server (stdio and HTTP), the HTTP + WebSocket server for the dashboard, the token and lock files.
- `ui/`: the dashboard (Vite + React); it renders sounds with `core`.
- `cli/`: the `soundclaw` command; `pnpm build` bundles everything into `cli/dist`.
- `skill/`: the Claude Code skill. `docs/`: reference docs. `scripts/`: the build.
- `test/`: the licence test. Tests of a package live in its own `test/`; browser tests in `e2e/`.

## Conventions

- **Core is deterministic.** No `Date`, `Math.random`, DOM or Node APIs in `core`. What *renders*
  (`render.ts`, `classic.ts`, `mathx.ts`, `generators.ts`, `synth.ts`, `recipes.ts`, `instrument.ts`, `songrender.ts`) uses no `Math.sin`, `Math.pow`,
  `Math.exp`, `Math.log` or any other platform maths whose last digit may differ: the sine is fdlibm's, in
  `+ - * /` (`sinRad`), the cube is `cube`, the tone's and the layered oscillators' sine a polynomial
  (`sineCycles`), 2^x and log2 are `exp2` and `log2` (bits and series), the filter's tangent a ratio of fdlibm
  sines. A document renders to the same bytes on every machine; the
  golden hashes in `core/test/determinism.test.ts`, `core/test/classic-golden.json`, `core/test/layered-golden.json` and `core/test/music-golden.json` depend on it.
  If the renderer's output must change, bump `RENDER_VERSION` and update the goldens with a reason.
  What *measures* (`analysis.ts`, `checks.ts`, `views.ts`, `png.ts`, `musicchecks.ts`, `musicviews.ts`) may use `Math.*`: its numbers are
  printed rounded and the last digit may differ between platforms; nothing there feeds back into a
  render.
- **Every edit is a command.** Changes to sounds are commands with a normal form, written to the
  history tape (`history.jsonl`, the source of truth; `sounds/*.sfx` are written from it). A
  person's action in the UI writes a command too, as `human:<name>`.
- **One writer.** Everything that changes a project goes through `Writer.run` (a batch is atomic),
  inside `writer.enqueue` when it can interleave. A running server owns the project: the CLI sends
  its writing commands to it (`cli/src/forward.ts`) and refuses to write behind its back.
- **Game-specific knowledge is data** (export profiles); ship only generic ones. Examples,
  fixtures and docs use invented content, never names, sounds or music from an existing game.
- **Few, permissive dependencies** (MIT, BSD, Apache-2.0, ISC). `test/licences.test.ts` checks
  every installed package.
- Comments explain the code; docs describe the tool. Name tests and examples by the feature they
  cover.

## Running things

Node 22.18 or later (TypeScript runs directly through Node's type stripping) and pnpm 10.

```sh
pnpm install
pnpm build                 # the UI (vite) and the bundled CLI in cli/dist
pnpm typecheck             # tsc over core, server, cli, ui and e2e
pnpm test:unit             # vitest
pnpm test:e2e              # Playwright (needs pnpm build, and `npx playwright install chromium` once)
pnpm test                  # build + vitest + Playwright: must pass before every commit
node cli/bin/soundclaw.js --help
```

- Never open GUI windows or leave servers running when you finish; the tests and Playwright specs
  start their own servers on temporary projects and stop them.
- Keep `docs/commands.md` in step with `USAGE` in `cli/src/main.ts` (a test checks every command is
  in the reference) and with the skill.

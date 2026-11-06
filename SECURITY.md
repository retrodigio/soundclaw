# Security

SoundClaw runs on your machine, reads and writes a project folder, and serves a local web page.
This page says what protects you and how to report a problem.

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting: the
**Security** tab of [github.com/retrodigio/soundclaw](https://github.com/retrodigio/soundclaw),
then **Report a vulnerability**. Do not open a public issue. Include what you found, how to
reproduce it and what an attacker could do with it. You should get an answer within a week. Fixes
go into the latest release; there are no long-term support branches.

## The local server

- `soundclaw serve` listens on `127.0.0.1` only, and answers only to the host names `127.0.0.1`,
  `localhost` and `[::1]`, so a web page cannot reach it through DNS rebinding.
- A random **token** is made at each start. The dashboard, its API, its WebSocket and the HTTP MCP
  endpoint need it; the link with the token is printed to stderr and returned by the MCP `project`
  tool. Treat the link as a password while the server runs: anyone with it can edit the project.
- The lock file `<project>/.soundclaw.lock` records the server's pid and URL without the token. The
  token is kept in a file of its own outside the project (`~/.soundclaw/run/`, mode 0600 in a 0700
  folder, or `$SOUNDCLAW_STATE_DIR`), which the CLI reads to send commands to the server; it is
  removed when the server stops.
- A page writes to the history only as `human:<name>`; it cannot write as an agent.

## Opening projects from others

A project folder is data: a history of commands, requests, text documents and caches. Replaying a
history cannot run code; a command that does not parse stops the replay with an error. The render
cache (`.cache/`) is trusted as it is (samples keyed by a content hash; a file that is not a whole
number of floats is ignored), so do not take a `.cache/` from a source you do not trust; it is
ignored by git and safe to delete. Exports are written where you tell them to be.

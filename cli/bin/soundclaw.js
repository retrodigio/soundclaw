#!/usr/bin/env node
// Runs the TypeScript sources directly (Node >= 22.18 strips types natively). The packed
// package runs the bundle in dist/ instead (see scripts/build.ts).
import { cli } from '../src/entry.ts';

process.exitCode = await cli(process.argv.slice(2));

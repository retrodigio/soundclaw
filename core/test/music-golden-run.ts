// Prints the music golden hashes as JSON: run in a fresh process by the golden test.
import { hashes } from './music-golden-table.ts';
process.stdout.write(JSON.stringify(hashes()));

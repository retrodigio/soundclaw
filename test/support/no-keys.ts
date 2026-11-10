// Every test process starts without provider keys: tests that call a provider hand a local stub a made-up key of their own, so no test can
// reach a real service with a real key, whatever the shell that runs them holds. Spawned commands and servers inherit this environment.

for (const k of ['ELEVENLABS_API_KEY']) delete process.env[k];

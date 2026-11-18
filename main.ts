// main.ts — process lifecycle for the forge entry.
//
// The harness that runs this entry speaks to it through one small contract: the environment
// names its own origin in MAKEFUN_ENV_URL, the entry binds an ephemeral TCP port and announces
// it with POST /register, and the entry stays alive until GET /done answers {"done": true},
// then closes its server and exits 0. Everything the trial measures happens over HTTP on the
// announced port; this file only owns the birth and death of the process.

import { createApp } from './app.ts';

/** Origin of the harness environment, with any trailing slashes removed. */
function envOrigin(): string {
  let raw = process.env.MAKEFUN_ENV_URL ?? '';
  while (raw.endsWith('/')) raw = raw.slice(0, -1);
  return raw;
}

const ORIGIN = envOrigin();

/** One env request may hang at most this long before it counts as a failed attempt. */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** Retry waits grow 250, 500, 1000, then stay at 2000 ms. */
const WAIT_FLOOR_MS = 250;
const WAIT_CEILING_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The wait after the given number of consecutive failures: doubling, capped at the ceiling. */
function waitAfter(failures: number): number {
  const grown = WAIT_FLOOR_MS * 2 ** Math.min(failures, 3);
  return Math.min(WAIT_CEILING_MS, grown);
}

/**
 * One HTTP call to the environment. Network failures and timeouts come back as null so the
 * caller can treat every transport problem the same way: wait, then try again.
 */
async function callEnv(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(ORIGIN + path, { ...init, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

/**
 * Announce the bound port until the environment takes it. A 200 means the announcement was
 * recorded; a 409 means another process announced first and this one simply carries on to the
 * wait like any other. A 400 or 405 is the harness rejecting the contract itself, so it is
 * fatal. Anything else — including no answer at all — is retried, because the environment may
 * still be starting.
 */
async function announce(port: number): Promise<void> {
  const payload = JSON.stringify({ port });
  for (let failures = 0; ; failures += 1) {
    const res = await callEnv('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    if (res !== null) {
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    }
    await pause(waitAfter(failures));
  }
}

/** Poll /done until its JSON body says the trial is over; never returns before that. */
async function untilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    const res = await callEnv('/done');
    if (res !== null && res.ok) {
      const body: unknown = await res.json().catch(() => null);
      if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) return;
    }
    await pause(waitAfter(failures));
  }
}

/** Boot the HTTP server on a kernel-chosen port and hand back that port. */
async function boot(): Promise<{ port: number; close: () => void }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server.address() gave no TCP port after listen(0)');
  }
  return { port: address.port, close: () => server.close() };
}

async function run(): Promise<void> {
  if (ORIGIN === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  const { port, close } = await boot();
  process.stdout.write(`[entry] listening on port ${port}\n`);
  await announce(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await untilDone();
  close();
  process.stdout.write('[entry] done\n');
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);

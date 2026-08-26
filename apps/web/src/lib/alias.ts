// Random alias generator — ported from legacy components/sidebar.tsx.

const ADJS = [
  "async", "static", "typed", "lazy", "eager", "cached", "secure", "native",
  "agile", "stable", "modular", "atomic", "binary", "linear", "virtual",
  "proxy", "local", "global", "dense", "sparse",
];
const NOUNS = [
  "stack", "cache", "queue", "token", "scope", "build", "fetch", "hook",
  "query", "patch", "docker", "socket", "kernel", "lambda", "shader",
  "mutex", "cron", "redis", "pixel", "worker",
];

/** Random local part (no suffix/domain), e.g. "lazy-socket-4821". */
export function randomLocal(): string {
  const adj = ADJS[Math.floor(Math.random() * ADJS.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${adj}-${noun}-${num}`;
}

/**
 * A full throwaway address.
 *
 * The handle is appended as a sub-address so the address routes back to this
 * mailbox on its own, before any alias row exists — see the resolver in
 * apps/api/src/routing.ts.
 */
export function randomAlias(domain: string, handle: string): string {
  const local = randomLocal();
  return handle ? `${local}.${handle}@${domain}` : `${local}@${domain}`;
}

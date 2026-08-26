#!/usr/bin/env node
// Create this instance's Cloudflare resources, named after its mail domain.
//
//   pnpm provision example.com
//
// Why this is a separate step, in a project that otherwise has no setup
// commands: a D1 database name CANNOT be changed once the database is created.
// There is no `wrangler d1 rename`, and no way to do it from the dashboard. So
// the name has to be right at creation time — which is before the setup wizard
// has run, and before anyone has said what the domain is.
//
// This is provisioning, not configuration. Domains, accounts, credentials and
// sending are all still set up in the browser at /setup.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

// ── the pure parts, exported so they can be tested ───────────────────────────

/**
 * `example.com` -> `example-com`.
 *
 * Dots aren't safe in Cloudflare resource names. The full domain is kept rather
 * than just the apex label, so example.com and example.org don't collide in the
 * same account.
 */
export function slug(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Every resource name this instance owns, derived from one domain. */
export function resourceNames(domain) {
  const base = slug(domain);
  if (!base) return null;
  return {
    base,
    worker: `${base}-driftmail`,
    database: `${base}-driftmail`,
    bucket: `${base}-driftmail-mail`,
  };
}

/**
 * Point wrangler.jsonc at these resources.
 *
 * Targeted replacements rather than parse-and-serialize, so every comment in the
 * file survives. Re-running is a no-op rather than an error: each pattern also
 * matches the value it would have written last time.
 */
export function rewriteConfig(config, names, databaseId) {
  const edits = [
    [/("database_name"\s*:\s*")[^"]*(")/, names.database, '"database_name"'],
    [/("database_id"\s*:\s*")[^"]*(")/, databaseId, '"database_id"'],
    [/("bucket_name"\s*:\s*")[^"]*(")/, names.bucket, '"bucket_name"'],
    // The Worker gets the name too. Two instances in one account would
    // otherwise overwrite each other — and the Email Routing catch-all rule
    // points at the Worker BY NAME, so a collision silently steals mail.
    // The EMAIL binding's "name" can't match this: it isn't "…driftmail".
    [/("name"\s*:\s*")[a-z0-9-]*driftmail(")/, names.worker, "the Worker name"],
  ];

  let out = config;
  for (const [pattern, value, label] of edits) {
    if (!pattern.test(out)) throw new Error(`Couldn't find ${label} in wrangler.jsonc.`);
    out = out.replace(pattern, `$1${value}$2`);
  }
  return out;
}

/** Pull a database id out of whatever shape wrangler printed it in. */
export function parseDatabaseId(output) {
  return (
    output.match(/"(?:uuid|database_id)"\s*:\s*"([0-9a-f-]{36})"/i)?.[1] ??
    output.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ??
    null
  );
}

// ── the command ──────────────────────────────────────────────────────────────

const USAGE = `Usage: pnpm provision <domain> [--dry-run]

  pnpm provision example.com

Creates a D1 database and R2 bucket named after the domain, then writes their
names and ids into wrangler.jsonc. Safe to re-run.`;

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function wrangler(argv, { allowFail = false } = {}) {
  const res = spawnSync("pnpm", ["exec", "wrangler", ...argv], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.status !== 0 && !allowFail) {
    die(`\`wrangler ${argv.join(" ")}\` failed:\n\n${out.trim()}`);
  }
  return { ok: res.status === 0, out };
}

/** Adopt an existing database rather than creating a second one. */
function findOrCreateDatabase(name) {
  const info = wrangler(["d1", "info", name, "--json"], { allowFail: true });
  if (info.ok) {
    const id = parseDatabaseId(info.out);
    if (id) return { id, created: false };
  }

  const created = wrangler(["d1", "create", name]);
  const id = parseDatabaseId(created.out);
  if (!id) {
    die(
      `Created ${name}, but couldn't find its id in wrangler's output:\n\n${created.out.trim()}\n\n` +
        `Put it into wrangler.jsonc by hand as "database_id".`,
    );
  }
  return { id, created: true };
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const domain = argv.find((a) => !a.startsWith("--"));
  if (!domain) die(USAGE);

  const names = resourceNames(domain);
  if (!names) die(`"${domain}" doesn't look like a domain.`);

  console.log(`\nProvisioning for ${domain}\n`);
  console.log(`  Worker        ${names.worker}`);
  console.log(`  D1 database   ${names.database}`);
  console.log(`  R2 bucket     ${names.bucket}\n`);

  if (dryRun) {
    console.log("--dry-run: nothing created.\n");
    return;
  }

  const db = findOrCreateDatabase(names.database);
  console.log(`${db.created ? "Created" : "Found"} D1 ${names.database} (${db.id})`);

  // allowFail: creating a bucket that already exists isn't worth stopping for.
  const bucket = wrangler(["r2", "bucket", "create", names.bucket], { allowFail: true });
  if (bucket.ok) {
    console.log(`Created R2 ${names.bucket}`);
  } else if (/already (exists|owned)/i.test(bucket.out)) {
    console.log(`Found R2 ${names.bucket}`);
  } else {
    die(`Couldn't create the R2 bucket:\n\n${bucket.out.trim()}`);
  }

  const before = readFileSync(CONFIG, "utf8");
  let config;
  try {
    config = rewriteConfig(before, names, db.id);
  } catch (err) {
    die(err.message);
  }

  if (config === before) {
    console.log("\nwrangler.jsonc already pointed at these.\n");
  } else {
    writeFileSync(CONFIG, config);
    console.log("\nUpdated wrangler.jsonc\n");
  }

  console.log("Next:\n");
  // `run` is required: `pnpm deploy` is a built-in pnpm command.
  console.log("  pnpm run deploy        build, migrate and deploy");
  console.log("  then open the Worker's URL and finish setup in the browser\n");
}

// Importing this module (the tests do) must not run the command.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}

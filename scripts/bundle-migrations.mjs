#!/usr/bin/env node
// Package apps/api/migrations/*.sql into a JSON module the Worker can import.
//
//   node scripts/bundle-migrations.mjs          write the bundle
//   node scripts/bundle-migrations.mjs --check  exit 1 if the bundle is stale
//
// Why: migrations are applied by the Worker itself (first visit to /setup, and
// the admin "Update database" button), not by `wrangler d1 migrations apply` in
// the deploy command. That keeps deploys to `build + wrangler deploy`, which is
// what the Deploy to Cloudflare button runs, and means the deploy token never
// needs to reach the database.
//
// Each file is split into single statements here, at build time, because a D1
// batch takes one prepared statement per entry. Trigger bodies contain `;`, so
// the splitter tracks BEGIN/END inside CREATE TRIGGER and keeps them whole.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../apps/api/migrations/", import.meta.url));
const OUT = fileURLToPath(new URL("../apps/api/src/migrations/bundle.json", import.meta.url));

/** Split SQL into statements, dropping comments, keeping trigger bodies whole. */
export function splitSql(sql) {
  const tokens =
    sql.match(
      /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_]+|;|[^\S\n]+|\n|./g,
    ) ?? [];
  const statements = [];
  let current = "";
  let depth = 0;
  let inTrigger = false;

  for (const token of tokens) {
    if (token.startsWith("--") || token.startsWith("/*")) {
      current += token.endsWith("\n") ? "\n" : " ";
      continue;
    }
    const word = token.toUpperCase();
    if (word === "TRIGGER") inTrigger = true;
    if (inTrigger && (word === "BEGIN" || word === "CASE")) depth += 1;
    if (inTrigger && word === "END") depth -= 1;
    current += token;

    if (token === ";" && depth === 0) {
      if (current.trim() !== ";") statements.push(current.trim());
      current = "";
      inTrigger = false;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function buildBundle(dir = DIR) {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, statements: splitSql(readFileSync(new URL(name, `file://${dir}`), "utf8")) }));
  return `${JSON.stringify({ migrations }, null, 1)}\n`;
}

function main(argv) {
  const next = buildBundle();
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (argv.includes("--check")) {
    if (next !== current) {
      console.error("apps/api/src/migrations/bundle.json is stale. Run `pnpm db:bundle`.");
      process.exit(1);
    }
    return;
  }
  if (next !== current) writeFileSync(OUT, next);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}

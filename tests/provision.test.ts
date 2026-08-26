import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  slug,
  resourceNames,
  rewriteConfig,
  parseDatabaseId,
} from "../scripts/provision.mjs";

const WRANGLER = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const ID = "11111111-2222-3333-4444-555555555555";

test("a domain becomes a safe resource name", () => {
  // Dots aren't valid in Cloudflare resource names.
  assert.equal(slug("example.com"), "example-com");
  assert.equal(slug("mail.example.co.uk"), "mail-example-co-uk");
  // Tolerate what people actually paste.
  assert.equal(slug("  HTTPS://Mail.Example.com/inbox  "), "mail-example-com");
  assert.equal(slug("example_com"), "example-com");
  assert.equal(slug("--example--"), "example");
});

test("the whole domain is kept, not just the apex label", () => {
  // example.com and example.org would otherwise want the same database name in
  // one Cloudflare account, and a D1 name can never be changed afterwards.
  assert.notEqual(slug("example.com"), slug("example.org"));
});

test("input with nothing usable in it is refused", () => {
  for (const bad of ["", "   ", "...", "---", "///"]) {
    assert.equal(resourceNames(bad), null, JSON.stringify(bad));
  }
});

test("every resource is named after the domain", () => {
  const names = resourceNames("example.com")!;
  assert.deepEqual(names, {
    base: "example-com",
    worker: "example-com-driftmail",
    database: "example-com-driftmail",
    bucket: "example-com-driftmail-mail",
  });
});

test("the real wrangler.jsonc is rewritten, comments and all", () => {
  const before = readFileSync(WRANGLER, "utf8");
  const names = resourceNames("example.com")!;
  const after = rewriteConfig(before, names, ID);

  assert.match(after, /"database_name":\s*"example-com-driftmail"/);
  assert.match(after, new RegExp(`"database_id":\\s*"${ID}"`));
  assert.match(after, /"bucket_name":\s*"example-com-driftmail-mail"/);
  assert.match(after, /"name":\s*"example-com-driftmail"/);

  // The binding names are not resource names and must survive untouched.
  assert.match(after, /"binding":\s*"DB"/);
  assert.match(after, /"binding":\s*"EMAIL_CACHE"/);
  assert.match(after, /"send_email":\s*\[\{\s*"name":\s*"EMAIL"\s*\}\]/);

  // Targeted replacement rather than parse-and-serialize, so the file keeps its
  // explanatory comments — which are most of its value.
  assert.ok(after.includes("// One-click"), "comments were lost");
  assert.equal(
    after.split("\n").length,
    before.split("\n").length,
    "the file's shape changed",
  );
});

test("re-provisioning the same domain is a no-op", () => {
  const before = readFileSync(WRANGLER, "utf8");
  const names = resourceNames("example.com")!;
  const once = rewriteConfig(before, names, ID);
  const twice = rewriteConfig(once, names, ID);
  assert.equal(twice, once);
});

test("an already-provisioned config can be repointed at another domain", () => {
  const base = readFileSync(WRANGLER, "utf8");
  const first = rewriteConfig(base, resourceNames("example.com")!, ID);
  const second = rewriteConfig(first, resourceNames("other.org")!, ID);
  assert.match(second, /"name":\s*"other-org-driftmail"/);
  assert.match(second, /"database_name":\s*"other-org-driftmail"/);
  assert.ok(!second.includes("example-com"));
});

test("a config missing a field it must set is an error, not a silent skip", () => {
  const names = resourceNames("example.com")!;
  assert.throws(
    () => rewriteConfig(`{ "name": "driftmail" }`, names, ID),
    /database_name/,
  );
});

test("the database id is found in either shape wrangler prints", () => {
  assert.equal(parseDatabaseId(`{"uuid": "${ID}"}`), ID);
  assert.equal(parseDatabaseId(`"database_id": "${ID}"`), ID);
  // The human-readable table form, where the id is just loose in the output.
  assert.equal(parseDatabaseId(`✅ Created database 'x' in region ENAM\n${ID}\n`), ID);
  assert.equal(parseDatabaseId("no id here"), null);
});

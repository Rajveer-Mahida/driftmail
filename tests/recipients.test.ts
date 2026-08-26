import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedRecipient,
  matchDomain,
  globToRe,
  toPolicy,
  type DomainPolicy,
  type DomainRow,
} from "../apps/api/src/config/domains.ts";

/** A policy with sane defaults; override only what a case cares about. */
const policy = (over: Partial<DomainPolicy> & { domain: string }): DomainPolicy => ({
  acceptAll: true,
  allowedPattern: [],
  aliasSuffix: "",
  fallbackForwardTo: null,
  forwardTo: null,
  defaultFrom: null,
  catchallUserId: null,
  isPrimary: false,
  sendProvider: null,
  ...over,
});

test("rejects domains that aren't configured", () => {
  const p = [policy({ domain: "example.com" })];
  assert.equal(isAllowedRecipient(p, "hi@example.com"), true);
  assert.equal(isAllowedRecipient(p, "hi@notmine.com"), false);
  // Substring tricks must not pass the domain check.
  assert.equal(isAllowedRecipient(p, "hi@evil-example.com"), false);
  assert.equal(isAllowedRecipient(p, "hi@example.com.evil.com"), false);
});

test("an empty instance accepts nothing", () => {
  // This is the invariant that keeps a freshly deployed, unclaimed Worker inert.
  for (const addr of ["anything@example.com", "", "@", "a@", "@b.com", "no-at-sign"]) {
    assert.equal(isAllowedRecipient([], addr), false, addr);
  }
});

test("accept-all takes every address on those domains", () => {
  const p = [policy({ domain: "example.com" }), policy({ domain: "example.org" })];
  assert.equal(isAllowedRecipient(p, "anything@example.com"), true);
  assert.equal(isAllowedRecipient(p, "any.thing+tag@example.org"), true);
  assert.equal(isAllowedRecipient(p, "anything@elsewhere.com"), false);
});

test("a wildcard pattern reproduces the old suffix gate", () => {
  const p = [
    policy({ domain: "example.com", acceptAll: false, allowedPattern: ["*.smi@example.com"] }),
    policy({ domain: "example.org", acceptAll: false, allowedPattern: ["*.smi@example.org"] }),
  ];
  assert.equal(isAllowedRecipient(p, "foo.smi@example.com"), true);
  assert.equal(isAllowedRecipient(p, "foo.smi@example.org"), true);
  assert.equal(isAllowedRecipient(p, "foo@example.com"), false);
  // Anchored: the pattern must match the whole address, not a prefix of it.
  assert.equal(isAllowedRecipient(p, "foo.smi@example.com.evil.com"), false);
});

test("glob domains match subdomains but stay anchored", () => {
  const p = [policy({ domain: "*.example.com" })];
  assert.equal(isAllowedRecipient(p, "hi@mail.example.com"), true);
  assert.equal(isAllowedRecipient(p, "hi@a.b.example.com"), true);
  assert.equal(isAllowedRecipient(p, "hi@example.com"), false);
  assert.equal(isAllowedRecipient(p, "hi@mail.example.com.evil.com"), false);
});

test("an exact domain wins over a glob", () => {
  const p = [
    policy({ domain: "*", acceptAll: false, allowedPattern: ["nobody@nowhere"] }),
    policy({ domain: "example.com" }),
  ];
  assert.equal(matchDomain(p, "hi@example.com")?.domain, "example.com");
  assert.equal(isAllowedRecipient(p, "hi@example.com"), true);
  // The catch-all glob still applies to everything else, with its own rules.
  assert.equal(matchDomain(p, "hi@other.com")?.domain, "*");
  assert.equal(isAllowedRecipient(p, "hi@other.com"), false);
});

test("addresses are normalized before matching", () => {
  const p = [policy({ domain: "example.com" })];
  assert.equal(isAllowedRecipient(p, "  HI@Example.COM  "), true);
  // A trailing FQDN dot is legal on the wire and must not defeat the match.
  assert.equal(isAllowedRecipient(p, "hi@example.com."), true);
  // Split on the LAST @, so a local part containing one still resolves.
  assert.equal(matchDomain(p, "a@b@example.com")?.domain, "example.com");
});

test("globToRe escapes regex metacharacters", () => {
  assert.equal(globToRe("a.b").test("axb"), false, "the dot must be literal");
  assert.equal(globToRe("a.b").test("a.b"), true);
  assert.equal(globToRe("a+b").test("a+b"), true);
  assert.equal(globToRe("a*b").test("axxxb"), true);
});

test("toPolicy reads a row faithfully", () => {
  const row = {
    domain: "Example.COM",
    accept_all: 0,
    allowed_pattern: " *.smi@example.com , Foo@Example.com ",
    alias_suffix: "smi",
    fallback_forward_to: "me@gmail.com",
    forward_to: null,
    default_from: "reply@example.com",
    catchall_user_id: "u1",
    is_primary: 1,
    send_provider: "resend",
  } as DomainRow;

  const p = toPolicy(row);
  assert.equal(p.domain, "example.com");
  assert.equal(p.acceptAll, false);
  assert.deepEqual(p.allowedPattern, ["*.smi@example.com", "foo@example.com"]);
  assert.equal(p.isPrimary, true);
  assert.equal(p.sendProvider, "resend");
});

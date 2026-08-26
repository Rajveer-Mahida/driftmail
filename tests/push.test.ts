import { test } from "node:test";
import assert from "node:assert/strict";
import { vapidPublicKey } from "../apps/api/src/push.ts";

const b64url = (buf: ArrayBuffer) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    jwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    raw: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}

// The whole point of deriving it: the derived key must be byte-identical to the
// one `generate-vapid` used to print, or every existing subscription breaks.
test("derives the same public key the raw export produces", async () => {
  for (let i = 0; i < 20; i++) {
    const { jwk, raw } = await keyPair();
    assert.equal(vapidPublicKey(jwk), raw);
  }
});

test("derived key is a 65-byte uncompressed EC point", async () => {
  const { jwk } = await keyPair();
  const key = vapidPublicKey(jwk)!;
  const bytes = Buffer.from(key.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 0x04);
});

test("returns null instead of throwing on unusable input", () => {
  assert.equal(vapidPublicKey(null), null);
  assert.equal(vapidPublicKey(""), null);
  assert.equal(vapidPublicKey("not json"), null);
  assert.equal(vapidPublicKey('{"kty":"EC"}'), null);
  assert.equal(vapidPublicKey('{"x":"AA","y":"AA"}'), null);
});

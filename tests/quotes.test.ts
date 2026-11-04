// The "•••" fold: what counts as quoted history in a plain-text body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitQuotedText } from "../apps/web/src/lib/quotes.ts";
test("quoted history folds in plain-text replies", () => {
  const a = splitQuotedText("dadad\n\nOn Tue, 3 Nov 2026, 17:36, Rajveer Mahida wrote:\n> fsfs\n>\n>");
  assert.equal(a.main, "dadad"); assert.match(a.quoted, /^On Tue/);
  const b = splitQuotedText("Yes yes do ahend\n\nOn Tue, Nov 3, 2026 at 5:37 PM <hello@rajveer.space> wrote:\n\n> dadad\n");
  assert.equal(b.main, "Yes yes do ahend");
  const c = splitQuotedText("hi\n> quoted\n> more\n");
  assert.equal(c.main, "hi");
  const d = splitQuotedText("just text\nline two");
  assert.equal(d.quoted, "");
  const e = splitQuotedText("> only a quote");
  assert.equal(e.quoted, "");
});

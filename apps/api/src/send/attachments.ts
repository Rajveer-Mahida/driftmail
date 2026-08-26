// Pulling attachment blobs back out of R2 before a send.
//
// This loop existed verbatim in three places (compose, send-now, the cron), each
// with its own defaults for a missing filename or mime type.

import type { OutboundAttachment } from "./types.ts";

type Ref = {
  /** R2 object key. */
  key: string;
  filename?: string | null;
  mime_type?: string | null;
  content_id?: string | null;
};

export async function loadFromR2(
  bucket: R2Bucket,
  refs: Ref[],
): Promise<OutboundAttachment[]> {
  const out: OutboundAttachment[] = [];
  for (const ref of refs) {
    const obj = await bucket.get(ref.key);
    // A blob that has expired or been swept is skipped rather than failing the
    // send: losing an attachment is better than losing the message.
    if (!obj) continue;
    out.push({
      content: await obj.arrayBuffer(),
      filename: ref.filename || "file",
      type: ref.mime_type || "application/octet-stream",
      disposition: ref.content_id ? "inline" : "attachment",
      contentId: ref.content_id ?? undefined,
    });
  }
  return out;
}

/** Split a stored comma-separated address list into recipients. */
export function splitAddrs(s: string | null | undefined): string[] {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// ── Quoted history ───────────────────────────────────────────────────────────
//
// Replies carry the whole conversation below the new text. Like Gmail, show only
// the new part and fold the rest behind a "•••" toggle.

/** Containers each major client wraps quoted history in. */
const QUOTE_SELECTORS = [
  ".gmail_quote_container",
  ".gmail_quote",
  "blockquote[type='cite']",
  ".yahoo_quoted",
  ".protonmail_quote",
  "#divRplyFwdMsg",
  "#appendonsend",
  "div[id^='mail-editor-reference-message']",
];

const hasContent = (s: string) => s.replace(/<[^>]*>|&nbsp;|\s/g, "").length > 0;

/** Split sanitized HTML into the new message and its quoted history. */
export function splitQuotedHtml(html: string): { main: string; quoted: string } {
  if (!html || typeof DOMParser === "undefined") return { main: html, quoted: "" };
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  let node: Element | null = doc.body.querySelector(QUOTE_SELECTORS.join(","));
  if (!node) {
    // A plain <blockquote> counts only when nothing but whitespace follows it.
    const bq = [...doc.body.querySelectorAll("blockquote")].pop();
    if (bq && !hasContent(afterNode(bq))) node = bq;
  }
  if (!node) return { main: html, quoted: "" };

  // Outlook's reply header sits in a sibling <hr> / div just before the quote.
  const prev = node.previousElementSibling;
  const start = prev && prev.tagName === "HR" ? prev : node;

  const range = doc.createRange();
  range.setStartBefore(start);
  range.setEndAfter(doc.body.lastChild!);
  const quotedFrag = range.extractContents();
  const holder = doc.createElement("div");
  holder.appendChild(quotedFrag);

  // A trailing "On …, X wrote:" line that Gmail left outside the quote.
  const main = doc.body.innerHTML.replace(/(<br\s*\/?>|\s)*(<div[^>]*>)?\s*On [^<]{5,300}wrote:\s*(<\/div>)?(<br\s*\/?>|\s)*$/i, "");
  if (!hasContent(main)) return { main: html, quoted: "" };
  return { main, quoted: holder.innerHTML };

  function afterNode(n: Element): string {
    let s = "";
    for (let cur: Node | null = n.nextSibling; cur; cur = cur.nextSibling) {
      s += cur.nodeType === 1 ? (cur as Element).outerHTML : (cur.textContent ?? "");
    }
    return s;
  }
}

const TEXT_QUOTE_START = [
  /^On .{5,300}wrote:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^From: .+$/, // Outlook's plain-text reply header
];

/** Split a plain-text body into the new message and its quoted history. */
export function splitQuotedText(text: string): { main: string; quoted: string } {
  const lines = (text ?? "").split(/\r?\n/);
  let cut = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (TEXT_QUOTE_START.some((re) => re.test(line))) {
      // Outlook's "From:" only counts when it starts a header block.
      if (line.startsWith("From:") && !/^(Sent|Date|To|Subject):/.test(lines[i + 1]?.trim() ?? "")) continue;
      cut = i;
      break;
    }
  }
  if (cut < 0) {
    // A trailing run of "> " lines with nothing after it.
    let i = lines.length - 1;
    while (i >= 0 && !lines[i].trim()) i--;
    const end = i;
    while (i >= 0 && (lines[i].startsWith(">") || !lines[i].trim())) i--;
    if (i < end && lines.slice(i + 1, end + 1).some((l) => l.startsWith(">"))) cut = i + 1;
  }
  if (cut <= 0) return { main: text, quoted: "" };
  const main = lines.slice(0, cut).join("\n").trimEnd();
  if (!main.trim()) return { main: text, quoted: "" };
  return { main, quoted: lines.slice(cut).join("\n").trim() };
}

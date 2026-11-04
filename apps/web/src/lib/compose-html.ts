// HTML for the composer: converting to and from plain text, quoting the message
// being answered, and cleaning what the editor produces before it is sent.

import DOMPurify from "dompurify";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Plain text → HTML that keeps its line breaks. */
export function textToHtml(text: string): string {
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .map((line) => (line ? `<div>${escapeHtml(line)}</div>` : "<div><br></div>"))
    .join("");
}

const BLOCK = new Set(["P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "TR", "PRE", "HR"]);

/** HTML → the plain-text alternative sent alongside it. */
export function htmlToText(html: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const out: string[] = [];
  let line = "";
  const flush = (prefix: string) => {
    out.push(prefix + line);
    line = "";
  };

  function walk(node: Node, prefix: string, listIndex: { n: number } | null) {
    if (node.nodeType === Node.TEXT_NODE) {
      line += (node.textContent ?? "").replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName;
    if (tag === "BR") return flush(prefix);
    if (tag === "STYLE" || tag === "SCRIPT") return;

    const block = BLOCK.has(tag);
    if (block && line.trim()) flush(prefix);
    let childPrefix = prefix;
    if (tag === "BLOCKQUOTE") childPrefix = `${prefix}> `;
    let childList = listIndex;
    if (tag === "OL") childList = { n: 0 };
    if (tag === "UL") childList = null;
    if (tag === "LI") line += listIndex ? `${++listIndex.n}. ` : "- ";

    for (const child of el.childNodes) walk(child, childPrefix, tag === "OL" || tag === "UL" ? childList : listIndex);

    if (tag === "A") {
      const href = el.getAttribute("href") ?? "";
      const label = el.textContent?.trim() ?? "";
      if (href && !href.startsWith("mailto:") && href !== label) line += ` (${href})`;
    }
    if (tag === "HR") line += "----------";
    if (block && line) flush(childPrefix);
  }

  for (const child of doc.body.childNodes) walk(child, "", null);
  if (line) flush("");
  return out
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What the editor may produce. Anything else — pasted styles, scripts, event
 *  handlers — is removed before the message is saved or sent. */
const EDITOR_TAGS = [
  "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "br", "div", "p", "span",
  "ul", "ol", "li", "blockquote", "pre", "code", "hr", "h1", "h2", "h3", "img",
  "table", "thead", "tbody", "tr", "td", "th", "font", "sub", "sup",
];

export function cleanHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: EDITOR_TAGS,
    ALLOWED_ATTR: ["href", "src", "alt", "title", "style", "class", "dir", "colspan", "rowspan", "width", "height", "color"],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|cid:|data:image\/)/i,
  });
}

export function isBlankHtml(html: string): boolean {
  return !html.replace(/<(?!img)[^>]*>|&nbsp;|\s/gi, "");
}

/** The signature block appended to a new message. */
export function signatureHtml(signature: string): string {
  if (!signature.trim()) return "";
  return `<div><br></div><div class="driftmail_signature">-- <br>${escapeHtml(signature).replace(/\n/g, "<br>")}</div>`;
}

/** The earlier message under "On …, X wrote:", in Gmail's markup so Gmail,
 *  Outlook and Driftmail all fold it. */
export function quoteHtml(opts: { date: string; from: string; html?: string | null; text?: string | null }): string {
  const body = opts.html ? cleanHtml(opts.html) : textToHtml(opts.text ?? "");
  return (
    `<div class="gmail_quote"><div class="gmail_attr">On ${escapeHtml(opts.date)}, ${escapeHtml(opts.from)} wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote></div>`
  );
}

export function forwardHtml(opts: { date: string; from: string; to: string; subject: string; html?: string | null; text?: string | null }): string {
  const body = opts.html ? cleanHtml(opts.html) : textToHtml(opts.text ?? "");
  return (
    `<div class="gmail_quote"><div>---------- Forwarded message ---------<br>` +
    `From: ${escapeHtml(opts.from)}<br>Date: ${escapeHtml(opts.date)}<br>` +
    `Subject: ${escapeHtml(opts.subject)}<br>To: ${escapeHtml(opts.to)}<br></div><br>${body}</div>`
  );
}

/** Put the user's text above the quoted part, as one message. */
export function joinWithQuote(html: string, quoted: string): string {
  if (!quoted) return html;
  return `${html}<div><br></div>${quoted}`;
}

const SIGNATURE = /<div class="driftmail_signature">[\s\S]*$/;

/** The body without the signature block at its end. */
export function withoutSignature(html: string): string {
  return html.replace(SIGNATURE, "");
}

/** Insert a template: it replaces an empty body, otherwise goes at the end —
 *  either way above the signature. */
export function insertTemplate(html: string, template: string): string {
  const sig = html.match(SIGNATURE)?.[0] ?? "";
  const body = sig ? html.slice(0, html.length - sig.length) : html;
  if (isBlankHtml(body)) return `${template}${sig ? `<div><br></div>${sig}` : ""}`;
  return `${body}${template}${sig}`;
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  Quote,
  Link2,
  RemoveFormatting,
  Check,
  X,
} from "lucide-react";
import { Tip } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { escapeHtml } from "@/lib/compose-html";

type Command = {
  command: string;
  value?: string;
  label: string;
  shortcut?: string;
  icon: typeof Bold;
  /** queryCommandState name, when it differs from the command. */
  state?: string;
};

const COMMANDS: Command[] = [
  { command: "bold", label: "Bold", shortcut: "Ctrl+B", icon: Bold },
  { command: "italic", label: "Italic", shortcut: "Ctrl+I", icon: Italic },
  { command: "underline", label: "Underline", shortcut: "Ctrl+U", icon: Underline },
  { command: "strikeThrough", label: "Strikethrough", icon: Strikethrough },
  { command: "insertUnorderedList", label: "Bulleted list", icon: List },
  { command: "insertOrderedList", label: "Numbered list", icon: ListOrdered },
  { command: "formatBlock", value: "blockquote", label: "Quote", icon: Quote },
];

/**
 * A small HTML editor on contentEditable: bold, italic, underline, strike,
 * lists, quote and links. Pasted content arrives as plain text, so a message
 * never carries another site's markup. The quoted original (a reply's history)
 * is shown folded below the editor and is not editable.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus,
  onSubmit,
  quotedHtml,
  className,
  minHeight = "10rem",
  toolbarEnd,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Ctrl/⌘+Enter. */
  onSubmit?: () => void;
  quotedHtml?: string;
  className?: string;
  minHeight?: string;
  toolbarEnd?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [showQuoted, setShowQuoted] = useState(false);
  const [empty, setEmpty] = useState(!value);

  // Keep the DOM in step with `value` without moving the caret on every keystroke:
  // only write when the value changed from outside (a template, a loaded draft).
  useEffect(() => {
    const el = ref.current;
    if (el && el.innerHTML !== value) el.innerHTML = value;
    setEmpty(isEmpty(el));
  }, [value]);

  // On mount only: a prop that flips later (e.g. once a recipient is added) must
  // not pull focus away from the field the user is typing in.
  const focusOnMount = useRef(autoFocus);
  useEffect(() => {
    if (!focusOnMount.current || !ref.current) return;
    ref.current.focus();
    // Caret at the start, above any signature.
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(ref.current, 0);
    r.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(r);
  }, []);

  /** Which toolbar buttons are "on" at the caret. */
  function refreshActive() {
    const el = ref.current;
    const sel = window.getSelection();
    if (!el || !sel?.rangeCount || !el.contains(sel.anchorNode)) return;
    const next: Record<string, boolean> = {};
    for (const c of COMMANDS) {
      try {
        next[c.label] =
          c.command === "formatBlock"
            ? !!closest(sel.anchorNode, "BLOCKQUOTE", el)
            : document.queryCommandState(c.state ?? c.command);
      } catch {
        next[c.label] = false;
      }
    }
    next.Link = !!closest(sel.anchorNode, "A", el);
    // Links are underlined by style, which the browser reports as "underline".
    if (next.Link && !closest(sel.anchorNode, "U", el)) next.Underline = false;
    setActive(next);
  }

  useEffect(() => {
    document.addEventListener("selectionchange", refreshActive);
    return () => document.removeEventListener("selectionchange", refreshActive);
  }, []);

  function emit() {
    const el = ref.current;
    if (!el) return;
    setEmpty(isEmpty(el));
    onChange(el.innerHTML);
    // execCommand doesn't move the selection, so no selectionchange fires.
    refreshActive();
  }

  function run(c: Command) {
    if (disabled) return;
    ref.current?.focus();
    restoreRange();
    if (c.command === "formatBlock") {
      const sel = window.getSelection();
      const inQuote = sel?.anchorNode && ref.current ? closest(sel.anchorNode, "BLOCKQUOTE", ref.current) : null;
      document.execCommand("formatBlock", false, inQuote ? "div" : "blockquote");
    } else {
      document.execCommand(c.command, false, c.value);
    }
    emit();
  }

  function saveRange() {
    const sel = window.getSelection();
    if (sel?.rangeCount && ref.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  }
  /** Put back the selection saved on blur — only when the editor has lost its
   *  own, or a toolbar click would jump the caret back to an old position. */
  function restoreRange() {
    const r = savedRange.current;
    const sel = window.getSelection();
    if (!r || (sel?.rangeCount && ref.current?.contains(sel.anchorNode))) return;
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  function openLink() {
    saveRange();
    const sel = window.getSelection();
    const a = sel?.anchorNode && ref.current ? closest(sel.anchorNode, "A", ref.current) : null;
    setLinkUrl(a?.getAttribute("href") ?? "");
    setLinkOpen(true);
  }

  function applyLink() {
    let url = linkUrl.trim();
    setLinkOpen(false);
    ref.current?.focus();
    restoreRange();
    if (!url) {
      document.execCommand("unlink");
      return emit();
    }
    if (!/^(https?:|mailto:)/i.test(url)) url = url.includes("@") && !url.includes("/") ? `mailto:${url}` : `https://${url}`;
    const sel = window.getSelection();
    if (sel && sel.isCollapsed) {
      // No selection: insert the address itself as the link text.
      document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(linkUrl.trim())}</a>&nbsp;`);
    } else {
      document.execCommand("createLink", false, url);
    }
    emit();
  }

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1">
        {COMMANDS.map((c) => (
          <Tip key={c.label} label={c.shortcut ? `${c.label} (${c.shortcut})` : c.label}>
            <button
              type="button"
              // Keep focus (and the selection) in the editor.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(c)}
              disabled={disabled}
              aria-label={c.label}
              aria-pressed={!!active[c.label]}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-inset hover:text-fg disabled:opacity-40",
                active[c.label] && "bg-inset text-fg",
              )}
            >
              <c.icon size={15} />
            </button>
          </Tip>
        ))}
        <Tip label="Link (Ctrl+K)">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openLink}
            disabled={disabled}
            aria-label="Link"
            aria-pressed={!!active.Link}
            className={cn(
              "grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-inset hover:text-fg disabled:opacity-40",
              active.Link && "bg-inset text-fg",
            )}
          >
            <Link2 size={15} />
          </button>
        </Tip>
        <Tip label="Clear formatting">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              document.execCommand("removeFormat");
              document.execCommand("unlink");
              emit();
            }}
            disabled={disabled}
            aria-label="Clear formatting"
            className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-inset hover:text-fg disabled:opacity-40"
          >
            <RemoveFormatting size={15} />
          </button>
        </Tip>
        {toolbarEnd && <div className="ml-auto flex items-center gap-1">{toolbarEnd}</div>}
      </div>

      {linkOpen && (
        <div className="flex items-center gap-2 border-b border-border bg-inset/50 px-3 py-1.5">
          <Link2 size={14} className="text-faint" />
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              } else if (e.key === "Escape") {
                setLinkOpen(false);
                ref.current?.focus();
                restoreRange();
              }
            }}
            placeholder="https://… or name@example.com — empty removes the link"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <button type="button" onClick={applyLink} className="text-accent" aria-label="Apply link">
            <Check size={15} />
          </button>
          <button type="button" onClick={() => setLinkOpen(false)} className="text-faint hover:text-fg" aria-label="Cancel">
            <X size={15} />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {empty && placeholder && (
          <div className="pointer-events-none absolute left-3 top-3 text-[14px] text-faint">{placeholder}</div>
        )}
        <div
          ref={ref}
          role="textbox"
          aria-multiline="true"
          aria-label={placeholder ?? "Message"}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={emit}
          onBlur={saveRange}
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && e.key === "Enter" && onSubmit) {
              e.preventDefault();
              e.stopPropagation();
              onSubmit();
            } else if (mod && e.key.toLowerCase() === "k") {
              // Ctrl+K is the command palette everywhere else; here it is "link".
              e.preventDefault();
              e.stopPropagation();
              openLink();
            }
          }}
          onPaste={(e) => {
            // Plain text only: pasted pages bring fonts, colours and trackers.
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            document.execCommand("insertText", false, text);
          }}
          onDrop={(e) => {
            // Files are attachments, handled by the composer; text drops as text.
            if (e.dataTransfer.files.length) return;
            e.preventDefault();
            document.execCommand("insertText", false, e.dataTransfer.getData("text/plain"));
          }}
          style={{ minHeight }}
          className="composer-html px-3 py-3 text-[14px] leading-relaxed outline-none"
        />

        {quotedHtml && (
          <div className="px-3 pb-3">
            <button
              type="button"
              onClick={() => setShowQuoted((v) => !v)}
              title={showQuoted ? "Hide quoted text" : "Show quoted text"}
              aria-label={showQuoted ? "Hide quoted text" : "Show quoted text"}
              aria-expanded={showQuoted}
              className="inline-flex h-5 items-center rounded-md border border-border bg-inset px-2 text-[13px] font-semibold leading-none tracking-[0.2em] text-muted transition hover:text-fg"
            >
              •••
            </button>
            {showQuoted && (
              <div
                className="composer-html mt-2 text-[13px] text-muted"
                // Already sanitized by cleanHtml when it was built.
                dangerouslySetInnerHTML={{ __html: quotedHtml }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function isEmpty(el: HTMLElement | null): boolean {
  if (!el) return true;
  return !el.textContent?.trim() && !el.querySelector("img,li,hr");
}

function closest(node: Node | null, tag: string, root: HTMLElement): Element | null {
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === tag) return n as Element;
  }
  return null;
}

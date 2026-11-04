import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X, Paperclip, Send, Clock, Trash2, ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import type { UploadedAttachment } from "@email/shared";
import { useUI } from "@/lib/store";
import { useSend, useDeleteDraft, useSettings } from "@/api/hooks";
import { api, ApiError } from "@/api/client";
import { Button, IconButton, Spinner, Tip } from "@/components/primitives";
import { cn, formatBytes } from "@/lib/utils";
import { RichTextEditor } from "@/components/RichTextEditor";
import { FromPicker, TemplateMenu } from "@/components/ComposerMenus";
import {
  cleanHtml,
  htmlToText,
  insertTemplate,
  isBlankHtml,
  joinWithQuote,
  signatureHtml,
  textToHtml,
} from "@/lib/compose-html";

const UNDO_WINDOW = 8000;
const EXPANDED_KEY = "driftmail-compose-expanded";

function initialExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function splitAddrs(s: string): string[] {
  return s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

// Lightweight chip recipient field.
function Recipients({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  function commit() {
    const toks = splitAddrs(draft);
    if (toks.length) onChange([...value, ...toks]);
    setDraft("");
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
      <span className="text-xs font-medium text-faint">{label}</span>
      {value.map((addr, i) => (
        <span
          key={`${addr}-${i}`}
          className="flex items-center gap-1 rounded-full bg-inset px-2 py-0.5 text-xs"
        >
          {addr}
          <button onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-faint hover:text-danger">
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        autoFocus={autoFocus}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        className="min-w-[8ch] flex-1 bg-transparent text-sm outline-none"
      />
    </div>
  );
}

export function Compose() {
  const { composeInit, closeCompose } = useUI();
  const qc = useQueryClient();
  const send = useSend();
  const delDraft = useDeleteDraft();
  const settings = useSettings();

  const [from, setFrom] = useState(composeInit?.from ?? "");
  const [to, setTo] = useState<string[]>(composeInit?.to ?? []);
  const [cc, setCc] = useState<string[]>(composeInit?.cc ?? []);
  const [bcc, setBcc] = useState<string[]>(composeInit?.bcc ?? []);
  const [showCc, setShowCc] = useState((composeInit?.cc?.length ?? 0) > 0 || (composeInit?.bcc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(composeInit?.subject ?? "");
  const [html, setHtml] = useState(() => composeInit?.html ?? textToHtml(composeInit?.text ?? ""));
  const quoted = composeInit?.quotedHtml ?? "";
  const [attachments, setAttachments] = useState<UploadedAttachment[]>(composeInit?.attachments ?? []);
  const [uploading, setUploading] = useState(0);
  const [scheduleAt, setScheduleAt] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const [busy, setBusy] = useState(false);
  // Gmail's full-screen composer: large and centred over a dimmed backdrop.
  const [expanded, setExpandedState] = useState(() => composeInit?.expanded ?? initialExpanded());
  function setExpanded(next: boolean) {
    setExpandedState(next);
    try {
      localStorage.setItem(EXPANDED_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  const draftId = useRef(composeInit?.draftId);
  const sigApplied = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inReplyTo = composeInit?.inReplyToMessageId;

  // Signature once, below an empty line, for anything that isn't a loaded draft.
  useEffect(() => {
    if (sigApplied.current) return;
    const sig = settings.data?.signature;
    if (sig && !composeInit?.draftId) {
      sigApplied.current = true;
      // A reply popped out of the inline box already carries it.
      setHtml((h) => (h.includes("driftmail_signature") ? h : `<div><br></div>${h}${signatureHtml(sig)}`));
    }
  }, [settings.data]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The whole message as sent: the body, then the folded original. */
  function fullHtml(): string {
    return cleanHtml(joinWithQuote(html, quoted));
  }

  // Debounced autosave to the drafts table.
  useEffect(() => {
    if (!to.length && !subject && isBlankHtml(html)) return;
    const t = setTimeout(async () => {
      try {
        const row = await api.saveDraft({
          id: draftId.current,
          to_addr: to.join(", "),
          cc: cc.join(", ") || null,
          bcc: bcc.join(", ") || null,
          subject: subject || null,
          html: fullHtml(),
          text: htmlToText(fullHtml()) || null,
          in_reply_to_id: inReplyTo ?? null,
          attachments: attachments.length ? JSON.stringify(attachments) : null,
        });
        draftId.current = row.id;
        qc.invalidateQueries({ queryKey: ["drafts"] });
        qc.invalidateQueries({ queryKey: ["counts"] });
      } catch {
        /* ignore autosave errors */
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [to, cc, bcc, subject, html, attachments]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading((n) => n + files.length);
    for (const f of Array.from(files)) {
      try {
        const up = await api.uploadFile(f);
        setAttachments((a) => [...a, up]);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : `Upload failed: ${f.name}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  const composeDisabled = settings.data && !settings.data.compose_enabled;

  async function doSend() {
    if (composeDisabled) return toast.error("Compose is disabled in Settings");
    if (!to.length) return toast.error("Add a recipient");
    if (!subject.trim()) return toast.error("Add a subject");
    setBusy(true);
    const sendAfter = showSchedule && scheduleAt ? new Date(scheduleAt).getTime() : Date.now() + UNDO_WINDOW;
    const body = fullHtml();
    try {
      const res = await send.mutateAsync({
        from: from.trim() || undefined,
        to,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
        subject,
        html: body,
        text: htmlToText(body),
        inReplyToMessageId: inReplyTo,
        attachments,
        sendAfter,
        draftId: draftId.current,
      });
      closeCompose();
      if (showSchedule && scheduleAt) {
        toast.success("Scheduled to send", { description: to.join(", ") });
        return;
      }
      // Flush after the undo window (cron-independent, snappy). Undo cancels.
      const timer = setTimeout(async () => {
        try {
          await api.sendNow(res.id);
        } catch (err) {
          toast.error(err instanceof ApiError ? `Send failed: ${err.message}` : "Send failed");
        }
        qc.invalidateQueries({ queryKey: ["messages"] });
        qc.invalidateQueries({ queryKey: ["message"] });
        qc.invalidateQueries({ queryKey: ["counts"] });
      }, UNDO_WINDOW);
      toast.success("Sending message", {
        description: to.join(", "),
        duration: UNDO_WINDOW,
        action: {
          label: "Undo",
          onClick: () => {
            clearTimeout(timer);
            api.cancelSend(res.id).catch(() => {});
            toast.message("Message cancelled");
          },
        },
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Send failed");
      setBusy(false);
    }
  }

  async function discard() {
    if (draftId.current) delDraft.mutate(draftId.current);
    closeCompose();
  }

  // One wrapper for both sizes, so switching never remounts the editor (which
  // would lose the caret). Small: docked bottom-right. Expanded: centred.
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex p-2 md:p-4",
        expanded ? "items-center justify-center md:p-8" : "items-end justify-center md:justify-end",
      )}
    >
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setExpanded(false)}
            className="pointer-events-auto absolute inset-0 bg-black/40 backdrop-blur-[2px]"
            aria-hidden
          />
        )}
      </AnimatePresence>
    <motion.div
      layout
      initial={{ y: 40, opacity: 0, scale: 0.98 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: 40, opacity: 0, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      role="dialog"
      aria-label={inReplyTo ? "Reply" : "New message"}
      aria-modal={expanded || undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape" && expanded) {
          e.stopPropagation();
          setExpanded(false);
        }
      }}
      className={cn(
        "pointer-events-auto relative flex flex-col overflow-hidden rounded-2xl border border-border-strong bg-elevated shadow-[var(--shadow-lg)]",
        expanded
          ? "h-full max-h-[56rem] w-full max-w-5xl"
          : "max-h-[88vh] w-full max-w-2xl md:w-[min(40rem,calc(100vw-2rem))]",
      )}
    >
      <div className="flex items-center justify-between bg-inset px-4 py-2.5">
        <span className="text-sm font-semibold">{inReplyTo ? "Reply" : "New message"}</span>
        <div className="flex items-center gap-0.5">
          <Tip label={expanded ? "Exit full screen" : "Full screen"}>
            <IconButton onClick={() => setExpanded(!expanded)} aria-label={expanded ? "Exit full screen" : "Full screen"}>
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
          </Tip>
          <IconButton onClick={closeCompose} aria-label="Close">
            <X size={16} />
          </IconButton>
        </div>
      </div>

      <FromPicker value={from} onChange={setFrom} />
      <div className="relative">
        <Recipients label="To" value={to} onChange={setTo} autoFocus={!to.length} />
        {!showCc && (
          <button
            onClick={() => setShowCc(true)}
            className="absolute right-3 top-2 text-xs text-faint hover:text-fg"
          >
            Cc/Bcc
          </button>
        )}
      </div>
      {showCc && (
        <>
          <Recipients label="Cc" value={cc} onChange={setCc} />
          <Recipients label="Bcc" value={bcc} onChange={setBcc} />
        </>
      )}

      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        className="border-b border-border bg-transparent px-3 py-2.5 text-sm font-medium outline-none"
      />

      <RichTextEditor
        value={html}
        onChange={setHtml}
        quotedHtml={quoted}
        autoFocus={to.length > 0}
        onSubmit={doSend}
        disabled={!!composeDisabled}
        placeholder={composeDisabled ? "Compose is disabled in Settings" : "Write your message…"}
        className="min-h-0 flex-1"
        toolbarEnd={
          <TemplateMenu
            current={() => ({ subject, html: cleanHtml(html) })}
            onInsert={(t) => {
              if (t.subject && !subject.trim()) setSubject(t.subject);
              setHtml((h) => insertTemplate(h, t.html));
            }}
          />
        }
      />

      {(attachments.length > 0 || uploading > 0) && (
        <div className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
          {attachments.map((a, i) => (
            <span key={a.key} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs">
              <Paperclip size={13} className="text-faint" />
              <span className="max-w-40 truncate">{a.filename}</span>
              <span className="text-faint">{formatBytes(a.size_bytes)}</span>
              <button onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))} className="text-faint hover:text-danger">
                <X size={13} />
              </button>
            </span>
          ))}
          {uploading > 0 && (
            <span className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted">
              <Spinner className="h-3 w-3" /> uploading {uploading}…
            </span>
          )}
        </div>
      )}

      {showSchedule && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-sm">
          <Clock size={15} className="text-muted" />
          <input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
            className="rounded-lg border border-border bg-bg px-2 py-1 text-sm outline-none"
          />
          <button onClick={() => { setShowSchedule(false); setScheduleAt(""); }} className="text-xs text-faint hover:text-fg">
            cancel
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
        <Button variant="primary" size="sm" onClick={doSend} disabled={busy || uploading > 0 || !!composeDisabled}>
          {busy ? <Spinner /> : <Send size={15} />}
          {showSchedule && scheduleAt ? "Schedule" : "Send"}
        </Button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
        <IconButton onClick={() => fileRef.current?.click()} aria-label="Attach">
          <Paperclip size={17} />
        </IconButton>
        <IconButton
          active={showSchedule}
          onClick={() => setShowSchedule((s) => !s)}
          aria-label="Schedule send"
        >
          <Clock size={17} />
        </IconButton>
        <button
          onClick={() => setShowCc((s) => !s)}
          className={cn("ml-1 hidden items-center gap-0.5 text-xs text-faint hover:text-fg sm:flex", showCc && "text-fg")}
        >
          Cc/Bcc <ChevronDown size={12} />
        </button>
        <IconButton className="ml-auto" onClick={discard} aria-label="Discard">
          <Trash2 size={17} />
        </IconButton>
      </div>
    </motion.div>
    </div>
  );
}

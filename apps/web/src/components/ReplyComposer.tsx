import { useState, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Send, X, Clock, Maximize2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useReply, useCancelSend, useSettings } from "@/api/hooks";
import { Button, Spinner, Tip } from "@/components/primitives";
import { useUI } from "@/lib/store";
import { api, ApiError } from "@/api/client";
import { RichTextEditor } from "@/components/RichTextEditor";
import { TemplateMenu } from "@/components/ComposerMenus";
import {
  cleanHtml,
  htmlToText,
  insertTemplate,
  isBlankHtml,
  joinWithQuote,
  signatureHtml,
  withoutSignature,
} from "@/lib/compose-html";

const UNDO_WINDOW = 8000;

export function ReplyComposer({
  messageId,
  to,
  subject,
  quotedHtml = "",
  onClose,
}: {
  messageId: string;
  to: string;
  subject: string;
  /** The message being answered: folded below the editor, sent under the reply. */
  quotedHtml?: string;
  onClose: () => void;
}) {
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const sigApplied = useRef(false);
  const reply = useReply();
  const cancelSend = useCancelSend();
  const settings = useSettings();
  const qc = useQueryClient();
  const openCompose = useUI((s) => s.openCompose);

  /** Move this reply into the full-screen composer, keeping what's written. */
  function popOut() {
    openCompose({
      to: [to],
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      html,
      quotedHtml,
      inReplyToMessageId: messageId,
      expanded: true,
    });
    onClose();
  }
  const disabled = settings.data && !settings.data.reply_enabled;

  useEffect(() => {
    const sig = settings.data?.signature;
    if (sigApplied.current || !sig) return;
    sigApplied.current = true;
    setHtml((h) => `${h || "<div><br></div>"}${signatureHtml(sig)}`);
  }, [settings.data]);

  // Ignoring the signature: a reply that is only a signature is still empty.
  const blank = isBlankHtml(withoutSignature(html));

  async function send() {
    if (blank || busy) return;
    setBusy(true);
    const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
    const isScheduled = showSchedule && scheduleAt;
    const body = cleanHtml(joinWithQuote(html, quotedHtml));
    try {
      const res = await reply.mutateAsync({
        messageId,
        to,
        subject: replySubject,
        html: body,
        text: htmlToText(body),
        sendAfter: isScheduled ? new Date(scheduleAt).getTime() : Date.now() + UNDO_WINDOW,
      });
      onClose();

      if (isScheduled) {
        toast.success("Reply scheduled", { description: `To ${to}` });
        return;
      }

      // Flush the send ourselves once the undo window passes — independent of any
      // cron. send-now claims the pending row atomically, so it can't double-send
      // with the legacy worker's cron. Undo clears the timer + cancels the row.
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

      toast.success("Sending reply", {
        description: `To ${to}`,
        duration: UNDO_WINDOW,
        action: {
          label: "Undo",
          onClick: () => {
            clearTimeout(timer);
            cancelSend.mutate(res.id);
            toast.message("Reply cancelled");
          },
        },
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to send");
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 34 }}
      className="overflow-hidden"
    >
      <div className="px-5 py-3 md:px-8">
        <div className="overflow-hidden rounded-2xl border border-border-strong bg-elevated shadow-[var(--shadow-sm)]">
          <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted">
            <span>
              Reply to <span className="font-mono text-fg">{to}</span>
            </span>
            <div className="flex items-center gap-2">
              <Tip label="Open in full screen">
                <button onClick={popOut} className="text-faint hover:text-fg" aria-label="Open in full screen">
                  <Maximize2 size={14} />
                </button>
              </Tip>
              <button onClick={onClose} className="text-faint hover:text-fg" aria-label="Close">
                <X size={15} />
              </button>
            </div>
          </div>
          <RichTextEditor
            value={html}
            onChange={setHtml}
            quotedHtml={quotedHtml}
            autoFocus
            onSubmit={send}
            disabled={!!disabled}
            minHeight="6rem"
            className="max-h-[50vh]"
            placeholder={disabled ? "Replies are disabled in Settings" : "Write your reply…"}
            toolbarEnd={
              <TemplateMenu
                current={() => ({ subject: "", html: cleanHtml(html) })}
                onInsert={(t) =>
                  setHtml((h) => insertTemplate(h, t.html))
                }
              />
            }
          />
          {showSchedule && (
            <div className="flex items-center gap-2 border-t border-border px-4 py-2 text-sm">
              <Clock size={15} className="text-muted" />
              <input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="rounded-lg border border-border bg-bg px-2 py-1 text-sm outline-none"
              />
              <button
                onClick={() => {
                  setShowSchedule(false);
                  setScheduleAt("");
                }}
                className="text-xs text-faint hover:text-fg"
              >
                cancel
              </button>
            </div>
          )}
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-[11px] text-faint">
              {showSchedule && scheduleAt ? "scheduled" : "⌘↵ to send · 8s undo"}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowSchedule((s) => !s)}
                className={`grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-inset hover:text-fg ${
                  showSchedule ? "text-accent" : ""
                }`}
                aria-label="Schedule send"
              >
                <Clock size={16} />
              </button>
              <Button variant="primary" size="sm" onClick={send} disabled={blank || busy || !!disabled}>
                {busy ? <Spinner /> : <Send size={15} />}
                {showSchedule && scheduleAt ? "Schedule" : "Send"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

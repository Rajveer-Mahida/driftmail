import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowLeft,
  Archive,
  Trash2,
  Clock,
  Tag,
  Star,
  Mail,
  Reply as ReplyIcon,
  ReplyAll,
  Forward,
  Paperclip,
  Download,
  Sun,
  Moon,
  ImageOff,
  Clock3,
  XCircle,
  Sparkles,
  MessageSquareText,
  X as XIcon,
  Eye,
  MailX,
  ChevronDown,
} from "lucide-react";
import type { MessageRow, AttachmentRow } from "@email/shared";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  useMessage,
  useFlag,
  useMarkRead,
  useSnooze,
  useSoftDelete,
  useSettings,
  useSummarize,
  useSmartReply,
  useMessageHeaderDetails,
} from "@/api/hooks";
import { api, ApiError } from "@/api/client";
import { useUI } from "@/lib/store";
import { Avatar, IconButton, Tip, Spinner } from "@/components/primitives";
import { SnoozeMenu } from "@/components/SnoozeMenu";
import { LabelMenu } from "@/components/LabelMenu";
import { ReplyComposer } from "@/components/ReplyComposer";
import { AttachmentLightbox, isPreviewable } from "@/components/AttachmentLightbox";
import { useShortcuts } from "@/lib/useShortcuts";
import { renderEmailHtml } from "@/lib/sanitize";
import { splitQuotedHtml, splitQuotedText } from "@/lib/quotes";
import { forwardHtml, quoteHtml } from "@/lib/compose-html";
import { formatFullDate, formatBytes, displayName, cn } from "@/lib/utils";

// Remember which individual messages the user chose to load images for (persists
// the "just this email" choice across reloads, distinct from the per-sender allowlist).
const IMG_KEY = "aria-img-loaded";
function loadedImageSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(IMG_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function rememberImageLoaded(id: string) {
  const s = loadedImageSet();
  s.add(id);
  try {
    localStorage.setItem(IMG_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

export function MailDetail() {
  const { id } = useParams({ from: "/shell/mailLayout/mail/$id" });
  const navigate = useNavigate();
  const { data, isLoading, error } = useMessage(id);
  const flag = useFlag();
  const markRead = useMarkRead();
  const snooze = useSnooze();
  const del = useSoftDelete();
  const { emailTheme, toggleEmailTheme, openCompose } = useUI();
  const settings = useSettings();
  const replyOn = !!settings.data?.reply_enabled;
  const composeOn = settings.data?.compose_enabled ?? true;
  const summarize = useSummarize();
  const smartReply = useSmartReply();
  const inbound = data?.message.direction === "in";
  const unsub = useQuery({
    queryKey: ["unsub", id],
    queryFn: () => api.unsubscribeInfo(id),
    enabled: inbound,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const hasUnsub = !!(unsub.data && (unsub.data.http || unsub.data.mailto));
  async function onUnsubscribe() {
    const u = unsub.data;
    if (!u) return;
    if (u.oneClick && u.http) {
      try {
        await api.unsubscribeOneClick(id);
        toast.success("Unsubscribed");
      } catch {
        toast.error("Couldn't auto-unsubscribe — opening link");
        window.open(u.http, "_blank", "noopener");
      }
    } else if (u.http) {
      window.open(u.http, "_blank", "noopener");
    } else if (u.mailto) {
      window.location.href = u.mailto;
    }
  }
  const [summary, setSummary] = useState<string | null>(null);
  const [replies, setReplies] = useState<string[] | null>(null);
  const [replying, setReplying] = useState(false);

  function aiError(e: unknown, fallback: string) {
    toast.error(e instanceof ApiError && e.status === 503 ? "AI not set up yet" : fallback);
  }
  function onSummarize() {
    setSummary(null);
    summarize.mutate(id, {
      onSuccess: (d) => setSummary(d.summary),
      onError: (e) => aiError(e, "Couldn't summarize"),
    });
  }
  function onSmartReply() {
    setReplies(null);
    smartReply.mutate(id, {
      onSuccess: (d) => setReplies(d.replies),
      onError: (e) => aiError(e, "Couldn't draft replies"),
    });
  }
  useEffect(() => {
    setSummary(null);
    setReplies(null);
  }, [id]);

  function back() {
    navigate({ to: "/" });
  }

  useShortcuts({
    Escape: back,
    e: () => {
      if (!data) return;
      flag.mutate({ ids: [id], field: "is_archived", value: 1 });
      toast.success("Archived");
      back();
    },
    "#": () => {
      if (!data) return;
      del.mutate(id);
      toast.success("Moved to trash");
      back();
    },
    r: () => data && setReplying(true),
    s: () => data && flag.mutate({ ids: [id], field: "is_starred", value: data.message.is_starred ? 0 : 1 }),
  });

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="text-accent" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <p>Message not found.</p>
      </div>
    );
  }

  const { message, thread, attachments, labels } = data;
  const last = thread[thread.length - 1] ?? message;
  const replyPeer = message.direction === "out" ? message.to_addr : message.from_addr;

  /** The message being answered, folded under the reply. Gmail's markup, so
   *  every client (and Driftmail) collapses it. */
  function quotedOriginal(): string {
    const name = displayName(message.from_name, message.from_addr);
    return quoteHtml({
      date: formatFullDate(message.received_at),
      from: name && name !== message.from_addr ? `${name} <${message.from_addr}>` : message.from_addr,
      html: message.html,
      text: message.text,
    });
  }

  function onForward() {
    if (!composeOn) return toast.error("Compose is disabled in Settings");
    const atts = (attachments[message.id] ?? []).map((a) => ({
      key: a.r2_key,
      filename: a.filename ?? "file",
      mime_type: a.mime_type ?? "application/octet-stream",
      size_bytes: a.size_bytes ?? 0,
    }));
    const subj = message.subject ?? "";
    openCompose({
      subject: /^fwd:/i.test(subj) ? subj : `Fwd: ${subj}`,
      quotedHtml: forwardHtml({
        date: formatFullDate(message.received_at),
        from: message.from_name ? `${message.from_name} <${message.from_addr}>` : message.from_addr,
        to: message.to_addr,
        subject: subj,
        html: message.html,
        text: message.text,
      }),
      attachments: atts,
    });
  }

  function onReplyAll() {
    if (!composeOn) return toast.error("Compose is disabled in Settings");
    const ourAlias = (message.direction === "in" ? message.to_addr : message.from_addr).toLowerCase();
    const cc = [message.to_addr, message.cc]
      .filter(Boolean)
      .join(",")
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((a) => {
        const lo = a.toLowerCase();
        return lo !== ourAlias && lo !== replyPeer.toLowerCase();
      });
    const subj = message.subject ?? "";
    openCompose({
      to: [replyPeer],
      cc,
      subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`,
      quotedHtml: quotedOriginal(),
      inReplyToMessageId: message.id,
    });
  }

  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className="flex h-full flex-col"
    >
      {/* toolbar */}
      <header className="flex items-center gap-1 border-b border-border px-3 py-2.5">
        <IconButton className="md:hidden" onClick={back} aria-label="Back">
          <ArrowLeft size={18} />
        </IconButton>
        <Tip label="Archive">
          <IconButton
            onClick={() => {
              flag.mutate({ ids: [id], field: "is_archived", value: 1 });
              toast.success("Archived");
              back();
            }}
          >
            <Archive size={18} />
          </IconButton>
        </Tip>
        <Tip label="Trash">
          <IconButton
            onClick={() => {
              del.mutate(id);
              toast.success("Moved to trash");
              back();
            }}
          >
            <Trash2 size={18} />
          </IconButton>
        </Tip>
        <SnoozeMenu
          showUnsnooze={!!message.snooze_until}
          onPick={(until) => {
            snooze.mutate({ ids: [id], until });
            toast.success(until ? "Snoozed" : "Unsnoozed");
            if (until) back();
          }}
        >
          <Tip label="Snooze">
            <IconButton aria-label="Snooze">
              <Clock size={18} />
            </IconButton>
          </Tip>
        </SnoozeMenu>
        <LabelMenu messageId={id} applied={labels}>
          <IconButton aria-label="Label">
            <Tag size={18} />
          </IconButton>
        </LabelMenu>
        <Tip label="Mark unread">
          <IconButton
            onClick={() => {
              markRead.mutate({ id, read: false });
              toast.success("Marked unread");
              back();
            }}
          >
            <Mail size={18} />
          </IconButton>
        </Tip>

        {hasUnsub && (
          <Tip label="Unsubscribe">
            <IconButton onClick={onUnsubscribe} aria-label="Unsubscribe">
              <MailX size={18} />
            </IconButton>
          </Tip>
        )}

        <Tip label="Summarize">
          <IconButton onClick={onSummarize} aria-label="Summarize" active={summarize.isPending}>
            {summarize.isPending ? <Spinner /> : <Sparkles size={18} />}
          </IconButton>
        </Tip>
        {composeOn && (
          <>
            <Tip label="Reply all">
              <IconButton onClick={onReplyAll} aria-label="Reply all">
                <ReplyAll size={18} />
              </IconButton>
            </Tip>
            <Tip label="Forward">
              <IconButton onClick={onForward} aria-label="Forward">
                <Forward size={18} />
              </IconButton>
            </Tip>
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Tip label={emailTheme === "dark" ? "Light email" : "Dark email"}>
            <IconButton onClick={toggleEmailTheme} aria-label="Toggle email theme">
              {emailTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </IconButton>
          </Tip>
          <IconButton
            active={!!message.is_starred}
            onClick={() => flag.mutate({ ids: [id], field: "is_starred", value: message.is_starred ? 0 : 1 })}
            aria-label="Star"
          >
            <Star size={18} className={message.is_starred ? "fill-star text-star" : ""} />
          </IconButton>
        </div>
      </header>

      {/* scroll body */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="w-full px-3 pt-3 pb-6 md:px-6 md:pt-6">
          <AnimatePresence>
            {summary && (
              <motion.div
                initial={{ opacity: 0, y: -8, height: 0 }}
                animate={{ opacity: 1, y: 0, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-5 overflow-hidden"
              >
                <div className="rounded-2xl border border-accent-ring/40 bg-accent-soft/60 p-4">
                  <div className="mb-1.5 flex items-center gap-2 text-accent">
                    <Sparkles size={15} />
                    <span className="text-xs font-semibold uppercase tracking-wider">Summary</span>
                    <button
                      onClick={() => setSummary(null)}
                      className="ml-auto text-faint hover:text-fg"
                      aria-label="Dismiss summary"
                    >
                      <XIcon size={14} />
                    </button>
                  </div>
                  <p className="text-[14px] leading-relaxed text-fg">{summary}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mb-1 flex flex-wrap items-center gap-2">
            {labels.map((l) => (
              <span
                key={l.id}
                className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ background: `${l.color}22`, color: l.color }}
              >
                {l.name}
              </span>
            ))}
          </div>
          <h1 className="mb-5 font-display text-[1.1rem] font-semibold leading-tight tracking-tight text-balance md:text-[1.7rem]">
            {message.subject || "(no subject)"}
          </h1>

          <div className="space-y-3">
            {thread.map((m, i) => (
              <ThreadMessage
                key={m.id}
                m={m}
                attachments={attachments[m.id] ?? []}
                defaultOpen={i === thread.length - 1}
                collapsible={thread.length > 1}
              />
            ))}
          </div>
        </div>
      </div>

      {/* reply — hidden entirely when both reply and compose are off */}
      {(replyOn || composeOn) && (
      <div className="border-t border-border bg-surface">
        <AnimatePresence mode="wait">
          {replying ? (
            <ReplyComposer
              key="composer"
              messageId={message.id}
              to={replyPeer}
              subject={last.subject ?? message.subject ?? ""}
              quotedHtml={quotedOriginal()}
              onClose={() => setReplying(false)}
            />
          ) : (
            <motion.div
              key="cta"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="px-5 py-3 md:px-8"
            >
              {composeOn && replies && replies.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {replies.map((r, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        const subj = message.subject ?? "";
                        openCompose({
                          to: [replyPeer],
                          subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`,
                          text: r,
                          inReplyToMessageId: message.id,
                        });
                      }}
                      className="max-w-full truncate rounded-full border border-accent-ring/50 bg-accent-soft/50 px-3 py-1.5 text-left text-[13px] text-fg transition hover:bg-accent-soft"
                      title={r}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                {replyOn && (
                  <button
                    onClick={() => setReplying(true)}
                    className="flex flex-1 items-center gap-2.5 rounded-full border border-border bg-bg px-4 py-2.5 text-sm text-muted transition hover:border-accent-ring hover:text-fg"
                  >
                    <ReplyIcon size={16} />
                    Reply to {displayName(message.from_name, replyPeer)}…
                  </button>
                )}
                {composeOn && (
                  <button
                    onClick={onSmartReply}
                    disabled={smartReply.isPending}
                    className="flex items-center gap-1.5 rounded-full border border-border bg-bg px-3.5 py-2.5 text-sm text-muted transition hover:border-accent-ring hover:text-fg disabled:opacity-60"
                    title="Suggest replies"
                  >
                    {smartReply.isPending ? <Spinner /> : <MessageSquareText size={16} />}
                    <span className="hidden sm:inline">Suggest</span>
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      )}
    </motion.div>
  );
}

function ThreadMessage({
  m,
  attachments,
  defaultOpen,
  collapsible = true,
}: {
  m: MessageRow;
  attachments: AttachmentRow[];
  defaultOpen: boolean;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showDetails, setDetails] = useState(false);
  const [loadImages, setLoadImages] = useState(() => loadedImageSet().has(m.id));
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const previewable = attachments.filter(isPreviewable);
  const emailTheme = useUI((s) => s.emailTheme);
  const settings = useSettings();
  const qc = useQueryClient();
  const outbound = m.direction === "out";
  const peer = outbound ? m.to_addr : m.from_addr;
  const sender = m.from_addr.toLowerCase();
  const isOpen = collapsible ? open : true;

  const allowed = settings.data?.image_allowlist?.includes(sender) ?? false;
  const blockSetting = settings.data?.block_remote_images ?? true;
  const blocking = blockSetting && !allowed && !loadImages;
  const { html, blocked } = renderEmailHtml(m.html, m.id, { blockRemote: blocking });
  // Quoted history folds behind "•••", as in Gmail.
  const [showQuoted, setShowQuoted] = useState(false);
  const body = useMemo(
    () => (html ? splitQuotedHtml(html) : splitQuotedText(m.text ?? "")),
    [html, m.text],
  );

  // Scheduled vs in-flight send state for outbound rows.
  const scheduled = m.send_state === "pending" && !!m.send_after && m.send_after > Date.now();

  async function allowSender() {
    await api.setSettings({ allow_image_sender: sender });
    qc.invalidateQueries({ queryKey: ["settings"] });
  }
  function cancelScheduled() {
    api.cancelSend(m.id).then(() => {
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["message"] });
      qc.invalidateQueries({ queryKey: ["counts"] });
      toast.message("Scheduled send cancelled");
    });
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-elevated">
      {/* A div rather than a button: the details toggle below is itself a
          button, and buttons can't nest. Keeps the whole row as the collapse
          target when this message is part of a thread. */}
      <div
        onClick={() => collapsible && setOpen((o) => !o)}
        role={collapsible ? "button" : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? isOpen : undefined}
        onKeyDown={(e) => {
          if (!collapsible) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3.5 text-left",
          collapsible && "cursor-pointer",
        )}
      >
        <Avatar name={m.from_name} email={peer} size={38} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">
              {outbound ? "You" : displayName(m.from_name, m.from_addr)}
            </span>
            {scheduled ? (
              <span className="flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                <Clock3 size={11} /> Scheduled · {formatFullDate(m.send_after!)}
              </span>
            ) : m.send_state === "pending" ? (
              <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                sending…
              </span>
            ) : null}
            <span className="ml-auto shrink-0 text-[11px] text-faint">{formatFullDate(m.received_at)}</span>
          </div>

          {/* The whole address line toggles the details panel, not just the
              caret — the text is the obvious thing to click. stopPropagation
              keeps it from also collapsing the message in a thread. */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setDetails((d) => !d);
            }}
            aria-label={showDetails ? "Hide details" : "Show details"}
            aria-expanded={showDetails}
            className="group/details -mx-1 flex min-w-0 max-w-full items-center gap-1 rounded px-1 text-left transition hover:bg-surface"
          >
            <span className="truncate text-xs text-muted">
              {outbound ? (
                `to ${m.to_addr}`
              ) : (
                <>
                  {m.from_addr}
                  <span className="text-faint"> · to {m.to_addr}</span>
                </>
              )}
            </span>
            <ChevronDown
              size={13}
              className={cn(
                "shrink-0 text-faint transition-transform group-hover/details:text-fg",
                showDetails && "rotate-180",
              )}
            />
          </button>

          <AnimatePresence initial={false}>
            {showDetails && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.16 }}
                className="overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                <MessageDetailsPanel message={m} enabled={showDetails} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {scheduled && (
        <div className="flex items-center gap-2 border-t border-border bg-accent-soft/40 px-4 py-2 text-xs">
          <Clock3 size={14} className="text-accent" />
          <span className="text-muted">Sends {formatFullDate(m.send_after!)}</span>
          <button
            onClick={cancelScheduled}
            className="ml-auto flex items-center gap-1 font-medium text-danger hover:underline"
          >
            <XCircle size={13} /> Cancel
          </button>
        </div>
      )}

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="border-t border-border p-3 md:p-4">
              {blocked > 0 && blocking && (
                <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-inset px-3 py-2 text-xs">
                  <span className="flex items-center gap-1.5 text-muted">
                    <ImageOff size={14} />
                    {blocked} remote image{blocked > 1 ? "s" : ""} blocked
                  </span>
                  <button
                    onClick={() => {
                      rememberImageLoaded(m.id);
                      setLoadImages(true);
                    }}
                    className="font-medium text-accent hover:underline"
                  >
                    Show in this email
                  </button>
                  <button onClick={allowSender} className="font-medium text-accent hover:underline">
                    Always allow {sender}
                  </button>
                </div>
              )}
              <div
                className={`email-surface overflow-x-auto rounded-xl${
                  emailTheme === "dark" ? " is-dark" : ""
                }`}
              >
                {/* w-fit + min-w-full centers narrow emails and lets wide ones expand + scroll */}
                <div className="mx-auto w-fit min-w-full px-4 py-4">
                  {html ? (
                    <div className="email-html text-[14px]" dangerouslySetInnerHTML={{ __html: body.main }} />
                  ) : (
                    <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-inherit">
                      {body.main}
                    </pre>
                  )}
                  {body.quoted && (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowQuoted((v) => !v)}
                        title={showQuoted ? "Hide quoted text" : "Show quoted text"}
                        aria-expanded={showQuoted}
                        className="mt-3 inline-flex h-5 items-center rounded-md border border-black/15 bg-black/5 px-2 text-[13px] font-semibold leading-none tracking-[0.2em] text-[#555] transition hover:bg-black/10"
                      >
                        •••
                      </button>
                      {showQuoted &&
                        (html ? (
                          <div
                            className="email-html mt-3 text-[14px]"
                            dangerouslySetInnerHTML={{ __html: body.quoted }}
                          />
                        ) : (
                          <pre className="mt-3 whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-[#555]">
                            {body.quoted}
                          </pre>
                        ))}
                    </>
                  )}
                </div>
              </div>

              {attachments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {attachments.map((a) => {
                    const pIdx = previewable.indexOf(a);
                    return (
                      <AttachmentPill
                        key={a.id}
                        a={a}
                        onPreview={pIdx >= 0 ? () => setPreviewIdx(pIdx) : undefined}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AttachmentLightbox
        items={previewable}
        index={previewIdx}
        onIndex={setPreviewIdx}
        onClose={() => setPreviewIdx(null)}
      />
    </div>
  );
}

/**
 * Gmail-style "details" panel: the full envelope for one message.
 *
 * from / to / cc / date come straight off the row; mailed-by and signed-by are
 * derived from the raw .eml's auth headers, which is an R2 read plus a MIME
 * parse — so that request only fires once the panel has been opened.
 */
function MessageDetailsPanel({ message, enabled }: { message: MessageRow; enabled: boolean }) {
  const details = useMessageHeaderDetails(message.id, enabled);

  const rows: Array<[string, string | null]> = [
    ["from", message.from_name ? `${message.from_name} <${message.from_addr}>` : message.from_addr],
    ["reply-to", details.data?.replyTo ?? null],
    ["to", message.to_addr],
    ["cc", message.cc],
    ["bcc", message.bcc],
    ["date", formatFullDate(message.received_at)],
    ["mailed-by", details.data?.mailedBy ?? null],
    ["signed-by", details.data?.signedBy ?? null],
  ];

  return (
    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xl border border-border bg-surface/60 px-3 py-2 text-xs">
      {rows.map(([label, value]) =>
        value ? (
          <div key={label} className="contents">
            <dt className="whitespace-nowrap text-right text-faint">{label}:</dt>
            <dd className="min-w-0 break-words text-muted">{value}</dd>
          </div>
        ) : null,
      )}
      {details.isPending && (
        <div className="contents">
          <dt className="whitespace-nowrap text-right text-faint">security:</dt>
          <dd className="min-w-0 text-faint">checking…</dd>
        </div>
      )}
      {details.isSuccess && !details.data?.mailedBy && !details.data?.signedBy && (
        <div className="contents">
          <dt className="whitespace-nowrap text-right text-faint">security:</dt>
          <dd className="min-w-0 text-faint">no SPF/DKIM results on this message</dd>
        </div>
      )}
    </dl>
  );
}

function AttachmentPill({ a, onPreview }: { a: AttachmentRow; onPreview?: () => void }) {
  const inner = (
    <>
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-inset text-muted">
        {onPreview ? <Eye size={16} /> : <Paperclip size={16} />}
      </span>
      <span className="min-w-0">
        <span className="block max-w-44 truncate text-[13px] font-medium">{a.filename ?? "attachment"}</span>
        <span className="text-[11px] text-faint">{formatBytes(a.size_bytes)}</span>
      </span>
    </>
  );
  const cls =
    "group flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 text-left transition hover:border-accent-ring";

  // previewable → open lightbox; otherwise plain download link
  if (onPreview) {
    return (
      <button onClick={onPreview} className={cls}>
        {inner}
        <Eye size={15} className="ml-1 text-faint opacity-0 transition group-hover:opacity-100" />
      </button>
    );
  }
  return (
    <a href={`/api/attachments/${a.r2_key}`} target="_blank" rel="noreferrer" className={cls}>
      {inner}
      <Download size={15} className="ml-1 text-faint opacity-0 transition group-hover:opacity-100" />
    </a>
  );
}

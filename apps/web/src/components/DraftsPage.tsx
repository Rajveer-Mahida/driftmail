import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, FileText, Trash2 } from "lucide-react";
import type { DraftRow, UploadedAttachment } from "@email/shared";
import { useDrafts, useDeleteDraft } from "@/api/hooks";
import { useUI } from "@/lib/store";
import { IconButton, Spinner } from "@/components/primitives";
import { formatRelativeTime } from "@/lib/utils";

const split = (s: string | null) =>
  (s ?? "").split(/[,;]+/).map((x) => x.trim()).filter(Boolean);

export function DraftsPage() {
  const navigate = useNavigate();
  const drafts = useDrafts();
  const del = useDeleteDraft();
  const { openCompose } = useUI();

  function edit(d: DraftRow) {
    let attachments: UploadedAttachment[] = [];
    try {
      attachments = d.attachments ? (JSON.parse(d.attachments) as UploadedAttachment[]) : [];
    } catch {
      /* ignore */
    }
    openCompose({
      draftId: d.id,
      to: split(d.to_addr),
      cc: split(d.cc),
      bcc: split(d.bcc),
      subject: d.subject ?? "",
      text: d.text ?? "",
      html: d.html ?? undefined,
      inReplyToMessageId: d.in_reply_to_id ?? undefined,
      attachments,
    });
  }

  return (
    <div className="scroll-thin h-full min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8 md:px-10">
        <button
          onClick={() => navigate({ to: "/" })}
          className="mb-6 inline-flex items-center gap-2 text-sm text-muted transition hover:text-fg md:hidden"
        >
          <ArrowLeft size={16} /> Back to inbox
        </button>
        <h1 className="mb-8 font-display text-3xl font-semibold tracking-tight">Drafts</h1>

        {drafts.isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner className="text-accent" />
          </div>
        ) : (drafts.data?.length ?? 0) === 0 ? (
          <div className="grid place-items-center py-16 text-center">
            <div>
              <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-inset text-faint">
                <FileText size={28} />
              </div>
              <p className="font-display text-lg font-medium">No drafts</p>
              <p className="mt-1 text-sm text-muted">Unsent messages will appear here.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {drafts.data!.map((d) => (
                <motion.div
                  key={d.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  onClick={() => edit(d)}
                  className="group flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-elevated p-4 transition hover:border-accent-ring"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">
                        {d.to_addr || <span className="text-faint">(no recipient)</span>}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-faint">
                        {formatRelativeTime(d.updated_at)}
                      </span>
                    </div>
                    <p className="truncate text-[13px] text-muted">{d.subject || "(no subject)"}</p>
                    <p className="mt-0.5 line-clamp-1 text-[12.5px] text-faint">{d.text}</p>
                  </div>
                  <IconButton
                    onClick={(e) => {
                      e.stopPropagation();
                      del.mutate(d.id);
                    }}
                    aria-label="Delete draft"
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}

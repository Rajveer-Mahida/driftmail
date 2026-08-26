import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Archive, Trash2, MailOpen, Mail, Clock, X, Trash } from "lucide-react";
import { toast } from "sonner";
import { useUI } from "@/lib/store";
import { useFlag, useSnooze, usePermanentDelete } from "@/api/hooks";
import { ConfirmDialog, IconButton, Tip } from "@/components/primitives";
import { SnoozeMenu } from "@/components/SnoozeMenu";

export function BulkBar() {
  const { selection, clearSelection, view } = useUI();
  const flag = useFlag();
  const snooze = useSnooze();
  const permaDelete = usePermanentDelete();

  const ids = [...selection];
  const count = ids.length;
  const [confirmDelete, setConfirmDelete] = useState(false);

  function act(field: "is_archived" | "is_deleted" | "is_read", value: 0 | 1, label: string) {
    flag.mutate({ ids, field, value });
    if (field !== "is_read") clearSelection();
    toast.success(label);
  }

  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className="overflow-hidden border-b border-border bg-accent-soft/50"
        >
          <div className="flex items-center gap-1 px-3 py-2">
            <IconButton onClick={clearSelection} aria-label="Clear selection">
              <X size={18} />
            </IconButton>
            <span className="mr-1 text-sm font-semibold tabular-nums">{count}</span>

            <div className="ml-auto flex items-center gap-0.5">
              <Tip label="Mark read">
                <IconButton onClick={() => act("is_read", 1, "Marked read")}>
                  <MailOpen size={17} />
                </IconButton>
              </Tip>
              <Tip label="Mark unread">
                <IconButton onClick={() => act("is_read", 0, "Marked unread")}>
                  <Mail size={17} />
                </IconButton>
              </Tip>
              <SnoozeMenu
                onPick={(until) => {
                  snooze.mutate({ ids, until });
                  clearSelection();
                  toast.success("Snoozed");
                }}
              >
                <IconButton aria-label="Snooze">
                  <Clock size={17} />
                </IconButton>
              </SnoozeMenu>
              {view !== "trash" && (
                <Tip label="Archive">
                  <IconButton onClick={() => act("is_archived", 1, "Archived")}>
                    <Archive size={17} />
                  </IconButton>
                </Tip>
              )}
              {view === "trash" ? (
                <Tip label="Delete forever">
                  {/* The one unrecoverable action in the mail UI — everything
                      else here is a flag flip that trash can undo. */}
                  <IconButton onClick={() => setConfirmDelete(true)}>
                    <Trash size={17} className="text-danger" />
                  </IconButton>
                </Tip>
              ) : (
                <Tip label="Trash">
                  <IconButton onClick={() => act("is_deleted", 1, "Moved to trash")}>
                    <Trash2 size={17} />
                  </IconButton>
                </Tip>
              )}
            </div>
          </div>
        </motion.div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${count} message${count === 1 ? "" : "s"} forever?`}
        description="They're removed permanently, along with their attachments. This is the one action here that can't be undone."
        confirmLabel={`Delete ${count} forever`}
        onConfirm={() => {
          permaDelete.mutate(ids);
          clearSelection();
          setConfirmDelete(false);
          toast.success("Deleted forever");
        }}
      />
    </AnimatePresence>
  );
}

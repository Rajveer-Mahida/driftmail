import { useNavigate } from "@tanstack/react-router";
import { motion, useMotionValue, useTransform } from "framer-motion";
import { Star, Archive, Check } from "lucide-react";
import type { MessageListItem } from "@email/shared";
import { useUI } from "@/lib/store";
import { useFlag, useMarkRead } from "@/api/hooks";
import { Avatar } from "@/components/primitives";
import { cn, formatRelativeTime, displayName } from "@/lib/utils";

export function MessageRow({
  message: m,
  active,
  focused,
}: {
  message: MessageListItem;
  active: boolean;
  focused?: boolean;
}) {
  const navigate = useNavigate();
  const { selection, toggleSelect, view } = useUI();
  const flag = useFlag();
  const markRead = useMarkRead();

  const selected = selection.has(m.id);
  const unread = (m.thread_unread > 0 || m.is_read === 0) && m.direction === "in";
  const selectMode = selection.size > 0;

  const x = useMotionValue(0);
  const archiveOpacity = useTransform(x, [-90, -30], [1, 0]);

  const peer = m.direction === "out" ? m.to_addr : m.from_addr;
  const peerName = m.direction === "out" ? `To: ${displayName(m.from_name, m.to_addr)}` : displayName(m.from_name, m.from_addr);

  function open() {
    if (selectMode) {
      toggleSelect(m.id);
      return;
    }
    if (unread) markRead.mutate({ id: m.id, read: true });
    navigate({ to: "/mail/$id", params: { id: m.id } });
  }

  function onDragEnd(_: unknown, info: { offset: { x: number } }) {
    if (info.offset.x < -80 && view !== "trash") {
      flag.mutate({ ids: [m.id], field: "is_archived", value: 1 });
    }
    x.set(0);
  }

  return (
    <div className="relative">
      {/* swipe-reveal background */}
      <motion.div
        style={{ opacity: archiveOpacity }}
        className="pointer-events-none absolute inset-y-1 right-0 flex w-24 items-center justify-end rounded-r-xl bg-accent-soft pr-5 text-accent"
      >
        <Archive size={18} />
      </motion.div>

      <motion.div
        drag={selectMode || view === "trash" ? false : "x"}
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0.6, right: 0 }}
        style={{ x }}
        onDragEnd={onDragEnd}
        onClick={open}
        data-row={m.id}
        className={cn(
          "group relative flex cursor-pointer items-start gap-3 rounded-xl border border-transparent bg-surface px-3 py-3 transition-colors",
          active ? "border-border-strong bg-inset" : "hover:bg-inset/70",
          focused && !active && "ring-2 ring-accent-ring/70",
        )}
      >
        {active && (
          <motion.span
            layoutId="row-active-rail"
            className="absolute -left-2 top-1/2 h-7 w-1 -translate-y-1/2 rounded-full bg-accent"
          />
        )}

        {/* checkbox slides in beside the avatar (hover or while selecting) */}
        <div className="flex shrink-0 items-center">
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleSelect(m.id);
            }}
            aria-label="Select"
            className={cn(
              "grid place-items-center overflow-hidden transition-[width,margin,opacity] duration-200 ease-out",
              selected || selectMode
                ? "w-7 mr-2 opacity-100"
                : "w-0 opacity-0 group-hover:w-7 group-hover:mr-2 group-hover:opacity-100",
            )}
          >
            <span
              className={cn(
                "grid h-5 w-5 place-items-center rounded-md border transition-all duration-150 active:scale-90",
                selected
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border-strong text-transparent hover:border-accent",
              )}
            >
              <Check size={13} strokeWidth={3} />
            </span>
          </button>
          <Avatar name={m.from_name} email={peer} size={40} />
        </div>

        {/* content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "truncate text-[14px]",
                unread ? "font-semibold text-fg" : "font-medium text-muted",
              )}
            >
              {peerName}
            </span>
            {m.thread_count > 1 && (
              <span className="shrink-0 text-[12px] tabular-nums text-faint">
                ({m.thread_count})
              </span>
            )}
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-faint">
              {formatRelativeTime(m.received_at)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className={cn("truncate text-[13px]", unread ? "font-medium text-fg" : "text-muted")}>
              {m.subject || "(no subject)"}
            </span>
            {unread && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-accent" />}
          </div>
          <p className="mt-0.5 truncate text-[12.5px] text-faint">{m.snippet}</p>

          {m.labels.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {m.labels.map((l) => (
                <span
                  key={l.id}
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ background: `${l.color}22`, color: l.color }}
                >
                  {l.name}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* star */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            flag.mutate({ ids: [m.id], field: "is_starred", value: m.is_starred ? 0 : 1 });
          }}
          className="shrink-0 self-center p-1 text-faint transition-colors hover:text-star"
          aria-label={m.is_starred ? "Unstar" : "Star"}
        >
          <Star
            size={17}
            className={cn("transition-transform active:scale-125", m.is_starred && "fill-star text-star")}
          />
        </button>
      </motion.div>
    </div>
  );
}

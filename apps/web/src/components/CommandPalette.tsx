import { useState } from "react";
import { Command } from "cmdk";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  Inbox,
  Star,
  Clock,
  Send,
  Archive,
  Trash2,
  AtSign,
  FileText,
  Settings,
  PenLine,
  Sparkles,
  Search,
  Tag,
  Moon,
  Sun,
} from "lucide-react";
import type { ViewName } from "@email/shared";
import { useUI } from "@/lib/store";
import { useCounts, useSettings } from "@/api/hooks";
import { api } from "@/api/client";
import { randomAlias } from "@/lib/alias";

const VIEWS: { view: ViewName; label: string; icon: typeof Inbox }[] = [
  { view: "inbox", label: "Inbox", icon: Inbox },
  { view: "starred", label: "Starred", icon: Star },
  { view: "snoozed", label: "Snoozed", icon: Clock },
  { view: "sent", label: "Sent", icon: Send },
  { view: "archived", label: "Archive", icon: Archive },
  { view: "trash", label: "Trash", icon: Trash2 },
];

export function CommandPalette() {
  const navigate = useNavigate();
  const { paletteOpen, setPalette, setFilter, openCompose, toggleTheme, theme } = useUI();
  const counts = useCounts();
  const settings = useSettings();
  const [search, setSearch] = useState("");

  const close = () => {
    setPalette(false);
    setSearch("");
  };

  function goView(v: ViewName) {
    setFilter({ view: v, labelId: null, q: "" });
    navigate({ to: "/" });
    close();
  }
  function goPath(to: string) {
    navigate({ to });
    close();
  }
  function runSearch() {
    setFilter({ view: "inbox", labelId: null, q: search });
    navigate({ to: "/" });
    close();
  }
  async function newAlias() {
    const domain = settings.data?.primary_domain;
    if (!domain) {
      toast.error("No mail domain yet", { description: "Add one in Settings → Domains." });
      close();
      return;
    }
    const alias = randomAlias(domain, settings.data?.user.handle ?? "");
    api.createAlias({ address: alias }).catch(() => {});
    try {
      await navigator.clipboard.writeText(alias);
      toast.success("Alias copied", { description: alias });
    } catch {
      toast.message(alias);
    }
    close();
  }

  return (
    <AnimatePresence>
      {paletteOpen && (
        <div className="fixed inset-0 z-[60]">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
          />
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="absolute left-1/2 top-[12vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-border-strong bg-elevated shadow-[var(--shadow-lg)]"
          >
            <Command
              loop
              label="Command menu"
              onKeyDown={(e) => e.key === "Escape" && close()}
            >
              <div className="flex items-center gap-2 border-b border-border px-4">
                <Search size={17} className="text-faint" />
                <Command.Input
                  autoFocus
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Type a command or search…"
                  className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
                />
              </div>
              <Command.List className="scroll-thin max-h-[50vh] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
                No results.
              </Command.Empty>

              {search.trim() && (
                <Command.Group heading="Search">
                  <Item onSelect={runSearch} icon={<Search size={16} />}>
                    Search mail for “{search.trim()}”
                  </Item>
                </Command.Group>
              )}

              <Command.Group heading="Actions">
                {(settings.data?.compose_enabled ?? true) && (
                  <Item onSelect={() => { openCompose(); close(); }} icon={<PenLine size={16} />}>
                    Compose
                  </Item>
                )}
                <Item onSelect={newAlias} icon={<Sparkles size={16} />}>
                  New alias
                </Item>
                <Item onSelect={() => { toggleTheme(); close(); }} icon={theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}>
                  Toggle {theme === "dark" ? "light" : "dark"} mode
                </Item>
              </Command.Group>

              <Command.Group heading="Go to">
                {VIEWS.map((v) => (
                  <Item key={v.view} onSelect={() => goView(v.view)} icon={<v.icon size={16} />}>
                    {v.label}
                  </Item>
                ))}
                <Item onSelect={() => goPath("/aliases")} icon={<AtSign size={16} />}>Aliases</Item>
                <Item onSelect={() => goPath("/drafts")} icon={<FileText size={16} />}>Drafts</Item>
                <Item onSelect={() => goPath("/settings")} icon={<Settings size={16} />}>Settings</Item>
              </Command.Group>

              {(counts.data?.labels.length ?? 0) > 0 && (
                <Command.Group heading="Labels">
                  {counts.data!.labels.map((l) => (
                    <Item
                      key={l.id}
                      onSelect={() => {
                        setFilter({ labelId: l.id, q: "" });
                        navigate({ to: "/" });
                        close();
                      }}
                      icon={<Tag size={16} style={{ color: l.color }} />}
                    >
                      {l.name}
                    </Item>
                  ))}
                </Command.Group>
              )}
              </Command.List>
            </Command>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function Item({
  children,
  onSelect,
  icon,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  icon: React.ReactNode;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none data-[selected=true]:bg-inset"
    >
      <span className="text-muted">{icon}</span>
      {children}
    </Command.Item>
  );
}

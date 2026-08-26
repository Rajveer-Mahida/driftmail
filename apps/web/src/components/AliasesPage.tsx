import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import * as Switch from "@radix-ui/react-switch";
import { toast } from "sonner";
import { ArrowLeft, AtSign, Copy, Inbox, Trash2, Sparkles, Plus, Check, Ban } from "lucide-react";
import type { AliasWithCount } from "@email/shared";
import { useAliases, useCreateAlias, useUpdateAlias, useDeleteAlias, useSettings } from "@/api/hooks";
import { useUI } from "@/lib/store";
import { randomLocal } from "@/lib/alias";
import { Button, IconButton, Spinner } from "@/components/primitives";
import { cn } from "@/lib/utils";

export function AliasesPage() {
  const navigate = useNavigate();
  const aliases = useAliases();
  const create = useCreateAlias();
  const del = useDeleteAlias();
  const update = useUpdateAlias();
  const settings = useSettings();
  const { setAliasFilter } = useUI();

  const list = aliases.data ?? [];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allSelected = list.length > 0 && selected.size === list.length;
  function toggleSel(addr: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(addr) ? n.delete(addr) : n.add(addr);
      return n;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(list.map((a) => a.address)));
  }
  async function bulkDelete() {
    const addrs = [...selected];
    setSelected(new Set());
    await Promise.all(addrs.map((a) => del.mutateAsync(a).catch(() => {})));
    toast.success(`${addrs.length} alias${addrs.length > 1 ? "es" : ""} removed`);
  }
  async function bulkDisable() {
    const addrs = [...selected];
    setSelected(new Set());
    await Promise.all(addrs.map((a) => update.mutateAsync({ address: a, disabled: 1 }).catch(() => {})));
    toast.success(`${addrs.length} alias${addrs.length > 1 ? "es" : ""} disabled`);
  }

  const domains = settings.data?.domains ?? [];
  // Generated addresses carry the user's handle, so they route here by themselves.
  const handle = settings.data?.user.handle ?? "";
  const [name, setName] = useState("");
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState("");
  const dom = domain || settings.data?.primary_domain || domains[0] || "";

  function generate() {
    setLocal(randomLocal());
  }

  async function onCreate() {
    try {
      await create.mutateAsync({ local: local || undefined, domain: dom, name: name || undefined });
      toast.success("Alias created");
      setName("");
      setLocal("");
    } catch {
      toast.error("Could not create alias");
    }
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
        <h1 className="mb-1 font-display text-3xl font-semibold tracking-tight">Aliases</h1>
        <p className="mb-6 text-sm text-muted">Disposable addresses that all land in this inbox.</p>

        {/* Create */}
        <div className="mb-6 rounded-2xl border border-border bg-elevated p-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Label (e.g. Netflix)"
              className="rounded-[var(--radius-lg)] border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent-ring"
            />
            <div className="flex items-center gap-1 rounded-[var(--radius-lg)] border border-border bg-bg px-3 py-2 text-sm">
              <input
                value={local}
                onChange={(e) => setLocal(e.target.value.toLowerCase())}
                placeholder="custom"
                className="min-w-0 flex-1 bg-transparent outline-none"
              />
              <span className="shrink-0 font-mono text-xs text-faint">
                {handle ? `.${handle}@` : "@"}
              </span>
              <select
                value={dom}
                onChange={(e) => setDomain(e.target.value)}
                className="shrink-0 bg-transparent font-mono text-xs text-muted outline-none"
              >
                {domains.map((d: string) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="soft" size="sm" onClick={generate}>
              <Sparkles size={15} /> Generate
            </Button>
            <Button variant="primary" size="sm" onClick={onCreate} disabled={create.isPending}>
              {create.isPending ? <Spinner /> : <Plus size={15} />} Create alias
            </Button>
          </div>
        </div>

        {/* Bulk action bar */}
        <AnimatePresence>
          {selected.size > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -8, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -8, height: 0 }}
              className="sticky top-0 z-10 mb-3 overflow-hidden"
            >
              <div className="flex items-center gap-2 rounded-2xl border border-accent-ring/40 bg-accent-soft/70 px-3 py-2 backdrop-blur">
                <span className="text-sm font-medium">{selected.size} selected</span>
                <button onClick={toggleAll} className="text-xs text-muted hover:text-fg">
                  {allSelected ? "Clear" : "Select all"}
                </button>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button variant="ghost" size="sm" onClick={bulkDisable}>
                    <Ban size={15} /> Disable
                  </Button>
                  <Button variant="danger" size="sm" onClick={bulkDelete}>
                    <Trash2 size={15} /> Delete
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* List */}
        {aliases.isLoading ? (
          <div className="grid place-items-center py-12">
            <Spinner className="text-accent" />
          </div>
        ) : (aliases.data?.length ?? 0) === 0 ? (
          <div className="grid place-items-center py-12 text-center text-muted">
            <div>
              <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-inset text-faint">
                <AtSign size={26} />
              </div>
              No aliases yet.
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {list.map((a) => (
                <AliasCard
                  key={a.address}
                  a={a}
                  selected={selected.has(a.address)}
                  selectMode={selected.size > 0}
                  onToggle={() => toggleSel(a.address)}
                  onView={() => {
                    setAliasFilter(a.address);
                    navigate({ to: "/" });
                  }}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}

function AliasCard({
  a,
  onView,
  selected,
  selectMode,
  onToggle,
}: {
  a: AliasWithCount;
  onView: () => void;
  selected: boolean;
  selectMode: boolean;
  onToggle: () => void;
}) {
  const update = useUpdateAlias();
  const del = useDeleteAlias();
  const [name, setName] = useState(a.name ?? "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(a.address);
      toast.success("Copied", { description: a.address });
    } catch {
      toast.message(a.address);
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      onClick={() => selectMode && onToggle()}
      className={cn(
        "group rounded-2xl border bg-elevated p-4 transition",
        selected ? "border-accent ring-1 ring-accent" : "border-border",
        selectMode && "cursor-pointer",
        a.disabled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        {/* checkbox slides in on hover or while selecting (mirrors inbox) */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-label={selected ? "Deselect alias" : "Select alias"}
          className={cn(
            "mt-0.5 grid place-items-center overflow-hidden transition-[width,margin,opacity] duration-200 ease-out",
            selected || selectMode
              ? "w-5 opacity-100"
              : "w-0 opacity-0 group-hover:w-5 group-hover:opacity-100",
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
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== (a.name ?? "") && update.mutate({ address: a.address, name: name || null })}
            placeholder="Add a label"
            className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-faint"
          />
          <button onClick={(e) => { e.stopPropagation(); copy(); }} className="mt-0.5 flex items-center gap-1.5 font-mono text-[12.5px] text-muted hover:text-fg [&:hover_svg]:opacity-100">
            <span className="truncate">{a.address}</span>
            <Copy size={12} className="shrink-0 opacity-0 transition group-hover:opacity-100" />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="rounded-full bg-inset px-2 py-0.5 text-[11px] tabular-nums text-muted">
            {a.mail_count} mail
          </span>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-xs text-muted">
          <Switch.Root
            checked={a.disabled === 0}
            onCheckedChange={(v) =>
              update.mutate(
                { address: a.address, disabled: v ? 0 : 1 },
                { onSuccess: () => toast.success(v ? "Alias active" : "Alias disabled") },
              )
            }
            className="relative h-5 w-9 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-success"
          >
            <Switch.Thumb className="block h-3.5 w-3.5 translate-x-1 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[1.15rem]" />
          </Switch.Root>
          {a.disabled ? "Disabled" : "Active"}
        </label>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={(e) => { e.stopPropagation(); onView(); }}>
          <Inbox size={15} /> View inbox
        </Button>
        <IconButton
          onClick={(e) => {
            e.stopPropagation();
            del.mutate(a.address);
            toast.success("Alias removed");
          }}
          aria-label="Delete alias"
        >
          <Trash2 size={16} />
        </IconButton>
      </div>
    </motion.div>
  );
}

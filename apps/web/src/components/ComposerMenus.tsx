import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, FileText, Plus, Trash2, Check, X } from "lucide-react";
import { api, ApiError, type MailTemplate } from "@/api/client";
import { cn } from "@/lib/utils";

const menuClass =
  "z-[60] max-h-80 min-w-56 overflow-y-auto rounded-xl border border-border bg-elevated p-1.5 shadow-[var(--shadow-lg)]";
const itemClass =
  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-inset";

export function useSenders() {
  return useQuery({ queryKey: ["compose-senders"], queryFn: api.composeSenders, staleTime: 60_000 });
}

/**
 * The From row: the addresses this user may send from, default first. Empty
 * `value` means "the default", so a draft follows the server's choice.
 * Admins also get "Other…" for any address on the instance's domains.
 */
export function FromPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const senders = useSenders();
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const list = senders.data?.addresses ?? [];
  const shown = value || senders.data?.default || "";
  const canCustom = (senders.data?.customDomains.length ?? 0) > 0;

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
      <span className="text-xs font-medium text-faint">From</span>
      {custom ? (
        <>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (draft.includes("@")) onChange(draft.trim().toLowerCase());
                setCustom(false);
              } else if (e.key === "Escape") setCustom(false);
            }}
            placeholder={`name@${senders.data?.customDomains[0] ?? "example.com"}`}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <button
            type="button"
            onClick={() => {
              if (draft.includes("@")) onChange(draft.trim().toLowerCase());
              setCustom(false);
            }}
            className="text-accent"
            aria-label="Use this address"
          >
            <Check size={15} />
          </button>
          <button type="button" onClick={() => setCustom(false)} className="text-faint hover:text-fg" aria-label="Cancel">
            <X size={15} />
          </button>
        </>
      ) : (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-sm hover:bg-inset"
            >
              <span className="truncate">{shown || (senders.isLoading ? "…" : "Choose an address")}</span>
              <ChevronDown size={13} className="shrink-0 text-faint" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={4} className={menuClass}>
              {list.map((a) => (
                <DropdownMenu.Item key={a} onSelect={() => onChange(a === senders.data?.default ? "" : a)} className={itemClass}>
                  <Check size={14} className={cn("text-accent", a !== shown && "invisible")} />
                  <span className="truncate">{a}</span>
                  {a === senders.data?.default && <span className="ml-auto text-[11px] text-faint">default</span>}
                </DropdownMenu.Item>
              ))}
              {value && !list.includes(value) && (
                <DropdownMenu.Item onSelect={() => onChange(value)} className={itemClass}>
                  <Check size={14} className="text-accent" />
                  <span className="truncate">{value}</span>
                </DropdownMenu.Item>
              )}
              {canCustom && (
                <>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item
                    onSelect={() => {
                      setDraft("");
                      setCustom(true);
                    }}
                    className={itemClass}
                  >
                    <Plus size={14} className="text-muted" /> Other address…
                  </DropdownMenu.Item>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}

/** Insert a saved template, or save the current message as one. */
export function TemplateMenu({
  onInsert,
  current,
}: {
  onInsert: (t: MailTemplate) => void;
  /** The message as it stands, for "Save as template". */
  current: () => { subject: string; html: string };
}) {
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ["templates"], queryFn: api.listTemplates });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const save = useMutation({
    mutationFn: (n: string) => api.saveTemplate({ name: n, ...current() }),
    onSuccess: (t) => {
      toast.success(`Saved template "${t.name}"`);
      qc.invalidateQueries({ queryKey: ["templates"] });
      setNaming(false);
      setName("");
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't save the template"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });

  if (naming) {
    return (
      <div className="flex items-center gap-1 rounded-md border border-border bg-bg px-1.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (name.trim()) save.mutate(name.trim());
            } else if (e.key === "Escape") setNaming(false);
          }}
          placeholder="Template name"
          className="w-32 bg-transparent py-0.5 text-xs outline-none"
        />
        <button type="button" onClick={() => name.trim() && save.mutate(name.trim())} className="text-accent" aria-label="Save template">
          <Check size={14} />
        </button>
        <button type="button" onClick={() => setNaming(false)} className="text-faint hover:text-fg" aria-label="Cancel">
          <X size={14} />
        </button>
      </div>
    );
  }

  const list = templates.data ?? [];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted transition hover:bg-inset hover:text-fg"
        >
          <FileText size={14} /> Templates <ChevronDown size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={menuClass}>
          {list.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-faint">No templates yet. Write a message, then save it here.</div>
          )}
          {list.map((t) => (
            <DropdownMenu.Item key={t.id} onSelect={() => onInsert(t)} className={cn(itemClass, "group")}>
              <FileText size={14} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{t.name}</span>
                {t.subject && <span className="block truncate text-[11px] text-faint">{t.subject}</span>}
              </span>
              <button
                type="button"
                aria-label={`Delete ${t.name}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  remove.mutate(t.id);
                }}
                className="text-faint opacity-0 transition hover:text-danger group-data-[highlighted]:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item onSelect={() => setNaming(true)} className={itemClass}>
            <Plus size={14} className="text-muted" /> Save this message as a template
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

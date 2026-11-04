import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type { MessageListItem, ViewName, FlagField } from "@email/shared";
import { api } from "./client";

const PAGE = 50;

// ── query keys ───────────────────────────────────────────────────────────────
export const qk = {
  counts: ["counts"] as const,
  labels: ["labels"] as const,
  settings: ["settings"] as const,
  messages: (view: ViewName, q: string, labelId: string | null, to: string | null) =>
    ["messages", { view, q, labelId, to }] as const,
  message: (id: string) => ["message", id] as const,
};

// ── reads ────────────────────────────────────────────────────────────────────
export function useCounts() {
  // The heartbeat for new mail: when these change, main.tsx reloads the list and
  // the open conversation (see watchForNewMail).
  return useQuery({ queryKey: qk.counts, queryFn: api.counts, refetchInterval: 15_000 });
}

export function useLabels() {
  return useQuery({ queryKey: qk.labels, queryFn: api.listLabels });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.settings });
}

export function useMessages(view: ViewName, q: string, labelId: string | null, to: string | null = null) {
  return useInfiniteQuery({
    queryKey: qk.messages(view, q, labelId, to),
    queryFn: ({ pageParam }) =>
      api.messages({ view, q, label: labelId, to, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE ? allPages.length * PAGE : undefined,
    refetchInterval: 30_000,
  });
}

export function useAliases() {
  return useQuery({ queryKey: ["aliases"], queryFn: api.listAliases });
}

export function useRules() {
  return useQuery({ queryKey: ["rules"], queryFn: api.listRules });
}

export function useCreateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createRule,
    onSettled: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

export function useUpdateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateRule(id, enabled),
    onSettled: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRule(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

export function useRunRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.runRules,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: qk.counts });
    },
  });
}

export function useCreateAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createAlias,
    onSettled: () => qc.invalidateQueries({ queryKey: ["aliases"] }),
  });
}

export function useUpdateAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.updateAlias,
    onSettled: () => qc.invalidateQueries({ queryKey: ["aliases"] }),
  });
}

export function useDeleteAlias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (address: string) => api.deleteAlias(address),
    onSettled: () => qc.invalidateQueries({ queryKey: ["aliases"] }),
  });
}

export function useMessage(id: string | undefined) {
  return useQuery({
    queryKey: qk.message(id ?? ""),
    queryFn: () => api.message(id as string),
    enabled: !!id,
    // A reply can arrive while the conversation is open. Polling pauses while
    // the tab is hidden and refetches on focus.
    refetchInterval: 15_000,
  });
}

/** mailed-by / signed-by for the details panel. Costs an R2 read and a MIME
 *  parse on the worker, so it only runs once the panel is actually opened. */
export function useMessageHeaderDetails(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["message-details", id ?? ""],
    queryFn: () => api.messageHeaderDetails(id as string),
    enabled: !!id && enabled,
    staleTime: Infinity,
  });
}

// ── cache helpers ────────────────────────────────────────────────────────────
function eachMessageList(
  qc: QueryClient,
  fn: (list: MessageListItem[]) => MessageListItem[],
) {
  qc.setQueriesData<InfiniteData<MessageListItem[]>>({ queryKey: ["messages"] }, (old) =>
    old ? { ...old, pages: old.pages.map((p) => fn(p)) } : old,
  );
}

function patchInLists(qc: QueryClient, ids: Set<string>, patch: Partial<MessageListItem>) {
  eachMessageList(qc, (list) =>
    list.map((m) => (ids.has(m.id) ? { ...m, ...patch } : m)),
  );
}

function removeFromLists(qc: QueryClient, ids: Set<string>) {
  eachMessageList(qc, (list) => list.filter((m) => !ids.has(m.id)));
}

function settle(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["messages"] });
  qc.invalidateQueries({ queryKey: qk.counts });
}

// ── mutations (optimistic) ───────────────────────────────────────────────────

/** Star / read in place; archive / delete remove from current lists. */
export function useFlag() {
  const qc = useQueryClient();
  return useMutation({
    // The list shows one row per thread, so archive/trash/read act on the whole
    // conversation — otherwise the next-latest copy resurfaces. Stars stay
    // per-message.
    mutationFn: ({ ids, field, value }: { ids: string[]; field: FlagField; value: 0 | 1 }) =>
      api.flag(ids, field, value, field !== "is_starred"),
    onMutate: async ({ ids, field, value }) => {
      await qc.cancelQueries({ queryKey: ["messages"] });
      const set = new Set(ids);
      if (field === "is_archived" || field === "is_deleted") {
        if (value === 1) removeFromLists(qc, set);
        else settle(qc);
      } else {
        patchInLists(qc, set, { [field]: value } as Partial<MessageListItem>);
      }
    },
    onSettled: () => settle(qc),
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) => api.markRead(id, read),
    onMutate: async ({ id, read }) => {
      patchInLists(qc, new Set([id]), { is_read: read ? 1 : 0, thread_unread: read ? 0 : 1 });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.counts }),
  });
}

export function useSnooze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, until }: { ids: string[]; until: number | null }) =>
      api.snooze(ids, until, true),
    onMutate: async ({ ids }) => {
      await qc.cancelQueries({ queryKey: ["messages"] });
      removeFromLists(qc, new Set(ids));
    },
    onSettled: () => settle(qc),
  });
}

export function useSoftDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.softDelete(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["messages"] });
      removeFromLists(qc, new Set([id]));
    },
    onSettled: () => settle(qc),
  });
}

export function usePermanentDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.permanentDelete(ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ["messages"] });
      removeFromLists(qc, new Set(ids));
    },
    onSettled: () => settle(qc),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ view, labelId }: { view: ViewName; labelId?: string | null }) =>
      api.markAllRead(view, labelId),
    onMutate: async () => {
      eachMessageList(qc, (list) => list.map((m) => ({ ...m, is_read: 1 })));
    },
    onSettled: () => settle(qc),
  });
}

export function useApplyLabels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageIds, labelIds }: { messageIds: string[]; labelIds: string[] }) =>
      api.applyLabels(messageIds, labelIds),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["message"] });
      qc.invalidateQueries({ queryKey: qk.counts });
    },
  });
}

export function useRemoveLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, labelId }: { messageId: string; labelId: string }) =>
      api.removeLabel(messageId, labelId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["message"] });
    },
  });
}

export function useCreateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, color }: { name: string; color: string }) =>
      api.createLabel(name, color),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.labels });
      qc.invalidateQueries({ queryKey: qk.counts });
    },
  });
}

export function useDeleteLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteLabel(id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.labels });
      qc.invalidateQueries({ queryKey: qk.counts });
    },
  });
}

export function useReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.reply,
    onSettled: () => settle(qc),
  });
}

export function useCancelSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelSend(id),
    onSettled: () => settle(qc),
  });
}

export function useDrafts() {
  return useQuery({ queryKey: ["drafts"], queryFn: api.listDrafts });
}

export function useSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.send,
    onSettled: () => {
      settle(qc);
      qc.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteDraft(id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["drafts"] });
      qc.invalidateQueries({ queryKey: qk.counts });
    },
  });
}

export function useSummarize() {
  return useMutation({ mutationFn: (messageId: string) => api.summarize(messageId) });
}

export function useSmartReply() {
  return useMutation({ mutationFn: (messageId: string) => api.smartReply(messageId) });
}

export function useSetSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.setSettings,
    onSettled: () => qc.invalidateQueries({ queryKey: qk.settings }),
  });
}

// ── domains (only meaningful once a Cloudflare token is stored) ──────────────

export function useDomains(enabled: boolean) {
  return useQuery({ queryKey: ["domains"], queryFn: api.listDomains, enabled });
}

export function useDisconnectDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => api.disconnectDomain(domain),
    onSettled: () => qc.invalidateQueries({ queryKey: ["domains"] }),
  });
}

// ── live updates ─────────────────────────────────────────────────────────────

/** Reload the list and the open conversation. */
export function refreshMail(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["messages"] });
  qc.invalidateQueries({ queryKey: ["message"] });
  qc.invalidateQueries({ queryKey: qk.counts });
}

/**
 * New mail shows up as a change in the counts, which poll every 15 s, or as a
 * push message from the service worker. Either way the open conversation is
 * reloaded too; otherwise a reply that arrives while it is open stays hidden
 * until the user clicks away and back. Returns an unsubscribe function.
 */
export function watchForNewMail(qc: QueryClient): () => void {
  let last: string | undefined;
  const unsubCache = qc.getQueryCache().subscribe((ev) => {
    if (ev.type !== "updated" || ev.action.type !== "success" || ev.query.queryKey[0] !== "counts") return;
    const data = ev.query.state.data as { inbox?: number; unread?: number; sent?: number } | undefined;
    const sig = JSON.stringify([data?.inbox, data?.unread, data?.sent]);
    if (last !== undefined && sig !== last) {
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["message"] });
    }
    last = sig;
  });

  const onSwMessage = (e: MessageEvent) => {
    if ((e.data as { type?: string } | null)?.type === "driftmail:new-mail") refreshMail(qc);
  };
  const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  sw?.addEventListener("message", onSwMessage);

  return () => {
    unsubCache();
    sw?.removeEventListener("message", onSwMessage);
  };
}

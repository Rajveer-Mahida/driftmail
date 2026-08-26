import type {
  MessageListItem,
  MessageDetail,
  MessageHeaderDetails,
  CountsResponse,
  LabelRow,
  SettingsResponse,
  ViewName,
  FlagField,
  ComposeRequest,
  DraftRow,
  UploadedAttachment,
  AliasWithCount,
  AliasRow,
  RuleRow,
  DomainsResponse,
  DomainDnsRecord,
  MeResponse,
  SessionUser,
} from "@email/shared";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (res.status === 401) {
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      msg = j.error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const body = (data: unknown) => ({ method: "POST", body: JSON.stringify(data) });

export const api = {
  // auth
  me: () => req<MeResponse>("/api/auth/me"),
  login: (email: string, password: string) =>
    req<{ ok: true; user: SessionUser }>("/api/auth/login", body({ email, password })),
  changePassword: (current: string, next: string) =>
    req<{ ok: true }>("/api/auth/change-password", body({ current, next })),
  logout: () => req<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  // reads
  counts: () => req<CountsResponse>("/api/counts"),
  listLabels: () => req<LabelRow[]>("/api/labels"),
  settings: () => req<SettingsResponse>("/api/settings"),
  messages: (params: {
    view: ViewName;
    q?: string;
    label?: string | null;
    to?: string | null;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    qs.set("view", params.view);
    if (params.q) qs.set("q", params.q);
    if (params.label) qs.set("label", params.label);
    if (params.to) qs.set("to", params.to);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return req<MessageListItem[]>(`/api/messages?${qs.toString()}`);
  },
  message: (id: string) => req<MessageDetail>(`/api/messages/${id}`),
  messageHeaderDetails: (id: string) =>
    req<MessageHeaderDetails>(`/api/messages/${id}/details`),
  unsubscribeInfo: (id: string) =>
    req<{ http: string | null; mailto: string | null; oneClick: boolean }>(
      `/api/messages/${id}/unsubscribe`,
    ),
  unsubscribeOneClick: (id: string) =>
    req<{ ok: boolean; status?: number }>(`/api/messages/${id}/unsubscribe`, { method: "POST" }),

  // mutations
  flag: (ids: string[], field: FlagField, value: 0 | 1) =>
    req<{ ok: true }>("/api/messages/flag", body({ ids, field, value })),
  markRead: (id: string, read: boolean) =>
    req<{ ok: true }>("/api/messages/mark-read", body({ id, read })),
  markAllRead: (view: ViewName, labelId?: string | null) =>
    req<{ ok: true }>("/api/messages/mark-all-read", body({ view, labelId })),
  softDelete: (id: string) => req<{ ok: true }>("/api/messages/delete", body({ id })),
  permanentDelete: (ids: string[]) =>
    req<{ ok: true }>("/api/messages/permanent-delete", body({ ids })),
  snooze: (ids: string[], until: number | null) =>
    req<{ ok: true }>("/api/messages/snooze", body({ ids, until })),
  applyLabels: (messageIds: string[], labelIds: string[]) =>
    req<{ ok: true }>("/api/messages/labels", body({ messageIds, labelIds })),
  removeLabel: (messageId: string, labelId: string) =>
    req<{ ok: true }>("/api/messages/labels", { method: "DELETE", body: JSON.stringify({ messageId, labelId }) }),
  cancelSend: (id: string) => req<{ ok: true; cancelled: boolean }>("/api/messages/cancel-send", body({ id })),
  sendNow: (id: string) => req<{ ok: true }>("/api/messages/send-now", body({ id })),

  createLabel: (name: string, color: string) =>
    req<LabelRow>("/api/labels", body({ name, color })),
  deleteLabel: (id: string) => req<{ ok: true }>("/api/labels", { method: "DELETE", body: JSON.stringify({ id }) }),

  reply: (data: {
    messageId: string;
    to: string;
    subject: string;
    html?: string | null;
    text: string;
    sendAfter?: number;
  }) => req<{ ok: true; id: string; pending?: boolean }>("/api/reply", body(data)),

  setSettings: (data: {
    reply_enabled?: boolean;
    compose_enabled?: boolean;
    primary_domain?: string;
    signature?: string;
    block_remote_images?: boolean;
    allow_image_sender?: string;
  }) => req<{ ok: true }>("/api/settings", body(data)),

  // compose / drafts / uploads
  send: (data: ComposeRequest) =>
    req<{ ok: true; id: string; pending?: boolean }>("/api/send", body(data)),
  listDrafts: () => req<DraftRow[]>("/api/drafts"),
  getDraft: (id: string) => req<DraftRow>(`/api/drafts/${id}`),
  saveDraft: (data: Partial<DraftRow> & { to_addr: string }) =>
    req<DraftRow>("/api/drafts", body(data)),
  deleteDraft: (id: string) =>
    req<{ ok: true }>(`/api/drafts/${id}`, { method: "DELETE" }),
  // ai
  summarize: (messageId: string) =>
    req<{ summary: string }>("/api/ai/summarize", body({ messageId })),
  smartReply: (messageId: string) =>
    req<{ replies: string[] }>("/api/ai/smart-reply", body({ messageId })),

  // push
  getPushKey: () => req<{ key: string }>("/api/push/key"),
  pushSubscribe: (sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }) =>
    req<{ ok: true }>("/api/push/subscribe", body(sub)),
  pushUnsubscribe: (endpoint: string) =>
    req<{ ok: true }>("/api/push/unsubscribe", body({ endpoint })),

  // domains (only once a Cloudflare token is stored; 503 otherwise)
  listDomains: () => req<DomainsResponse>("/api/domains"),
  domainStatus: (domain: string) =>
    req<{ routing_state: string; catch_all_ok: boolean; records: DomainDnsRecord[] }>(
      `/api/domains/${encodeURIComponent(domain)}/status`,
    ),
  disconnectDomain: (domain: string) =>
    req<{ ok: true }>(`/api/domains/${encodeURIComponent(domain)}`, { method: "DELETE" }),

  // rules
  listRules: () => req<RuleRow[]>("/api/rules"),
  createRule: (data: {
    field: string;
    op: string;
    value: string;
    action: string;
    action_value?: string | null;
  }) => req<RuleRow>("/api/rules", body(data)),
  updateRule: (id: string, enabled: boolean) =>
    req<{ ok: true }>("/api/rules/update", body({ id, enabled })),
  deleteRule: (id: string) => req<{ ok: true }>("/api/rules/delete", body({ id })),
  runRules: () => req<{ ok: true; touched: number }>("/api/rules/run", { method: "POST" }),

  // aliases
  listAliases: () => req<AliasWithCount[]>("/api/aliases"),
  createAlias: (data: { address?: string; local?: string; domain?: string; name?: string; note?: string }) =>
    req<AliasRow>("/api/aliases", body(data)),
  updateAlias: (data: { address: string; name?: string | null; note?: string | null; disabled?: 0 | 1 }) =>
    req<{ ok: true }>("/api/aliases/update", body(data)),
  deleteAlias: (address: string) =>
    req<{ ok: true }>("/api/aliases/delete", body({ address })),

  uploadFile: async (file: File): Promise<UploadedAttachment> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/uploads", { method: "POST", body: fd, credentials: "include" });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as UploadedAttachment;
  },
};

// The single registry of every instance-wide config key.
//
// Declaring each key once with a kind and a default is what lets the accessor's
// TypeScript types be *derived* rather than hand-written, so a typo'd key is a
// compile error instead of a silent undefined at runtime.

export type ConfigKind = "string" | "bool" | "int" | "list";

type Spec<K extends ConfigKind, D> = { kind: K; default: D };

const s = (d = ""): Spec<"string", string> => ({ kind: "string", default: d });
const b = (d: boolean): Spec<"bool", boolean> => ({ kind: "bool", default: d });
const i = (d: number | null): Spec<"int", number | null> => ({ kind: "int", default: d });
const l = (): Spec<"list", string[]> => ({ kind: "list", default: [] });

export const CONFIG_REGISTRY = {
  // Instance identity. `claimed_at` is the claim sentinel: its presence is what
  // makes this deployment owned, and it is written by a conditional insert.
  "instance.claimed_at": i(null),
  "instance.first_seen_at": i(null),
  /** Must match the deployed Worker's script name — it is the value sent to the
   *  Email Routing rule API, and a Worker cannot read its own script name. */
  "instance.worker_name": s("driftmail"),
  "instance.worker_source": s("auto"), // auto | workers_dev | custom_domain | default | manual
  "instance.hostname": s(),
  "instance.cf_account_id": s(),

  // Mail behaviour (was the `settings` table).
  "mail.reply_enabled": b(false),
  "mail.compose_enabled": b(true),
  "mail.primary_domain": s(),
  "mail.handle_position": s("any"), // any | prefix | suffix

  // Outbound.
  "send.provider": s("none"), // resend | cloudflare | none
  "send.from_name": s(),

  // Reading pane.
  "ui.block_remote_images": b(true),
  "ui.image_allowlist": l(),
  "ui.signature": s(),

  // Web push. The public key is always derived from the private JWK, never stored.
  "push.vapid_subject": s(),

  // AI.
  "ai.model": s("claude-haiku-4-5"),

  // Wizard progress, kept server-side so a refresh or a device switch resumes.
  "setup.step": s("welcome"),
  "setup.skipped": l(),
  "setup.completed_at": i(null),
} as const;

export type ConfigKey = keyof typeof CONFIG_REGISTRY;

type ValueOf<S> = S extends Spec<"string", infer D>
  ? D
  : S extends Spec<"bool", infer D>
    ? D
    : S extends Spec<"int", infer D>
      ? D
      : S extends Spec<"list", infer D>
        ? D
        : never;

export type ConfigShape = { [K in ConfigKey]: ValueOf<(typeof CONFIG_REGISTRY)[K]> };

export const CONFIG_KEYS = Object.keys(CONFIG_REGISTRY) as ConfigKey[];

/** Parse a stored string into the key's declared type. Never throws: a corrupt
 *  row falls back to the default rather than taking the whole instance down. */
export function decode<K extends ConfigKey>(key: K, raw: string | null): ConfigShape[K] {
  const spec = CONFIG_REGISTRY[key];
  if (!spec) throw new Error(`Unknown config key "${key}"`);
  if (raw === null) return spec.default as ConfigShape[K];

  switch (spec.kind) {
    case "bool":
      return (raw === "1" || raw === "true") as ConfigShape[K];
    case "int": {
      const n = Number(raw);
      return (Number.isFinite(n) ? n : spec.default) as ConfigShape[K];
    }
    case "list": {
      try {
        const parsed: unknown = JSON.parse(raw);
        return (Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []) as ConfigShape[K];
      } catch {
        return [] as unknown as ConfigShape[K];
      }
    }
    default:
      return raw as ConfigShape[K];
  }
}

export function encode<K extends ConfigKey>(key: K, value: ConfigShape[K]): string {
  const spec = CONFIG_REGISTRY[key];
  // The type system already rules this out; the throw is for the JS boundary —
  // a hand-written key in a request body should say so, not crash on undefined.
  if (!spec) throw new Error(`Unknown config key "${key}"`);
  switch (spec.kind) {
    case "bool":
      return value ? "1" : "0";
    case "int":
      return String(value ?? "");
    case "list":
      return JSON.stringify(value ?? []);
    default:
      return String(value ?? "");
  }
}

export function defaults(): ConfigShape {
  const out = {} as ConfigShape;
  for (const key of CONFIG_KEYS) {
    (out as Record<string, unknown>)[key] = CONFIG_REGISTRY[key].default;
  }
  return out;
}

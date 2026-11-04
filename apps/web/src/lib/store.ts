import { create } from "zustand";
import type { ViewName, UploadedAttachment } from "@email/shared";

export type ComposeInit = {
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  /** Editable body, as HTML. Takes precedence over `text`. */
  html?: string;
  /** The message being answered or forwarded; shown folded, sent below the body. */
  quotedHtml?: string;
  inReplyToMessageId?: string;
  draftId?: string;
  attachments?: UploadedAttachment[];
  /** Open full screen (e.g. popping out an inline reply). */
  expanded?: boolean;
};

type Theme = "light" | "dark";

function initialTheme(): Theme {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "dark";
  }
  return "light";
}

function initialEmailTheme(): Theme {
  try {
    return localStorage.getItem("aria-email-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function initialAccent(): string {
  try {
    return localStorage.getItem("aria-accent") || "amber";
  } catch {
    return "amber";
  }
}

// Briefly enable a global color transition so theme/accent switches crossfade
// instead of snapping. Auto-removed so it never lags hover states.
let themeAnimTimer: ReturnType<typeof setTimeout> | undefined;
function flashThemeAnim() {
  const el = document.documentElement;
  el.classList.add("theme-anim");
  clearTimeout(themeAnimTimer);
  themeAnimTimer = setTimeout(() => el.classList.remove("theme-anim"), 420);
}

// Smoothly apply a theme/accent DOM change. Prefers the View Transitions API
// (GPU crossfade of the whole page — no per-node repaint jank); falls back to
// the broad CSS transition where unsupported.
function applyThemeChange(mutate: () => void) {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  };
  const reduce =
    typeof matchMedia !== "undefined" &&
    !matchMedia("(prefers-reduced-motion: no-preference)").matches;
  if (doc.startViewTransition && !reduce) {
    doc.startViewTransition(mutate);
  } else {
    flashThemeAnim();
    mutate();
  }
}

type UIState = {
  theme: Theme;
  toggleTheme: () => void;

  // reading-pane-only theme for email content (separate from app theme)
  emailTheme: Theme;
  toggleEmailTheme: () => void;

  // user-selectable accent color preset (client-only)
  accent: string;
  setAccent: (name: string) => void;

  // current list filter
  view: ViewName;
  labelId: string | null;
  aliasFilter: string | null;
  q: string;
  setFilter: (next: { view?: ViewName; labelId?: string | null; q?: string }) => void;
  setAliasFilter: (address: string | null) => void;

  // multi-select for bulk actions
  selection: Set<string>;
  toggleSelect: (id: string) => void;
  selectOnly: (ids: string[]) => void;
  clearSelection: () => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  mobileNavOpen: boolean;
  setMobileNav: (open: boolean) => void;

  // compose panel
  composeOpen: boolean;
  composeInit: ComposeInit | null;
  openCompose: (init?: ComposeInit) => void;
  closeCompose: () => void;

  // command palette + keyboard help
  paletteOpen: boolean;
  setPalette: (open: boolean) => void;
  helpOpen: boolean;
  setHelp: (open: boolean) => void;
};

export const useUI = create<UIState>((set, get) => ({
  theme: initialTheme(),
  toggleTheme: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    applyThemeChange(() => {
      document.documentElement.classList.toggle("dark", next === "dark");
    });
    try {
      localStorage.setItem("aria-theme", next);
    } catch {
      /* ignore */
    }
    set({ theme: next });
  },

  emailTheme: initialEmailTheme(),
  toggleEmailTheme: () => {
    const next: Theme = get().emailTheme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("aria-email-theme", next);
    } catch {
      /* ignore */
    }
    set({ emailTheme: next });
  },

  accent: initialAccent(),
  setAccent: (name) => {
    try {
      localStorage.setItem("aria-accent", name);
    } catch {
      /* ignore */
    }
    applyThemeChange(() => {
      if (name === "amber") {
        document.documentElement.removeAttribute("data-accent");
      } else {
        document.documentElement.setAttribute("data-accent", name);
      }
    });
    set({ accent: name });
  },

  view: "inbox",
  labelId: null,
  aliasFilter: null,
  q: "",
  setFilter: (next) =>
    set((s) => ({
      view: next.view ?? s.view,
      labelId: next.labelId !== undefined ? next.labelId : s.labelId,
      q: next.q !== undefined ? next.q : s.q,
      aliasFilter: null,
      selection: new Set<string>(),
      mobileNavOpen: false,
    })),
  setAliasFilter: (address) =>
    set({ aliasFilter: address, view: "inbox", labelId: null, q: "", mobileNavOpen: false }),

  selection: new Set<string>(),
  toggleSelect: (id) =>
    set((s) => {
      const next = new Set(s.selection);
      next.has(id) ? next.delete(id) : next.add(id);
      return { selection: next };
    }),
  selectOnly: (ids) => set({ selection: new Set(ids) }),
  clearSelection: () => set({ selection: new Set<string>() }),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  mobileNavOpen: false,
  setMobileNav: (open) => set({ mobileNavOpen: open }),

  composeOpen: false,
  composeInit: null,
  openCompose: (init) => set({ composeOpen: true, composeInit: init ?? null, paletteOpen: false }),
  closeCompose: () => set({ composeOpen: false, composeInit: null }),

  paletteOpen: false,
  setPalette: (open) => set({ paletteOpen: open }),
  helpOpen: false,
  setHelp: (open) => set({ helpOpen: open }),
}));

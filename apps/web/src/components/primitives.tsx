import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Eye, EyeOff } from "lucide-react";
import { motion } from "framer-motion";
import { cn, initials, avatarHue } from "@/lib/utils";

// ── Button ───────────────────────────────────────────────────────────────────
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "soft" | "outline" | "danger";
  size?: "sm" | "md";
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "soft", size = "md", ...props }, ref) => {
    const variants: Record<string, string> = {
      primary:
        "bg-accent text-accent-fg hover:bg-accent-hover shadow-[var(--shadow-sm)]",
      ghost: "text-muted hover:text-fg hover:bg-inset",
      soft: "bg-inset text-fg hover:bg-border",
      outline: "border border-border-strong text-fg hover:bg-inset",
      danger: "text-danger hover:bg-danger/10",
    };
    const sizes: Record<string, string> = {
      sm: "h-8 px-3 text-[13px] gap-1.5",
      md: "h-9.5 px-4 text-sm gap-2",
    };
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-[var(--radius-lg)] font-medium",
          "transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring/70",
          variants[variant],
          sizes[size],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

// ── IconButton ───────────────────────────────────────────────────────────────
type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
};
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, active, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-grid h-9 w-9 place-items-center rounded-full text-muted",
        "transition-all duration-150 active:scale-90 hover:bg-inset hover:text-fg",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring/60",
        "disabled:pointer-events-none disabled:opacity-40",
        active && "text-accent",
        className,
      )}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";

// ── Tooltip ──────────────────────────────────────────────────────────────────
export function Tip({
  children,
  label,
  side = "bottom",
}: {
  children: React.ReactNode;
  label: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg shadow-[var(--shadow-md)] data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;

// ── Avatar ───────────────────────────────────────────────────────────────────
export function Avatar({
  name,
  email,
  size = 40,
  className,
}: {
  name?: string | null;
  email: string;
  size?: number;
  className?: string;
}) {
  const hue = avatarHue(email);
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold text-white select-none",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `linear-gradient(140deg, oklch(0.68 0.12 ${hue}), oklch(0.55 0.14 ${(hue + 40) % 360}))`,
      }}
    >
      {initials(name, email)}
    </div>
  );
}

// ── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ className }: { className?: string }) {
  return (
    <motion.span
      className={cn(
        "inline-block h-4 w-4 rounded-full border-2 border-current border-t-transparent",
        className,
      )}
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.7, ease: "linear" }}
    />
  );
}

/**
 * The one confirmation dialog.
 *
 * Destructive actions used to fire on first click — observed going wrong with a
 * removed domain — while the few confirmations that existed were each hand-built.
 * One component keeps the pattern consistent: title states the action, the
 * description states the consequence, and the confirm button never says "OK" —
 * it repeats the verb.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  /** The verb, repeated — "Delete 3 messages", never "OK". */
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-elevated p-5 shadow-[var(--shadow-lg)]">
          <DialogPrimitive.Title className="font-display text-lg font-semibold">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm text-muted">
            {description}
          </DialogPrimitive.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onConfirm} disabled={busy}>
              {busy ? "Working…" : confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * A password field with a reveal toggle.
 *
 * Everywhere a secret is typed — passwords, API keys, setup tokens — people
 * paste or copy long values they can't verify blind. The eye shows what's
 * actually in the box; type="password" stays the default so nothing is exposed
 * without a deliberate click.
 */
export function PasswordInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <input {...props} type={show ? "text" : "password"} className={cn("pr-11", className)} />
      <button
        type="button"
        // Never submits the surrounding form, and never steals tab order from
        // the field-to-field flow — the eye is a mouse affordance.
        tabIndex={-1}
        aria-label={show ? "Hide" : "Show"}
        onClick={() => setShow((v) => !v)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-faint transition-colors hover:text-fg"
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

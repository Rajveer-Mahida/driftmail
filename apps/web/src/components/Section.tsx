import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/** A settings-style card: icon, title, description, and a control. */
export function Section({
  icon,
  title,
  desc,
  children,
  stack,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  children: React.ReactNode;
  stack?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-border bg-elevated p-5"
    >
      <div className={cn("flex gap-4", !stack && "items-center")}>
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-inset text-muted">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{title}</h3>
          <p className="text-sm text-muted">{desc}</p>
          {stack && children}
        </div>
        {!stack && <div className="shrink-0">{children}</div>}
      </div>
    </motion.div>
  );
}

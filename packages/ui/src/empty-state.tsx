import type { ReactNode } from "react";
import { cn } from "@fullstack-ai-infra/ui";

/** Local adapter for the shared #29 empty-state pattern. */
export function EmptyState({ icon, title, description, compact = false }: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  compact?: boolean;
}) {
  return <div className={cn("ui-org-empty-state", compact && "ui-org-empty-state--compact")}>
    {icon ? <span className="ui-org-empty-state__icon" aria-hidden="true">{icon}</span> : null}
    <h3 className="ui-org-empty-state__title">{title}</h3>
    {description ? <p className="ui-org-empty-state__description">{description}</p> : null}
  </div>;
}

import type { ComponentProps } from "react";
import { GoalsModule } from "../goals/GoalsModule";

type ProjectManagementModuleProps = Omit<
  ComponentProps<typeof GoalsModule>,
  "presentation"
>;

/** Independent navigation, sharing durable goals and their execution links. */
export function ProjectManagementModule(props: ProjectManagementModuleProps) {
  return <GoalsModule {...props} presentation="projects" />;
}

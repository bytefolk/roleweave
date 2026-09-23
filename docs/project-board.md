# Project management

Open a workspace, choose the independent **Project management** module in the navigation rail, and create or select a project. Each project has its own task board and schedule. Its brief, acceptance criteria, branches, and activity remain available under **Project brief & activity**.

The **Goals** module keeps its existing goal overview. Project management reuses the same durable goal records and execution links, so project plans remain connected to their objectives without duplicating their data.

## Plan and track work

- Add tasks with a title, optional description, responsible position, priority, and planned start/due dates. A goal supports up to 64 tasks.
- Move tasks through To do, In progress, Blocked, In review, and Done using each card's status selector. These are human-managed planning stages. Mark Done after accepting the result.
- Search tasks or filter by responsible position. Completion is the count of tasks marked Done divided by all tasks in the selected goal; blocked and overdue counts also cover the whole goal.
- Switch to Schedule for a four-week timeline. Navigate to earlier/later periods or return to Today. Tasks outside the period remain listed. Tasks with only one date appear as milestones; tasks without dates stay in the Unscheduled section.
- Dates are local calendar days. A task is overdue after its due date unless marked Done. Priority and dates are planning information; they do not automatically start, queue, or preempt Agent work.

## Agent execution

Assign a task to a position with an Agent engine configured in the organization, then use the task's Run action. This starts an immediate turn through the existing execution API. A busy position can reject the request; a rejected request is shown as an error, not a successful queue entry.

The task displays its latest associated execution separately from its planning stage. A completed turn does not automatically mark the task Done. Failed and indeterminate runs remain visible. Execution information refreshes when the project reloads and every 15 seconds while Project management is open. Unavailable execution history is identified explicitly.

Execution links are scoped by goal, task, and assigned position. Reassigning a task does not present the previous position's run as the new assignee's work. The projection contains execution metadata only; task descriptions and output are not copied into the execution summary.

This project plan is separate from the Agent collaboration queue proposed in #427. There is no automatic status, priority, or storage migration between the two models.

## Persistence and concurrent edits

Tasks are stored as optional `workItems` in the existing workspace-local goal record. Task updates include `expectedUpdatedAt`. A stale edit receives a conflict rather than replacing another user's or window's changes. The editor keeps the draft on failure; reopen the task from refreshed data before reconciling a conflict.

The new application reads old goal records with no task field. Older application versions use strict validation and cannot read goal records containing `workItems`. Back up workspace goal data before downgrading; do not remove task fields without preserving the plan. This feature does not migrate the goals storage directory.

## Reviewer checks

1. Create a goal and add tasks with assigned/unassigned positions, all five stages, and both complete and partial date ranges. Reload Project management and verify persistence.
2. Change a card's stage and edit its dates. Verify completion, blocked, overdue, search, and owner filtering. Verify a start date after its due date cannot be saved.
3. Open Schedule, move between four-week periods, and verify one-date and undated tasks remain visible.
4. Edit the same goal from two snapshots. The second stale save must return a conflict and keep its draft.
5. Run an assigned task using a configured local Agent. Verify the latest execution is linked to that goal/task/position and that the planning stage is unchanged after execution finishes.
6. Switch goals/workspaces during a pending read and verify the previous project's data is not displayed in the new project.

Automated coverage lives in the goal HTTP tests, desktop goal IPC tests, and renderer project-board tests. Renderer fixtures and stub-driver HTTP tests do not constitute a live-provider or packaged Windows acceptance test.

# Goals and progress design — #556, R1

Source: [`../org-workbench-goals-module.pen`](../org-workbench-goals-module.pen), refined through Pencil MCP from the shared workspace's `design/org-workbench-goals-module.pen`. Open the encrypted source through Pencil; PNGs are review references, never production fixtures.

| Reference | Product behavior |
| --- | --- |
| [Goals](goals.png) | Search/status filter, list/detail, goal status and authoritative health, acceptance criteria, branch completion, responsible role and source session, activity. |
| [Progress](progress.png) | Latest-updated snapshots, real steps and status, refresh, failed/stuck follow-up. |
| [Empty](empty.png) | One create action and explanation before the first goal. |
| [States](states.png) | Loading/error/retry, cached reads, no matches/clear, unknown progress, unassigned branches, mutation feedback, keyboard and narrow layout. |
| [Narrow list](narrow-list.png), [narrow detail](narrow-detail.png) | Selection opens detail; Back returns to search/list. |

## Data and interaction rules

- Progress in Goals is completed branches divided by **all** branches, including cancelled branches. No branches means unknown progress. A completed execution does not accept the goal: the owner still uses the goal's status and acceptance criteria.
- Goal health remains the persisted rule result. Existing Laya suggestions remain advisory and separate. Branch buttons open their exact position and optional session through the existing source callback; unassigned branches have no source action.
- Progress reads the existing `turn-progress.v1` snapshots, sorts by `updatedAt`, and places only `failed`/`stuck` runs in Follow up. Both list and follow-up open the existing step drawer. Failed reads show an alert and preserve any previous snapshots. Refresh retries the same authoritative read.
- App keys Progress by workspace path; stale reads are discarded after unmount or a newer read. No snapshots, failed reads and a closed workspace are distinct states.
- Preserve Agent board and Project management, goal create/delete/status transitions, SSE refresh, optional health actions and both locales/themes. No server schema or authorization changes.

## Fidelity decisions

The application uses its shared semantic tokens, current title bar and project navigation. It retains the existing Agent board tabs and explicit status/health controls absent from the first sketch. Acceptance criteria precede execution evidence for readability. The execution timeline keeps real progress bars, timestamps, elapsed duration and status tags rather than converting snapshots into invented activity descriptions. Follow-up contains actual abnormal runs rather than the original static reminders. Content scrolls inside the existing workbench; the Pencil references show representative bounded content without scrolling.

## Verification

Focused tests: `npm run test:renderer -- goals-module.test.tsx progress-board.test.tsx`. Full documented gate: `npm run check`. Browser QA uses the actual GoalsModule and ProgressBoard under the shared shell with fixture IPC responses; exercise filters, source identity, empty state, narrow navigation, follow-up drawer, failed refresh recovery and supported theme/locale variants. This does not claim live-agent execution or packaged macOS/Windows acceptance; platform packaging checks run in CI.

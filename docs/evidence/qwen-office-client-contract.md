# Qwen Office desktop connection boundary

2026-10-11, installed Windows client 1.3.0-26100807. This records a local
contract inspection, not a completed connection or model qualification.

The desktop control service exposes `qwenwork.desktop.v1` through an
authenticated loopback endpoint. Its available contract covers dedicated
sessions, task submission/status/results/events, task cancellation and pending
actions. The service was not enabled during this inspection.

`task.submit` uses the desktop client's execution policy, including its native
tools, MCP, skills and workspace. Its request schema does not supply a
per-task empty tool table or output-token limit. Pending-action responses are
approval/question responses, not a model-only generation method. Changing
global client permissions would affect the user's other tasks.

The normal third-party local plugin contract does not expose a model-only
broker using the desktop identity. First-party authentication capabilities
cannot be treated as permission for an ordinary local extension. The
[documented enterprise JSBridge](https://qwenwork.cn/docs/developer/premium/guide-jsbridge)
offers short-lived backend tokens, but its deployment requires enterprise
navigation publication; this is not a personal local plugin installation.

A native-assistant integration therefore needs an explicit separate runtime
contract: dedicated sessions; client-owned tool and approval settings; no
automatic approval; bounded event/results; exact owned-task cancellation; and
honest usage/budget reporting. It must not claim that the existing RoleWeave
read-only employee grants constrain the client's native tools.

No client credentials were exported, no vault was read, and no task was
submitted during this inspection. Qwen Code and Qoder are separate clients
and are not substitutes for this desktop login.

## Native acceptance — 2026-10-12

The user selected native assistant execution with confirmations in Qwen Office.
After enabling the normal local control service and restarting the idle client,
the actual Windows preflight reported `qwen_office.ready`, version `1.3.0`.
A minimal request prohibiting tools and file changes returned exactly
`千问办公连接正常` through both the direct Windows client and the complete
Windows → WSL supervisor → private socket → Office path. Public running status
crossed the WSL channel, and the owned supervisor closed with exit code `0`.
No usage receipt was supplied, so it was not invented.

Both installed builds' control contracts capture `[user, organization, team]`
inside each RPC and guard an existing task's owner and host turn. Public status
only exposes the user identifier, and session creation/submission has no
expected-identity or epoch field. This integration uses the client's current
account/organization; it does not claim an atomic initial-tenant lock across
RPCs. The UI and connection guide ask users to keep them unchanged while a
task runs. Account checks before submission/cancellation, late-response aborts,
known-ticket reflection rejection, and bounded quit-time cancellation are
covered by offline regression tests.

The normal RoleWeave hire endpoint created an Office employee with a locked
`qwen-office-local` binding. Its actual persisted turn completed with
`千问办公员工连接正常。`, and no usage was reported. This exercised the packaged
server, native desktop broker and WSL adapter without manual package edits.

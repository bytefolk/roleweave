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

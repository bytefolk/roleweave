# Claude scoped read-tool acceptance

Claude used to receive an empty native tool set and a one-turn limit even when
the employee declared Read, Glob and Grep. A provider could print `<tool_call>`
commands as text and the result was then recorded as a completed response.

The adapter now exposes only its owned read-only MCP server. It captures the
employee's Workbench permission rules, honors position/workspace scopes, denies
explicit denials and approval-required resources, refuses links and credential
locations, bounds text/enumeration sizes and redacts recognizable credentials.
No shell, write tools, global MCP definitions or hooks are enabled. Native tool
requests/results produce public activity records. The CLI iteration budget comes
from the employee's budget, capped at 32; this is not a hard provider token cap.

The CLI must report the owned MCP server connected before an enabled-tool task
can proceed. Unexecuted protocol text fails the turn; legacy replies are marked
in the UI and omitted as completion evidence from subsequent context. Stored
historical records remain unchanged. Intentionally quoted tool syntax is kept.

## Real-client evidence

On 2026-10-13, Windows launched the adapter through Ubuntu-22.04 Node 22.14 and
the locally installed Claude CLI. The existing TokenRhythm gateway and explicit
`deepseek-v4-pro-0813` model were retained. A temporary employee had a scoped
read grant and an unpredictable marker in a file, absent from the prompt. The
native CLI executed Read, returned the exact marker, and produced running and
completed activity records. Runs completed in 3.7 and 8.8 seconds with no stderr.

Codex's existing WSL ChatGPT login also returned a genuine completed connection
test with both its default model and an explicit model. Historical 403 HTML
alone does not establish a bad base URL or expired credentials; no API-key or
provider migration was performed. Future 401/403 failures are projected as
authentication/access errors rather than HTML answer text.

Checks cover resource isolation, explicit denials, approval-required grants,
symlink/junction refusal, size/binary bounds, credential redaction, MCP transport,
actual file reads, trace emission, partial-text deduplication, false completion,
legacy history, model catalog projection and package inventories.

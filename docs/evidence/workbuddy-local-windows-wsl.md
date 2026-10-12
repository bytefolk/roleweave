# WorkBuddy desktop login: Windows / WSL acceptance

2026-10-11. Native Windows desktop shell with a Ubuntu-22.04 control plane and
Linux Node 22.14.0; installed WorkBuddy 5.7.7, WBIPC v1. No WorkBuddy CLI runs.

The real connection followed the shipped `createControlPlaneChild` path:
Windows-owned stdin/stdout lease → Linux supervisor → private Unix socket →
Windows WBIPC client → signed-in WorkBuddy HTTP broker. The broker retains
provider credentials. No endpoint descriptor, ticket, token, account details,
or raw provider error is recorded here.

Observed minimal, tool-free model response:

```json
{"configured":true,"code":"workbuddy.ready"}
{"model":"auto","text":"WorkBuddy connection ok.","usage":{"inputTokens":42,"outputTokens":179,"totalTokens":221}}
```

Closing the owning stdin lease terminated the supervisor with exit code 0.
The separate Linux lifecycle suite passes its server/detached-host cleanup
checks. Private-channel tests cover cancellation, EOF, Unicode fragmentation,
per-frame limits, concurrency, and callbacks that ignore abort.

The account catalog route rejects the broker's restricted header set, so this
mode exposes only automatic model selection, with no claimed account catalog.
WBIPC buffers SSE with a 50-second deadline and a 640-KiB response bound. The
parser requires a complete nontruncated text result, rejects actual tool calls
and refusals, and permits only audited empty protocol placeholders. This Host
does not advertise token streaming. Service-API WorkBuddy keeps its existing
CLI version/platform qualifications and is a separate binding.

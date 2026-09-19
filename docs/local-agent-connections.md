# Local Agent connections

RoleWeave's bundled adapter reuses the selected CLI's local connection. An
employee's model choice does not change its Agent or silently switch billing
providers. Changing a model applies to subsequent turns; the existing
conversation and its context setting remain unchanged.

## Claude Code

In WSL mode, the local configuration is read inside WSL, not from the Windows
home directory. The adapter reads user `settings.json` under `CLAUDE_CONFIG_DIR`
or `~/.claude`, projecting only connection and model fields. Explicit service
mode uses its environment instead. Supported connection fields include
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, custom headers,
the default model and Haiku/Sonnet/Opus model mappings.

Authentication fields are selected as one group: a local gateway URL cannot
accidentally receive an inherited credential for a different connection.
Incomplete or malformed settings fail closed. Credentials are never CLI
arguments or UI fields. Credential-helper commands are not executed.

Without explicit credentials, the local CLI retains its official sign-in.
With an explicit key or token, the bundled adapter uses Claude's bare mode.
User/project hooks, MCP and unrelated tools are not imported into this
conversation-only adapter.

## Qoder CLI

The CLI executable must support the adapter's headless flags; a Qoder IDE
launcher is not a compatible CLI. Local login checks do not prove model
entitlement or sufficient credits.

The adapter reads `QODER_CONFIG_DIR/settings.json` or `~/.qoder/settings.json`,
including JSON comments. It projects provider/model configuration into a
private temporary settings file and removes that file when the adapter exits.
It does not modify the original file or decode the CLI's account-scoped
Custom model store. It retains the original config directory for CLI-owned
authentication and registered Custom selections.

The default follows Qoder's existing selection. The model menu also accepts
an already-registered model identifier, including Unicode Custom names; it is
not an API-key or provider-creation form. Unknown selectors and billing are
labelled unconfirmed until the CLI validates them.

Each invocation disables all hooks (including plugin hooks), isolates settings
sources and MCP, and limits built-in tools to the employee's explicit grants.
MCP grant references are currently unsupported by this adapter and fail closed
instead of loading global MCP servers.

## WorkBuddy (CodeBuddy Code)

Select **WorkBuddy** in project creation or employee hiring. Its durable engine
id is `workbuddy`; an existing employee keeps that binding when the app
reopens. When it is the only ready Host, it is also the default for a new
binding. There is one service-credential variant.

Set both `CODEBUDDY_API_KEY` and `CODEBUDDY_MODEL` in the control-plane process
environment, then restart RoleWeave. A personal WorkBuddy login is not reused.
`CODEBUDDY_BASE_URL` is optional; it accepts HTTPS endpoints and HTTP loopback
endpoints for local verification. Turn requests with invalid credentials,
model identifiers or URLs fail before their CLI probe or execution. Health
uses a separate isolated, credential-free version probe. Health readiness verifies
local prerequisites; provider credentials, entitlement and billing still
require a successful real-provider turn.

The resolver checks the authoritative `DIGITAL_EMPLOYEE_WORKBUDDY_COMMAND`
override, PATH (`codebuddy`, `codebuddy-code`, `cbc`), then known WorkBuddy
application locations. The desktop distribution's CLI is under
`app.asar.unpacked/cli/bin/codebuddy`, and may be absent from PATH. Invalid
explicit overrides fail closed. Native Windows currently reports not-ready
(`workbuddy.platform_not_verified`): its extensionless Node launcher and
process-tree cleanup have not completed native qualification.

Only exact CLI versions **2.106.4** and **2.137.1** have audited tool profiles
(53 and 60 deny entries respectively). Other versions fail closed; a version
number inside the same major release is insufficient. The adapter creates
private temporary HOME/config/XDG/tmp directories and a `0600` settings file,
disables hooks, restricts settings sources, provides a strict empty MCP
configuration, and disables all tools using the version-specific deny list.
It checks the actual initialization frame for empty tools/MCP, the expected
session, workspace, model and permission mode before accepting model text.
Unexpected tool events, malformed streams or missing terminal results fail
the turn; zero process exit alone does not mean completion.

### Reproduce local CLI qualification

With an already installed audited CLI and repository dependencies available:

```sh
node scripts/verify-workbuddy-cli.mjs --command "/path/to/codebuddy"
```

The verifier runs the bundled adapter and the selected CLI against a local
simulated OpenAI-compatible provider using a synthetic key. It checks one
model request with no tool definitions, matching streamed text and terminal
output, and no surviving owned processes. Its summary distinguishes an
omitted provider `tools` field from an empty array. It does not download a CLI,
read real credentials, or qualify a real provider account. See
[issue #275 evidence and remaining acceptance](evidence/issue-275/README.md).

## Gemini and Antigravity

The `gemini` Host accepts either Google Gemini CLI (`gemini`) or Google
Antigravity CLI (`agy`). Gemini CLI is preferred when both are on PATH. Set
`DIGITAL_EMPLOYEE_GEMINI_COMMAND` for a wrapper or non-standard installation;
set `DIGITAL_EMPLOYEE_GEMINI_CLIENT` to `gemini` or `antigravity` when the
wrapper name does not identify its protocol.

Both clients support their existing local Google sign-in. Gemini CLI receives
the operator's `GEMINI_CLI_HOME` only for authentication/config discovery while
the run itself uses a private HOME. Antigravity receives only its bounded local
OAuth token when the platform did not store the session in a native keyring;
operator settings, plugins, hooks, skills and conversation history are not
copied. The adapter creates a private settings file with tool-deny rules and
runs Antigravity in plan mode. A real turn remains the authentication and
entitlement check, so local health readiness does not promise remote access.

`GEMINI_API_KEY` remains an optional alternative. It is passed only to the
selected Gemini Host process; Antigravity also receives an isolated
`modelProvider: gemini` setting required by that client. Windows-to-WSL runs
transport the saved key through the bounded stdin bootstrap, never argv. An
optional `GEMINI_MODEL` pins a model; otherwise the selected client keeps its
own default. The model menu accepts strict model slugs and never imports the
Codex model cache.

## Status and cost

The menu shows the local connection source, hostname, mapped model identifier
and billing source without exposing full URLs or credentials. A configured
connection means the local configuration was read, not that a network request
succeeded. Gateway mappings do not inherit misleading economy/power labels.
Reported tokens are usage receipts, not a price quote or a hard spending cap.

## References

- [CodeBuddy CLI environment variables](https://www.codebuddy.ai/docs/cli/env-vars)
- [CodeBuddy CLI tools](https://www.codebuddy.ai/docs/cli/tools-reference)
- [CodeBuddy 2.137.1 release notes](https://www.codebuddy.ai/docs/cli/release-notes/v2.137.1)
- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Qoder configuration and precedence](https://docs.qoder.com/cli/settings)
- [Qoder CLI parameters](https://docs.qoder.com/cli/cli-reference)
- [Qoder custom models](https://docs.qoder.com/cli/custom-models)
- [Gemini CLI authentication](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx)
- [Gemini CLI configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)
- [Antigravity CLI headless mode](https://antigravity.google/docs/cli/headless/)
- [Antigravity CLI authentication](https://antigravity.google/docs/cli-install)

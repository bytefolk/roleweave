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

## Status and cost

The menu shows the local connection source, hostname, mapped model identifier
and billing source without exposing full URLs or credentials. A configured
connection means the local configuration was read, not that a network request
succeeded. Gateway mappings do not inherit misleading economy/power labels.
Reported tokens are usage receipts, not a price quote or a hard spending cap.

## References

- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Qoder configuration and precedence](https://docs.qoder.com/cli/settings)
- [Qoder CLI parameters](https://docs.qoder.com/cli/cli-reference)
- [Qoder custom models](https://docs.qoder.com/cli/custom-models)

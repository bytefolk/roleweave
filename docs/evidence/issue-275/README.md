# Issue #275 — WorkBuddy Host qualification

The reviewable implementation uses engine id `workbuddy`, display name
**WorkBuddy**, and the service configuration `CODEBUDDY_API_KEY` plus explicit
`CODEBUDDY_MODEL`. These are the implementation's proposed A1/B1 choices;
issue acceptance and human approval remain separate gates.

## Exact audited tool profiles

| CLI version | Denied tool names | Artifact audited |
| --- | ---: | --- |
| 2.106.4 | 53 | WorkBuddy macOS desktop CLI bundle |
| 2.137.1 | 60 | Official `@tencent-ai/codebuddy-code` npm distribution |

The profiles include both the product manifest and the bundled ToolNames
vocabulary. `--tools ""` alone left model-visible tools enabled during the
upstream investigation. A broad `>=2.106.0 <3.0.0` version window is therefore
insufficient. The shared runtime accepts only the exact audited versions and
requires observed empty `tools` and `mcp_servers` in the initialization frame.

Artifact fingerprints (audit reproducibility, not runtime hash allowlisting):

- 2.106.4 full bundle SHA-256: `8e9a14420c99a4102ebc2ae45e6b03d3749184a573f686ab1ac3f87352399c8b`.
- 2.137.1 headless bundle SHA-256: `5b5b60cf0dd4a45069e0fe10234df7ca474cb4a45aac8605c8873c592ebf9dec`.
- 2.137.1 npm tarball integrity: `sha512-8tdT/WCHIIgcKxfWVZ/wbu5Z+u/K7fugquMMbtIgld0suQ16salO9gI0l/eqzBUVC/5m31aV818/RL1ZYZ/CMQ==`.

## Automated behavior and local evidence

The focused tests cover:

- A WorkBuddy employee survives renderer remount and sends through its bound
  Host, even with other ready Hosts and a stale global preference. Before the
  fix this test sent `engine=qoder`.
- WorkBuddy appears as a selectable product with its own icon; the only ready
  WorkBuddy becomes the default for a new binding. A disposable browser
  component preview also checked selection and the visible icon; this is not
  packaged-app acceptance.
- IPC accepts WorkBuddy in personal, session, group, project and hiring flows.
  HTTP routes preserve the engine and read actual turn files back through new
  store instances; POSIX turn-file permissions are `0600`. Session and group
  execution honor durable WorkBuddy employee bindings.
- The package manifest explicitly includes source and compiled WorkBuddy
  resolver/runtime modules. The smoke process oracle starts real fixture
  children for every Host CLI alias, including `cbc`, and detects them in the
  native process table. The `cbc` fixture failed before the alias repair.
- The manual verifier rejects a nonempty outbound tool payload even when the
  CLI claims its initialization tool list is empty.

Reproduce E3 qualification against an already installed CLI:

```sh
node scripts/verify-workbuddy-cli.mjs --command "/path/to/codebuddy"
```

The verifier invokes RoleWeave's bundled adapter against a simulated local
provider, with a synthetic key and isolated settings/home. It requires exactly
one OpenAI-compatible request with no tools, matching stream and final text,
and zero surviving owned processes. Present malformed/nonempty `tools` are
rejected; absent `tools` means no definitions are sent and is reported
separately from an empty array. The shared parser also validates the CLI's
actual initialization and rejects tool/subagent events.

On 2026-09-15 both audited real CLI artifacts passed this verifier through
RoleWeave's bundled adapter on macOS: one model request, an omitted provider
`tools` field, one text delta, one matching terminal event, and zero residual
processes. The adapter accepted empty initialization tools/MCP and matching
session/workspace/model. This establishes local protocol evidence using a
simulated provider; it does not prove real-provider authentication,
entitlement or billing. Final-head reruns and CI results are recorded on the PR.

## Remaining acceptance

- Human review of the A1/B1 choices, exact-version qualification policy and final PR head.
- A real WorkBuddy provider turn with an authorized account, including failure
  behavior and no credential disclosure.
- Native packaged-app acceptance. Native Windows intentionally remains
  not-ready until its extensionless Node launcher and owned process cleanup
  are qualified; macOS fixtures and browser component checks do not replace it.

## Sources

- [Upstream CodeBuddy adapter at the reviewed reference](https://github.com/bytefolk/digital-employee/blob/d8e1eb1ffbfca8d406684abd533dd1ae2660eebd/apps/cli/codebuddy-agent-host.ts).
- [Upstream Agent Host contract](https://github.com/bytefolk/digital-employee/blob/d8e1eb1ffbfca8d406684abd533dd1ae2660eebd/docs/agent-hosts.md).
- [Official CodeBuddy CLI environment variables](https://www.codebuddy.ai/docs/cli/env-vars).
- [Official CodeBuddy tools reference](https://www.codebuddy.ai/docs/cli/tools-reference).
- [Official CodeBuddy 2.137.1 release notes](https://www.codebuddy.ai/docs/cli/release-notes/v2.137.1).

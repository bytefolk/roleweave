# Codex local login: Windows / WSL acceptance

2026-10-11. Windows desktop shell, Ubuntu-22.04 control plane, Linux Node
22.14.0, Codex CLI 0.159.2, existing ChatGPT sign-in.

The desktop supervisor prepends the configured Node installation to PATH.
That selected an older npm Codex 0.145.0 even though the interactive account
also had a standalone 0.159.2 installation. The old CLI rejected
`--disable view_image` before any model request. Upgrading the selected npm
installation to 0.159.2 preserved the existing authentication directory and
all adapter restrictions.

The existing `codex-local` employee then completed a real turn in the Windows
desktop UI using GPT-6-Luna. The final response included `Codex 连接正常`;
the displayed duration was five seconds. The request asked for a short
response using only the context already supplied and prohibited tool calls
and file changes. No credentials, account records or full conversation
context are included here.

Codex can expose native tools such as `apply_patch`; the read-only sandbox is the filesystem
boundary. This acceptance does not claim an empty native tool table or
qualification of every Codex version or provider model.

## Explicit native execution (#629)

The default remains read-only. In employee permissions, an operator can now
opt into **Codex native execution** separately from **Codex tool networking**.
Native execution permits host-file reads, as disclosed by the consent control;
it does not promise read isolation to a resource glob. Writes require all five
operations on an existing workspace subdirectory such as `./repos/project/**`,
with per-action approval explicitly off, plus Read/Write/Edit/Delete/Exec tools.
The employee must use `approval_required` mode. `read_only` mode and revoking
the native consent take effect on the next turn.

The adapter reads both permission projections each turn and uses a named Codex
filesystem profile. It never grants the workspace root, employee packages or
control-plane directories write access. Partial write/execute grants, deny
rules, approval-gated rules, symlink roots and linked external Git metadata
fail closed instead of being widened to native command access. Existing Git
metadata inside the granted directory is explicitly writable. Native execution
requires Codex CLI >= 0.163.0 within the 0.x series; default read-only turns keep
their existing compatibility boundary.

Networking defaults to `deny`. The separate `host_policy` opt-in allows tool
egress under the host network policy, **not a website allowlist**. On Windows,
network-enabled execution uses the restricted-token backend. Offline execution
requires the elevated backend and never retries with the weaker backend: the
latter's dead-proxy environment can be bypassed by raw TCP. This distinction is
also documented in the [official Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox).

2026-10-22 native Windows acceptance used the PR adapter, Codex CLI 0.163.0 and
an isolated disposable employee workspace. A real `codex-local` turn copied a
random marker byte-for-byte and queried the public repository's remote HEAD.
An OS sandbox probe allowed project and Git-metadata writes and rejected an
outside write with `EPERM`. The adapter emitted command activities and reaped
its process tree at the terminal event. No existing checkout was changed.

Negative testing demonstrated raw TCP bypassing the unelevated backend's
network-deny environment; this is why offline mode selects elevated. The test
machine could not start the elevated backend within the bounded probe, so this
acceptance does **not** claim a successful offline Windows command or verified
firewall isolation there. Automated tests cover backend selection, consent
revocation, unsupported policies, configuration isolation and failure without a
less restrictive retry.

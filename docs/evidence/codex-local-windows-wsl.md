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

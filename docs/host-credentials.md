# In-app Agent Host credentials

Open **Settings → Agent Host credentials** from the module rail. Each field
names the environment variable it replaces:

| Host | Settings |
| --- | --- |
| Qoder | `QODER_PERSONAL_ACCESS_TOKEN` |
| Claude | `ANTHROPIC_API_KEY`, optional alternative `ANTHROPIC_AUTH_TOKEN`, optional `ANTHROPIC_BASE_URL` |
| Codex | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` |

Save each required field. The status indicates whether a value is stored, not
whether a provider has accepted it. Stored values are never pre-filled or
revealed; the screen shows only **configured / not configured** and a last-four
hint. Clear removes a stored value. Validation checks format only. Endpoint URLs
must use HTTPS (HTTP is allowed for loopback), without embedded credentials,
query parameters or fragments. Keys must contain 5–8192 non-whitespace characters.

## Activation and precedence

Credentials are injected when the desktop starts its control-plane child.
**Finish active work, fully quit RoleWeave, and reopen it after saving or
clearing credentials.** This change does not replace credentials inside a running
control plane or interrupt an active turn. The existing `/health` check reports
Host readiness after startup. Instant activation is outside this spawn-time
surface; this implementation does not claim the issue's no-restart criteria.

Operator `ORG_WORKBENCH_*` pins are untouched. An explicit launch-environment
credential or endpoint (including an explicit empty string) wins over saved
settings for the whole Host connection. In particular, an inherited key is never
combined with a saved endpoint, nor an inherited endpoint with a saved key.
Claude custom headers also select the environment connection. A model selection
such as `OPENAI_MODEL` remains existing configuration, not a credential field.
The existing per-Host engine allowlists determine which credentials reach a turn.

Native children receive the credentials in their environment. WSL uses the
existing allowlisted stdin bootstrap, never command arguments. Existing WSL
Windows-to-Linux connection precedence remains unchanged: a connection supplied
by Windows replaces the corresponding Linux login-environment connection as a
unit. With no saved values, environment assembly and launch behavior are unchanged.

## Storage and boundaries

`host-credentials.json` in Electron's `userData` directory holds only a version
and allowlisted ciphertext entries, including encrypted endpoint URLs. The main
process uses Electron `safeStorage`, writes atomically with private permissions,
and rejects unavailable encryption and Linux's `basic_text` backend. It never
falls back to plaintext. A corrupt or inaccessible store produces a bounded
error; it is not silently overwritten or treated as empty.

The `owb.settings.get/set/clear` preload bridge validates its sender against the
trusted main window. `get` returns only configuration flags and suffix hints;
`set` and `clear` return success or a fixed error code. Decrypted values are not
cached in the desktop environment or put into server configuration. Native
password fields keep typed secrets outside React and antd form state and clear
on submit, including invalid submissions. Exceptions are never displayed or
logged. Control-plane stderr redaction also handles secrets split across chunks.

Tests use a fake safeStorage implementation; they never read an OS keychain or
real provider key. Run the focused checks with:

```sh
npm run build
npm run typecheck:renderer
node --test apps/desktop/test/credential-settings.test.cjs
npm run test:renderer -- host-credentials.test.tsx settings-module.test.tsx
```

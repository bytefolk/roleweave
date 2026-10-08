# Workspace Vault validation ledger

Issue: #574. Client/server dependency: bytefolk/mem#234.

## Source and local evidence

The publishing worktree starts from `bb4d11e` on `origin/main`. The existing
resource navigation, drive browser, image preview and newer goal/date changes
are retained. No personal maintenance tool, credential, deployed database,
backup, host path or runtime artifact is part of this patch.

| Check | Evidence |
| --- | --- |
| Shared/server compilation | PASS in the publishing worktree |
| Renderer type check | PASS in the publishing worktree |
| Vault/editor and App targeted regressions | PASS: 92 tests in the publishing worktree |
| Backend/context/drive/turn targeted regressions | PASS: 107 tests; Windows symlink-privilege case explicitly skipped |
| Archive/index recovery fault tests | PASS; injected index persistence failure preserves identity, binding and content; independent source review passed |
| Notebook usage receipts | PASS: actual injected references, versions and redacted excerpts; position mismatch and missing boot auth rejected |
| Scope and source scan | PASS: no local maintenance path, username, secret or live-test Vault identity in release scope |
| Diff checks | PASS |
| Full POSIX suite and packaging matrix | NOT VERIFIED locally; required GitHub checks remain authoritative |

Windows broad backend runs expose pre-existing CLI/symlink/CRLF platform
assumptions. Those failures are not represented as a green full-suite result.
The CI matrix runs the complete suite on Linux/macOS and the existing dedicated
Windows staging/WSL acceptance jobs.

## Local integration evidence

The earlier source implementation was exercised against an additive local Mem
Vault API deployment using two independent client workspaces and existing
workspace-scoped read/write credentials. No model was required.

- PASS: independent blank note IDs, write/pull, concurrent text edits retained
  as two versions, stale local/remote revision rejection and version restore.
- PASS: original PNG transfer and preview SHA-256 round trip.
- PASS: single-client and concurrent image edits retain old/new original blobs
  and resolve to independently previewable version paths.
- PASS: failed old-image restoration, later external image edits and retry
  behavior preserve edited bytes.
- PASS: case/NFC aliases with different originals fail before rewrite/upload.
- PASS: lost commit response replay, long Unicode conflict paths, path-owner
  protection and asset-link relocation when conflict copies change directory.

This is local source/runtime evidence, not a claim that the publishing commit
has already passed GitHub checks or that a new installer has been released.

## Review and merge

Independent source review found and closed the archive/index failure and
synchronization-edge defects. Public CI, conversation resolution and any
required GitHub approval must complete on the final pushed commit before merge.

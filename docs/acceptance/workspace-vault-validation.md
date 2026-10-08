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
| Complete renderer regressions | Initial Linux CI found a missing optional desktop-bridge guard in turn references and outdated Doc-default settings fixtures. The guard now supports standalone rendering; settings assertions still verify the configured Mem URL, token, status and workspace instead of the retired Doc-default controls. PASS: 77 files / 1,095 tests without skips, renderer type check and production renderer build |
| Backend/context/drive/turn targeted regressions | PASS: 107 tests; Windows symlink-privilege case explicitly skipped |
| Complete backend regressions | PASS on Node 24 Linux/ext4 from an LF source archive with independently installed dependencies: 821 tests total, 818 passed, no failures. Existing conditional skips: actual-engine approval requires `APPROVAL_ENGINE_MODULE`; pinned Context CLI durable-ingest integration is not configured; timeout-descendant acceptance is Windows-only. Includes the descriptor-read and poisoned-sync-state regressions; no Windows build output or dependency tree was reused |
| Archive/index recovery fault tests | PASS; injected index persistence failure preserves identity, binding and content; independent source review passed |
| Runtime packaging inventory and import closure | Initial GitHub check caught omitted Vault server/shared modules; fixed by explicitly listing all 13 generated runtime modules, including the descriptor-read helper, preserving packaging safety boundaries. PASS: 20 packaging/runtime/IPC tests after the security follow-up; 2 Windows-only filesystem fixture skips |
| Persistent session context process acceptance | Initial POSIX CI caught an obsolete raw-input assertion. Updated the fixture to parse the bounded untrusted Vault JSON, allow only the current role's knowledge path, preserve the exact request and reject personal history/private reasoning. PASS on Node 24 Linux/ext4, including other-role, disabled-history and rotated-session stages |
| Unicode image aliases across filesystems | macOS CI caught a fixture overwriting one physical image through two equivalent spellings. Metadata conflicts still run on every platform; exclusive creation bounds only the distinct-file fixture, and native/hard-link aliases verify one upload and unchanged originals. PASS: 16 attachment/session tests on Node 24 Linux/ext4, including distinct-file rejection and same-inode preservation; macOS native normalization remains a CI check |
| Notebook usage receipts | PASS: actual injected references, versions and redacted excerpts; position mismatch and missing boot auth rejected |
| Descriptor reads and synchronization request validation | CodeQL identified path-based read races in notes, attachments, history, receipts and sync state. All five now use a bounded descriptor with no-follow/nonblocking flags where available, regular-path checks, size limits and before/after identity checks. Snapshot requests use known routes and reconstructed UUIDs; poisoned state cannot create a request. PASS: 103 notebook/context/turn/privacy tests on Node 24 Linux/ext4 without skips; Windows targeted run: 50 passed, one symlink-privilege skip. Final CodeQL results remain pending |
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

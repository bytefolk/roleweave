# Workspace notebook and Mem synchronization

RoleWeave stores editable notebook bodies as ordinary UTF-8 Markdown files in
`notes/` under the opened workspace. A note can exist without a position. The
Notes and Drive surfaces are the default resource workflow; the external Doc
connection and position-document APIs remain compatible but are not a second
required notebook.

## Notes and context

Create folders or notes with Unicode names, search titles and body text, and
link notes using ordinary Markdown or wikilinks. Reading, live editing and
source modes share the existing editor and autosave state. Raster images are
loaded through the authorized notebook bridge rather than remote image URLs.
Use reading mode for image previews; the live editor does not fetch arbitrary
image addresses.

Associate existing note identities with positions. Association controls
automatic notebook context selection; it is not a new filesystem sandbox for
host tools. Each turn receives only active associated notes, at most four
bounded excerpts with a combined 32 KiB JSON context budget. Notes remain
untrusted data and do not grant tools or override runtime instructions.
The conversation exposes the references, versions and excerpts actually
assembled for a turn. Completed public answers can be reviewed and saved as a
note with their original position/session/turn provenance.

Markdown bodies remain on disk. `.roleweave/vault/` contains identities,
association metadata, recovery journals, bounded prior versions, attachment
metadata and immutable turn-use receipts. Local history is limited to 32
versions per note and 64 MiB per workspace; reads return at most 20 versions
and 8 MiB. Restore uses the latest content hash and refuses stale writes.

Notebook files, history, usage receipts and sync state are read through one
bounded file descriptor. POSIX opens reject a final symbolic link in the
kernel; every platform also verifies regular files, root/parent paths and
descriptor identity before reading and before returning bytes. Windows has no
`O_NOFOLLOW` equivalent in Node, so it relies on those path/identity checks.
File replacement or growth during a read fails without returning partial data.

Existing `knowledge/` files are referenced in place and are initially read-only
in the notebook. Explicit migration moves one file into `notes/` and preserves
the old reference alias. Position package configuration, tools and permissions
remain separate from notebook prose.

## Files and synchronization

Insert an original file from the configured Mem workspace, or use ordinary
local attachments under `notes/assets/`. Supported raster previews are PNG,
JPEG, WebP and GIF, capped at 8 MiB. Original attachment transfer is capped at
32 MiB per object and validates size and SHA-256. Credentials stay in the
desktop/server connection; they are never sent to the renderer.

Synchronization is manual and bidirectional. Both devices need a RoleWeave
client connected to the same authorized Mem service and workspace. Select the
same named remote Vault on the second client and synchronize to pull its notes.
Local autosave does not imply a completed remote synchronization. Unsaved
drafts and in-flight editor writes block synchronization.

Only the configured Mem origin receives notebook requests. Requests use the
known Vault routes and reconstruct remote identities as canonical UUIDs;
persisted state cannot add arbitrary URL/query parameters. Redirects fail
without forwarding the connection credential.

Mem's Vault API provides independent logical note identities, immutable
revision history, tombstones and whole-Vault compare-and-swap commits. It is
separate from blob deduplication, so two empty notes remain independent. A
local content hash protects apply against external edits. Concurrent edits
produce explicit conflict copies; deterministic copy identities and durable
pre-image state prevent retries from duplicating committed copies.

Images use content-version paths such as `assets/<sha256>.png`, keeping their
original bytes and relative Markdown/Wiki references. Concurrent image versions
can coexist; prior notes and history still reference their original images.
Case/NFC aliases resolving to different originals are rejected before changes.

Limits: 1 MiB per note, 16 MiB active notebook text, 1,000 logical heads, 512
changed entries and 4 MiB wire payload per remote commit. A failed or limited
operation is reported; the client does not silently truncate notes.

## Product boundaries

This is a portable notebook foundation, not an Obsidian plugin host or realtime
collaborative rich-text editor. Obsidian can read and edit the same Markdown and
relative attachment files. The remote Mem endpoint must be reachable from both
devices; this change does not expose a local-only service publicly or add
hosted signup/SSO. It uses the canonical Mem Vault API introduced by
bytefolk/mem#234. Existing Mem bundle v2 export does not include Vault history;
the dedicated Vault snapshot contract owns notebook transfer.

Refs #574 and #511.

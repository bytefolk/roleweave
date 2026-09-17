# RoleWeave mobile shell

Date: 2026-09-17
Status: first slice

## Problem

Opening RoleWeave on a phone currently presents a desktop workspace. Targets are too small, typing is hostile, and the org chart plus conversation are not designed for a thumb.

## Decision

Phones get a native web shell. The desktop app remains where hiring, org edits, and turns actually run.

Bottom navigation, four entries at most:

1. Organization: read-only preview of the example workspace roles.
2. Command: send one instruction to an already-running desktop host.
3. Desktop: remind the user that the full workbench stays on the computer.
4. Settings: data boundary (preview is read-only; turns execute on the desktop).

## Constraints

- Touch targets at least 44px, including the tab bar, with safe-area insets.
- Keep the existing RoleWeave palette (`#12141b` / `#7aa2ff`).
- `/api/mobile/workspace` returns names, descriptions, budgets, and skill excerpts only. No host filesystem paths.
- The control plane stays on loopback. The phone never receives the boot token.

## Non-goals

- Hiring, rewriting the org tree, or editing budgets on the phone.
- Exposing the control-plane port on a LAN.
- Rebuilding the Electron four-zone layout in this slice.

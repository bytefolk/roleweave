<!--
This branch (gh-pages) holds one static page — the RoleWeave marketing
site — with no history in common with `main` (the application source). No
backend, no runtime dependencies, no user data. The org-wide flow in
bytefolk/.github still applies (issue → branch → PR → independent review →
squash merge) against this branch, but the evidence that used to be
written out by hand now runs in CI (.github/workflows/site-verify.yml): the
contrast audit, the render check, and a step that proves the render check
still fails closed. Point at the run instead of restating it.
-->

## Tracking record

Closes #

## Summary

<!-- What changed on the page, and why. -->

## Verification

CI (`site-verify`) must be green. It runs, on every push to `gh-pages`:

- `npm run verify:contrast` — every text/background pair the page renders, both themes, against the WCAG thresholds. Tokens are parsed from `index.html`, so the audit cannot drift from the file.
- `npm run verify:render` — renders the page, screenshots hero / `#runtime` / `#ladder`, asserts all `.reveal` blocks trigger and the principles tab switches, and fails closed on page errors. Screenshots are uploaded as a run artifact.
- fail-close guard — re-runs the render check with injected page errors and fails the build if it *passes*, so a green run cannot be a silent no-op.

Anything CI cannot see (how it looks, whether the copy is true) goes below:

- [ ] Checked at phone width as well as desktop
- [ ] Checked in both light and dark mode

## Factual accuracy

This page is a public claim about what the product does. For each capability or
status the diff adds or changes, name where it is backed:

<!--
e.g. "role budgets — Shipped: roleweave README, 'How workspaces work'"
Anything not yet delivered must read as planned/preview, never as shipped.
-->

- [ ] No capability is described as shipped unless a linked repo says so
- [ ] No pricing, invented metrics, or customer names
- [ ] Screenshots contain example-workspace data only

## Risk and rollback

<!-- Default for a page-only change: low; rollback is reverting the merge
commit. Say so explicitly if this change is not that. -->

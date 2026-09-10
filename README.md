# RoleWeave site (`gh-pages`)

This branch is the GitHub Pages source for the RoleWeave marketing site.

**Live:** https://bytefolk.github.io/roleweave/

This branch has **no history in common with `main`** — `main` is the
product's application source (`apps/`, `packages/`, its own workspace
config); this branch holds only the static page. That split exists so the
site's no-build-step tooling never collides with the app's, and so pushes
to `gh-pages` (which is what GitHub Pages actually serves) can't be
mistaken for application releases.

The page's own content must be backed by what `main` (this repository's
README, docs, and release notes) actually documents. Anything not yet
delivered reads as planned or preview, never as shipped.

This content was migrated from `bytefolk/ordane` (rebranded there in
[bytefolk/ordane#7](https://github.com/bytefolk/ordane/pull/7); see that
PR and this branch's `CHANGELOG.md` for the full rebrand history), tracked
by [#228](https://github.com/bytefolk/roleweave/issues/228).

## Verify

```bash
npm ci
npx --no-install playwright-core install chromium
npm run verify
```

`verify:contrast` audits every text/background pair the page renders, in
both themes, against the WCAG thresholds; tokens are parsed out of
`index.html`, so the audit cannot drift from the file. `verify:render`
renders the page, screenshots hero / `#runtime` / `#ladder`, asserts the
reveal blocks and the tab switcher, and fails closed on page errors.
`verify:failclose` proves that fail-close path still exits non-zero.

## Contributing

Branch from `gh-pages` (not `main`), open a PR against `gh-pages`, and let
`site-verify` CI run. This repository's org-wide contribution flow still
applies: issue → branch → PR → CI → independent review → squash merge. See
[CONTRIBUTING.md](https://github.com/bytefolk/.github/blob/main/CONTRIBUTING.md)
and [GOVERNANCE.md](https://github.com/bytefolk/.github/blob/main/GOVERNANCE.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).

# Issue #110 R3 — Lane A staging foundation evidence

## Scope and provenance

- Canonical issue: <https://github.com/bytefolk/org-workbench/issues/110>
- Consumed revision: R3; approved by the R2 → R3 requirement decision at <https://github.com/bytefolk/org-workbench/issues/110#issuecomment-5492495629>. The canonical issue remains the merged supersession record for #106 / #109.
- Original candidate base: `main@764bfe0df895abb29a6cdc841845743dd7cf7e7f`
- Original fixed-SHA candidate: `264503391ff577b9c75e91ce04c7ade832219939` (`5c7e8b5fbbee75ed8d8fa222e8357e84806fc6ec` + `264503391ff577b9c75e91ce04c7ade832219939`).
- Historical #111 integration base/code head: `main@24ce31a22f24e0d0041306c48448ad2ee27270c1` / `3897329ee1877bc616504317c5bd284567cadd65`. Its corrected evidence descendant was `f619ab52b8d58a6ce286e8efc30b1db32f2911ab`; those results remain provenance only after main advanced.
- Current-main integration base: `main@ff878d8eaacc441e2674b57897554944358ea614` (PR #119 / issue #112; parent `24ce31a22f24e0d0041306c48448ad2ee27270c1`).
- Current-main source candidate: `f619ab52b8d58a6ce286e8efc30b1db32f2911ab`; its six commits were replayed without rewriting the source branch as `37d239e166f7fb941394aef2b97629005105ce8b`, `a4856e843bb2fe1f92dc7cad1d1f2ca655815ba6`, `8315a619349d2a5924684225dc3774ecd99a3063`, `3a43a9c28e8a6d62a5bda177893f7c8fb8e390c5`, `c3572292496141e0c88863492b9c0c17e57b4e19`, and `f4d14dc57ed203ae3eb91b3d55b1d0b891f909d7`.
- Current-main tested code head: `4f9a98396beebd00a1a3d0ed3d93f38f763c7f66` (parent `f4d14dc57ed203ae3eb91b3d55b1d0b891f909d7`). The eventual evidence-only descendant does not change executable code.
- Source-level seed inspected with `git show` only: `4f8b49bad95bbd3d0a7866c61fceb8ea87f37f93`
- Original candidate branch: `codex/feat-110-lane-a-packaging-foundation`; historical integration branch: `codex/feat-110-lane-a-packaging-foundation-r3`; current integration branch: `codex/feat-110-lane-a-packaging-foundation-r4`.
- Implementation owner: P8-lane-a. Automated pre-review is independent of the implementation owner. Human review remains owned by `@Bindy-lbb`; no review was requested by this local candidate.
- Original fixed-SHA evidence host: macOS 15.5 (`24F74`), arm64, Node `v26.7.0`, npm `11.19.0`.
- Current-main integration evidence host: macOS 15.5 (`24F74`) / Darwin 24.5.0 arm64, bundled Node `v24.19.0`, npm `11.19.0`.

The original Lane A candidate creates only an unpacked staging foundation with no product/distribution signature and a static clean-staging lifecycle smoke. Electron's macOS executable retains its upstream linker ad-hoc state; that is not a product signature. It does not create an installable artifact, publish anything, sign/notarize code, or implement update behavior. The current-main integration preserves #111's already-merged Finder/login-PATH, environment, health, and Qoder behavior plus #119's stable session/turn/report reads; the behavior path is exercised through a separate macOS-only qualification command and schema, never relabeled as Lane A static smoke or release proof.

## Tests-first baseline (public-safe red)

All commands were run from the isolated Lane A worktree. No credential values or external state were read.

| Phase | Exact command | Exit | Observed result |
| --- | --- | ---: | --- |
| Baseline capability probe | `node --test scripts/test/package-layout.test.mjs` | 1 | Test entry was absent (`scripts/test/package-layout.test.mjs` not found). |
| Baseline command probe | `npm run package:staging:macos` | 1 | npm reported that `package:staging:macos` was not a defined script. |
| Tests added before implementation | `node --test scripts/test/package-layout.test.mjs` | 1 | 3/3 staging config/layout/script assertions failed while the JS config, manifest, and root staging scripts were still absent. |

The first packaging attempt after implementation also failed safely because the native Electron distribution was absent after dependency installation. Lane A added the deterministic `prepare:electron:staging` step (`node node_modules/electron/install.js`) before builder invocation. A first smoke attempt then exposed macOS's lexical `/var` versus canonical `/private/var` path alias; the assertion was tightened to compare both sides through `fs.realpath`, without widening the accepted staging boundary. Neither failed attempt is counted as green evidence below.

One later post-hardening chain is also explicitly discarded: after binding the report write to a pre-opened descriptor, smoke exited with `SIGTRAP` and Electron reported `Bad file descriptor (9)`. Root cause was a real lifecycle regression: successful report write closed the descriptor, then the BrowserWindow `closed` callback closed the same integer after the OS had reused it for an unrelated Electron descriptor. The close helper now takes the integer and sets `request.reportFd = null` before closing. A focused adversarial test closes the reservation, forces reuse of the exact descriptor number for a sentinel file, invokes duplicate cleanup, and proves the sentinel remains writable/readable. Only the complete post-fix chain below is authoritative.

The first smoke after the final path/identity hardening is also discarded. It timed out after 45 seconds because the external harness had renamed its temp prefix while the packaged-side allowlist intentionally continued to accept only `owb-clean-staging-*`; the request therefore failed closed and no report was created. The harness now uses the same frozen prefix, while the copied application path itself still contains spaces. Focused tests and the native smoke were rerun after the fix. This is recorded as an integration regression, not as shell or machine noise.

A focused process-fixture attempt is also discarded as a test-harness regression. Its synthetic fast-exit leader kept a referenced child handle, so the leader never exited and the test remained live for more than 80 seconds. The owned test PGIDs were identified from their Lane A cwd and terminated without touching another worktree or unrelated process. The fixture now calls `child.unref()`, has a 10-second test timeout, and registers `t.after` cleanup for its owned group/orphan. The narrow suite then passed three consecutive 19/19 runs; after the final reused-origin selection mutant was added, it passed three consecutive 20/20 runs. None of the hung attempt is used as green evidence.

Independent fixed-SHA review of `e8afd2c84b3a8c61b1e3264fc2d2797242e176e9` returned **REQUEST CHANGES**. Three code P1s found that command/staging-path substrings could be mistaken for process ownership, Windows-style environment keys were compared case-sensitively, and the behavior smoke did not share the static smoke's complete load/window/renderer lifecycle gate. A fourth D6 P1 found that the focused-suite command was represented by a non-copyable placeholder instead of its exact ordered file list. That SHA's earlier green runs are retained only as superseded provenance and are not a gate for the corrected code SHA.

The corrections were tests-first. Before implementation, the control-plane casing suite passed 4/5, behavior lifecycle/reservation passed 7/10, and packaged smoke/process ownership passed 13/25; the live path-spoof fixture demonstrated the old cleanup code actually signaled its unrelated sentinel. The four production renderer timeout mutants (status, workspace, createTurn, history) already passed once the VM harness drove the real renderer script correctly, and are now retained as executable tests rather than source-regex assertions. After the minimal implementation, those suites passed 5/5, 10/10, and 25/25 respectively, with script smoke 7/7. A stricter first-signal identity check then exposed two POSIX zombie false failures (23/25); the final rule keeps strong root verification before the first signal, never grants later signal authority to an identity that cannot be revalidated, and lets the identity/group residual oracle fail closed. The final packaged suite returned to 25/25. These discarded RED/intermediate runs are not green evidence.

One standalone `npm run test:desktop-main` diagnostic is also excluded: it was invoked without first building `@org-workbench/shared` and failed its documented build precondition. The canonical ordered `npm run build && npm run test:desktop-main` path, exercised by `npm run check`, passed 89/89. No product defect or green claim is inferred from the malformed standalone invocation.

Independent review of corrected evidence SHA `f619ab52b8d58a6ce286e8efc30b1db32f2911ab` then found one new current-main P1: PR #119 added production module `apps/server/src/stable-read.ts`, imported by both session and turn stores, while the candidate's explicit runtime inventory stopped at the older server module set. The old 33-entry/188-file green result could not gate `main@ff878d8`; directly integrating it would either fail the source/inventory contract or omit `apps/server/dist/src/stable-read.js` from the package. The `f619ab5` result is therefore historical, not current-head evidence.

The R4 correction was tests-first on exact `ff878d8`. Immediately after replay, `node --test scripts/test/package-layout.test.mjs` exited 1 with 3/4 passing and the exact source/inventory diff identified missing `stable-read.js`. After an explicit required-entry/source-list assertion was added, the same command still exited 1 with 3/4 and reported `missing runtime entry: apps/server/dist/src/stable-read.js`. The minimal implementation added only `dist/src/stable-read.js` and its packaged path to the two explicit lists; layout then passed 4/4. A production-verifier mutant created the otherwise-valid exact path and deleted only that file; `validateResourceCandidate` rejected the package, and layout+safety passed 10/10.

The behavior qualification was also made to traverse the #119 production seam rather than the legacy turn route. Its test first failed 10/11 because production still used `createTurn`/`turnHistory`. The minimal bridge now calls `createSession` → `createSessionTurn` → `sessionTurnHistory`; the production VM/lifecycle suite passed 12/12 and the packaged result reports `sessionHistoryReadback: true`. Because both stores import `../stable-read.js` at module load and the packaged control plane successfully created and read the durable session history, this qualification exercises the packaged `stable-read.js` load path. It remains a deterministic local fixture result, not Lane A static smoke or live-Host evidence.

## Current-main integration baseline and conflict provenance

The original fixed-SHA review above remains historical evidence for `264503391ff577b9c75e91ce04c7ade832219939`; it is not treated as evidence for a branch based on #111. The first integration started from exact `24ce31a22f24e0d0041306c48448ad2ee27270c1` in a new worktree and branch. On that unmodified base, `package:staging:macos` and `verify:package:windows` were absent and exited 1, while the existing `control-plane-launch` plus `macos-login-path` focused tests passed 15/15. Candidate-only manifest/safety/static-renderer guards were absent. Those are the truthful #111-base red/absent baselines; no failing candidate test was fabricated in a tree where its file did not yet exist.

The two original candidate commits were replayed as new integration commits, without rewriting the old branch. Comparing old base → #111 main with old base → candidate yielded 18 overlapping paths; 15 required textual or add/add resolution. Every manual content resolution used `apply_patch`. The choices were:

| Overlap | Current-main integration choice |
| --- | --- |
| `.github/workflows/verify.yml` | Preserve the #111 required `check` matrix and read-only workflow authority; add separate native macOS arm64 and Windows x64 unpacked-staging jobs. Windows staging does not masquerade as a Windows `npm run check` result. |
| `.gitignore` | Keep current main's broad `/release/` rule byte-for-byte so legacy/compat package output does not become untracked. |
| `CHANGELOG.md` | Preserve #111 PATH/environment facts and add the static staging foundation; distinguish original fixed-SHA evidence from current-main evidence. |
| `README.md` | Use #111's real Finder/Qoder behavior as the base; document Lane A static staging and the separate behavior command/schema without mixing their claims. |
| `apps/desktop/electron-builder.config.cjs` | Keep the candidate's one-config, unpacked-only hardened staging: `asar: false`, explicit output, mac identity null, Windows `signExecutable: false`, no installer target, and no publisher. |
| `apps/desktop/electron-builder.yml` | Keep the shared deletion: CJS is the sole packaging authority, avoiding drift between two configs. |
| `apps/desktop/packaging/runtime-layout.cjs` | Keep the explicit exact-byte allowlist and #111 runtime consumers `apps/desktop/src/macos-login-path.cjs` and `apps/server/dist/src/engine/process-environment.js`; include the separately named packaged behavior module; on R4 add only #119's production import `apps/server/dist/src/stable-read.js`. |
| `apps/desktop/src/control-plane-launch.cjs` | Start from current main so `engineRuntimeEnvironment` and the internal bundled marker survive; strip both static and behavior smoke controls before either native or WSL server child. |
| `apps/desktop/src/main.js` | Start from current main so bounded `recoverMacGuiPath()` runs before spawn and environment propagation survives; layer in candidate static nonce/descriptor lifecycle plus a mutually exclusive #111 behavior mode. |
| `apps/desktop/src/packaged-smoke.cjs` | Keep candidate canonical-root, symlink/special-path rejection, create-exclusive descriptor-bound report, nonce, and lifecycle semantics; rebuild #111 business behavior in a separate module instead of weakening static smoke. |
| `apps/desktop/test/control-plane-launch.test.cjs` | Preserve #111 engine-environment assertions and extend them to prove neither static nor behavior controls cross the child boundary. |
| `apps/desktop/test/packaged-smoke.test.cjs` | Keep candidate adversarial nonce, descriptor-reuse, parent-swap, PID-reuse, and cleanup tests; #111 behavior assertions live in their own test file. |
| `package-lock.json` | Keep current main byte-for-byte. Integration adds no dependency or lock churn; SHA-256 is `49bb1ab7621e69bb7c6f4fd68e2b48e3316fe73731bc8fd5d2e4f282a91333d9`. |
| `package.json` | Keep current dependencies and existing `package:macos` / `package:macos:unsigned` entry points as compatibility aliases; make the explicit-architecture staging scripts canonical and retain `--dir --publish never`. |
| `scripts/clean-package-output.mjs` | Keep candidate canonical-parent/symlink-safe cleanup confined to `release/staging`. |
| `scripts/smoke-packaged-app.mjs` | Keep candidate external-copy and identity-bound process cleanup for static smoke; add a distinct macOS behavior mode using the same hardened reservation/process oracle. |
| `scripts/test/package-layout.test.mjs` | Keep candidate config/workflow/manifest guards and extend required runtime entries, compatibility aliases, explicit architectures, and static-versus-behavior separation. |
| `scripts/verify-packaged-app.mjs` | Keep candidate exact-set/exact-byte verification plus canonical/symlink/special-node, architecture, and precise no-product-signature rejection. |

The six `f619ab5` source commits were then replayed onto exact `ff878d8` in a second new worktree and branch. The only textual conflict was `CHANGELOG.md`; it was resolved with `apply_patch` as a semantic union, preserving #119's `GET /reports` stable-read entry and the Lane A independent-review record. No #119 production or test file was edited. The complete protected-path audit against `ff878d8` is:

```text
apps/desktop/src/macos-login-path.cjs
apps/desktop/test/macos-login-path.test.cjs
apps/server/bin/qoder-engine.mjs
apps/server/src/config.ts
apps/server/src/engine/driver-cli.ts
apps/server/src/engine/probe.ts
apps/server/src/engine/process-environment.ts
apps/server/src/index.ts
apps/server/src/routes/health.ts
apps/server/test/boot.test.ts
apps/server/test/driver-cli.test.ts
apps/server/test/engine-probe.test.ts
apps/server/test/helpers.ts
apps/server/test/qoder-engine.test.ts
apps/server/test/turn-driver.test.ts
docs/api-contract-v0.md
docs/evidence/issue-104/README.md
docs/evidence/issue-110/macos-arm64-foundation/DEPENDENCY-AUDIT.md
docs/evidence/issue-110/macos-arm64-foundation/VERIFICATION.md
apps/desktop/renderer/test/App.test.tsx
apps/server/src/sessions/store.ts
apps/server/src/stable-read.ts
apps/server/src/turns/store.ts
apps/server/test/reports.test.ts
apps/server/test/stable-read.test.ts
```

All 25 paths are byte-identical to `ff878d8`: the prior 19 preserve #111's Qoder/PATHEXT/environment/health behavior and evidence, while the final six preserve #119's renderer/session/turn/report stable-read production and tests. The new runtime consumer is packaged by changing only the explicit runtime layout and its Lane A tests.

One historical #111-base behavior run is explicitly discarded. It reached the external 45-second timeout with an empty report reservation. The packaged-side validator requires the requested staging root beneath the canonical temp parent supplied through the harness launch environment, but the newly separated behavior harness had inherited #111's old `TMPDIR=<staging>/tmp`; the request therefore failed closed before behavior mode started. Tests were added first: the launch-environment-confinement assertion failed before the helper was exported/fixed, and the per-IPC timeout assertion failed 2/3 before bounded stage labels existed. The minimal fix preserves the harness-supplied temp parent, leaves the Qoder PID fixture on its explicit private path, and gives status/workspace/history 6-second and fixture-turn 12-second renderer bounds. This is not an independent/native trust anchor, and a direct caller controlling the complete launch environment is outside the privilege boundary. Focused tests then passed 7/7 and 3/3, and the complete behavior qualification passed. The discarded timeout is not green evidence.

## Requirement-to-implementation map

| REQ ID | AC ID | Implementation files | Validation ID / exact command | Expected | Observed | Status / limit |
| --- | --- | --- | --- | --- | --- | --- |
| REQ-001 | AC-001 | `package.json`, `package-lock.json`, `apps/desktop/electron-builder.config.cjs`, `apps/desktop/packaging/runtime-layout.cjs`, `scripts/clean-package-output.mjs` | VAL-A-001-MAC: `npm ci`; `npm run package:staging:macos`. VAL-A-001-WIN: `npm ci`; `npm run package:staging:windows`. The pinned design-system build is the preceding native-CI step in `.github/workflows/verify.yml`. | A clean native checkout builds from the locked inputs on macOS and Windows after the pinned design-system build. | The accepted macOS arm64 authority chain completed the cold install and unpacked package. Windows x64 ran natively on `windows-latest` in run [33601662786](https://github.com/bytefolk/org-workbench/actions/runs/33601662786) at head `59b7eaf`: cold `npm ci`, pinned design-system build, and `package:staging:windows` all exited 0. | AC-001: macOS **PASS**; Windows x64 **PASS** on CI. |
| REQ-001 | AC-002 | `apps/desktop/packaging/runtime-layout.cjs`, `scripts/verify-packaged-app.mjs`, `scripts/test/package-layout.test.mjs`, `scripts/test/package-safety.test.mjs` | VAL-A-002-MAC: `npm run verify:package:macos`. VAL-A-002-WIN: `npm run verify:package:windows`. Focused contract: `node --test scripts/test/package-layout.test.mjs scripts/test/package-safety.test.mjs`. | Every runtime entry is present at its exact packaged path and exact bytes; missing, extra, forbidden, linked, special, or tampered content fails. | Current-main macOS verification checked 34 required entries and all 189 packaged files, including #111's PATH/environment runtime consumers and #119's exact `stable-read.js` path/bytes. The explicit missing-file production mutant fails closed. Windows x64 ran the verifier natively in run [33601662786](https://github.com/bytefolk/org-workbench/actions/runs/33601662786) and emitted `"ok":true` for 33 required entries across 189 packaged files, `"signature":"authenticode-not-signed"`. | AC-002: macOS exact inventory **PASS**; Windows x64 exact inventory **PASS** on CI. |
| REQ-002 | AC-001 | `package.json`, `apps/desktop/electron-builder.config.cjs`, `scripts/verify-packaged-app.mjs`, `.github/workflows/verify.yml` | VAL-A-002-STAGING-MAC: `npm run package:staging:macos`; `npm run verify:package:macos`. VAL-A-002-STAGING-WIN: `npm run package:staging:windows`; `npm run verify:package:windows`. | Each supported platform can create and verify an unsigned unpacked staging artifact without signing, notarization, release credentials, or publish authority. | macOS arm64 produced a verified `unsealed-linker-adhoc` app while poisoned CSC variables were unused; commands include `--publish never`. Windows signing stays disabled in config, and the native Windows artifact was produced and verified on CI in run [33601662786](https://github.com/bytefolk/org-workbench/actions/runs/33601662786) with `file signing skipped via signExecutable configuration`. | REQ-002 / AC-001 artifact portion: macOS **PASS**; Windows x64 **PASS** on CI. No installer, signing, or release claim. |
| REQ-003 | AC-003 | `scripts/smoke-packaged-app.mjs`, `apps/desktop/src/packaged-smoke.cjs`, `apps/desktop/packaging/process-tree.cjs`, `apps/desktop/renderer/src/main.tsx`, `apps/desktop/renderer/test/packaged-smoke-entry.test.tsx` | VAL-A-003: `npm run smoke:package:macos`; renderer guard: `npm run test:renderer -- renderer/test/packaged-smoke-entry.test.tsx`. | On macOS arm64, a clean external staging copy opens the local control plane and static renderer, then closes with no known/bound Workbench, server, or Qoder process remaining and without external credentials. | Native macOS arm64 smoke observed the renderer entry and control-plane readiness, forwarded no dummy external credential, recorded zero known residuals, and removed staging. | AC-003: macOS arm64 E3 **PASS** within the documented known/bound process boundary. |
| REQ-003 | AC-004 | Same clean-staging implementation as AC-003; Lane C must add/run the Intel-native artifact path. | VAL-A-004: on real Intel macOS, `npm run package:staging:macos`; `npm run verify:package:macos`; `npm run smoke:package:macos`. | The AC-003 clean-staging smoke passes on real macOS x64 hardware. | No real Intel Mac run or x64 artifact evidence exists in Lane A. | AC-004: **NOT VERIFIED / Lane C**. |
| REQ-003 | AC-005 | Windows unpacked foundation in `apps/desktop/electron-builder.config.cjs`, `scripts/verify-packaged-app.mjs`, `scripts/smoke-packaged-app.mjs`; installable target/procedure belongs to Lane C. | VAL-A-005: no Lane A command can prove this criterion; Lane C must build an installer, install it under the stock `C:\Program Files\...` path, then run the real launch/readiness/close oracle on Windows. | A real installed Windows client under the default Program Files location loads renderer/control plane and leaves no residual child; spaces do not break engine resolution. | No real Windows install was built or exercised. Lane A only copied an unpacked macOS app to an external staging path containing spaces. | AC-005: **NOT VERIFIED / Lane C**. The spaces-in-staging result is not installation evidence. |
| REQ-001, REQ-002, REQ-003 | AC-006 | `.github/workflows/verify.yml` plus the package, verifier, smoke, and repository test files above | VAL-A-006-LOCAL: `npm run check`; then the native package/verify/smoke commands above. VAL-A-006-CI: GitHub Actions jobs `check`, `staging-macos-arm64`, and `staging-windows-x64` on the exact PR head and again on post-merge `main`. | Full checks and native packaging evidence pass for the exact PR head and post-merge main, on all three check platforms; Ubuntu remains source/test only. | Local `npm run check` passed. Run [33601662786](https://github.com/bytefolk/org-workbench/actions/runs/33601662786) executed all four jobs on the exact PR head `59b7eaf` (base `main @ 9c04f00`): `Node 24 / ubuntu-latest`, `Node 24 / macos-14`, `Unpacked staging smoke / macOS arm64`, and `Unpacked staging smoke / Windows x64` all passed. | AC-006: local full check **PASS**; exact PR-head CI **PASS**; post-merge `main` **NOT VERIFIED** (nothing has merged yet). |
| REQ-004 | no dedicated AC in R3 | `apps/desktop/src/main.js`, `apps/desktop/src/packaged-smoke.cjs`, `apps/desktop/src/control-plane-launch.cjs`, `apps/desktop/renderer/src/main.tsx`, `apps/desktop/test/packaged-smoke.test.cjs`, `apps/desktop/test/control-plane-launch.test.cjs`, `apps/desktop/renderer/test/packaged-smoke-entry.test.tsx` | VAL-A-004-BOUNDARY: `node --test --test-concurrency=1 scripts/test/package-layout.test.mjs scripts/test/package-safety.test.mjs scripts/test/smoke-packaged-app.test.mjs apps/desktop/test/control-plane-launch.test.cjs apps/desktop/test/macos-login-path.test.cjs apps/desktop/test/packaged-behavior-smoke.test.cjs apps/desktop/test/packaged-smoke.test.cjs`; then `npm run test:renderer -- renderer/test/packaged-smoke-entry.test.tsx`; then `npm run check`. | The ordered focused command exits 0 with 71/71; development still enters the ordinary `App`; packaged static smoke is gated to `app.isPackaged`, makes zero representative renderer bridge calls, strips both smoke-control families before the control-plane child, and preserves Electron isolation/IPC boundaries with no migration. | Exit 0: focused 71/71; renderer static-entry 2/2; full check scripts 21/21, UI 31/31, server 181 pass + 1 expected skip, renderer 157/157, desktop main 91/91, audit 0 vulnerabilities. Existing isolation and enumerated preload IPC settings remain unchanged. | REQ-004 local security/dev-default/zero-bridge/full-regression validation **PASS**. R3 has **no dedicated AC** for REQ-004; exact PR-head CI is covered by AC-006 above, and post-merge `main` CI is still **NOT VERIFIED**. |

Separate from the #110 REQ/AC mapping, `npm run smoke:package:macos:behavior` passed on the same macOS arm64 artifact and proved #111's deterministic Finder PATH → local Qoder/MCP fixture plus #119's durable session create → completed turn → session-history readback chain. Its independent schema, controls, report, and macOS-only limit prevent that result from expanding AC-003's static-smoke claim.

## Independent blue-team P1 disposition

| Finding | Disposition |
| --- | --- |
| Original seed mixed macOS-only/Lane B assumptions | Closed for integration: no stale seed implementation was imported. Current main's reviewed `macos-login-path`, server/health/environment, PATHEXT, session/turn stable-read behavior remains byte-identical; its required runtime consumers were added only to the explicit package manifest. |
| Packaged production seam could run during development, escape its report root, suffer a parent swap, or accept a forged child report | Closed: `app.isPackaged`, canonical direct-child path, lstat/realpath rejection, exclusive descriptor-bound write, 256-bit request/query/report nonce, and stripping all smoke controls from the control-plane child. Real parent-swap and child-env fixtures fail closed. |
| Reserved empty/partial report, spawn rejection, duplicate close, or pre/post-report renderer crash could false-pass/hang/corrupt another fd | Closed: static and behavior modes enter the same lifecycle gate; bounded parsing retry has final-malformed failure; `loadFile` rejection, `did-fail-load`, `render-process-gone`, early `closed`, and smoke-run rejection are fatal, including after report write and before intentional close. When the reserved descriptor still exists, failure is a nonce-bound `ok:false` stage report; otherwise the outer oracle fails immediately. Descriptor close is take-and-null idempotent. Focused tests cover duplicate events, exact fd reuse, and post-report crash. |
| Stale output, parent links, special nodes, fail-open globs, or same-name byte tampering could be blessed | Closed: canonical ancestor/root confinement, clean-before-build, explicit inventories, bounded renderer outputs, denylist, all-node traversal, exact name set, and byte comparison for every allowlisted regular file. Real temp fixtures cover linked candidate/resources/clean parents, missing/extra/forbidden/FIFO and one-byte tamper. |
| Binary architecture and “unsigned” claim were too broad | Closed on current macOS evidence: `lipo` must be exactly `arm64`; `codesign` execution must succeed and return only the precise unsealed linker ad-hoc semantics with no Authority, Team, or resource seal. Report calls this `unsealed-linker-adhoc`; checksum is not signing. Windows reads x64 PE and requires `NotSigned`; run [33601662786](https://github.com/bytefolk/org-workbench/actions/runs/33601662786) confirmed it natively, reporting `architecture: x64` and `signature: authenticode-not-signed`. |
| Windows internal asar name and default executable signing were nondeterministic | Closed in config/tests: verifier contracts only Workbench exe/resources, never Electron's `electron.asar`/`default_app.asar`; `win.signExecutable` is false and a poisoned CSC config test cannot change it. Native Windows execution is now covered by run [33601662786](https://github.com/bytefolk/org-workbench/actions/runs/33601662786). |
| Raw PID, command, or staging-path cleanup could kill a reused/spoofing unrelated process, leak a child during launch-to-bind, or miss a TERM-spawned child | Closed for the claimed known boundary: launch records spawn provenance before binding start/executable identity; signal functions revalidate bound identities and reject raw PIDs. POSIX candidates are only the verified current root, its current descendants, the expected detached PGID while its origin generation is unambiguous, or already-bound identities; command and staging path confer no ownership. Windows candidates are only the verified current root/descendants or already-bound identities; a null root fails closed, and command/path text never authorizes a signal or an “owned residual” conclusion. Live fixtures prove fast-exit/group and TERM-spawned children are reaped while exact-command, staging-path, prefix-collision, PID-reuse, and null-root sentinels survive. Those adversarial fixtures ran on macOS; Windows now has native staging evidence but the sentinel fixtures were not re-run there. Malicious breakaway/reparent to an unrelated system binary is not guaranteed or claimed. |
| Smoke controls could survive under Windows casing rules or dual-mode reservation could leave an inode | Closed: control names are ASCII-uppercased before family comparison and are stripped from the actual native/WSL child environment for lower-, mixed-, and upper-case keys while unrelated `SAFE` keys remain. Both control families are detected side-effect-free before any `O_EXCL`; same/different report paths and partial/mixed-case families fail with no report inode. |
| Cleanup error could skip temp removal | Closed: process and directory cleanup are independent attempts; one or both errors are retained, with an `AggregateError` when both fail. |
| Lane A smoke accidentally depended on health/Qoder/business behavior | Closed: the trusted Lane A query mounts only a static renderer marker. Dynamic tests prove status/workspace/event/turn bridge calls stay at zero while the ordinary entry still renders `App`; control-plane readiness comes from main's ready line. #111 behavior uses a mutually exclusive control family, command, and report schema. The static native snapshot observed zero Qoder descendants, but does not claim a universal process-execution audit. |
| `TMPDIR` inside the repository could defeat clean staging | Closed within the harness trust model: the harness supplies a trusted canonical launch-environment temp parent, and temp base, staging root, and copied app must be canonical, source-disjoint, direct-child, and free of symlink/special-node substitution before launch. The pre-opened descriptor and nonce still bind the report. This is launch-env confinement, not an independent/native security anchor; a malicious direct caller that controls the entire launch environment, including `TMPDIR`/`TEMP`, is outside this privilege boundary. An in-source fixture is rejected without creating staging; an external path containing spaces succeeds. |
| Separate #111 behavior mode could bypass the hardened root or hang on IPC | Closed after a real fail-closed integration timeout: behavior preserves the same trusted canonical harness-supplied launch-env confinement, the fixture PID path stays explicit, and each renderer IPC has a bounded stage-specific timeout below the outer 45-second oracle. Production-script VM mutants independently hang control status, workspace, session create, Qoder session fixture turn, and session-history readback and require a nonce-matching stage failure, closed fd, and failed quit path. |

## Historical original-candidate macOS arm64 serial evidence

This historical run is authoritative only for original fixed SHA `264503391ff577b9c75e91ce04c7ade832219939` on old base `764bfe0df895abb29a6cdc841845743dd7cf7e7f`. It used one fail-fast foreground shell and verified its repository root before starting. No background operator (`&`) or parallel tool call was used. It ran on macOS 15.5 / Darwin 24.5.0 arm64 with Node v26.7.0 and npm 11.19.0. The fixed dummy values for Qoder, Anthropic, and CSC variables were deliberately not printed or retained; only their variable names are shown below. The commands ran strictly in this order, and each step completed before the next began:

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git merge-base HEAD origin/main
node -v && npm -v && uname -a && arch
shasum -a 256 package-lock.json
npm ci
shasum -a 256 package-lock.json
node --test scripts/test/package-layout.test.mjs \
  scripts/test/package-safety.test.mjs \
  scripts/test/smoke-packaged-app.test.mjs
node --test apps/desktop/test/control-plane-launch.test.cjs \
  apps/desktop/test/packaged-smoke.test.cjs
npm run test:renderer -- renderer/test/packaged-smoke-entry.test.tsx
npm run check
env QODER_PERSONAL_ACCESS_TOKEN=… ANTHROPIC_API_KEY=… \
  CSC_LINK=… WIN_CSC_LINK=… npm run package:staging:macos
npm run verify:package:macos
env QODER_PERSONAL_ACCESS_TOKEN=… ANTHROPIC_API_KEY=… \
  CSC_LINK=… WIN_CSC_LINK=… npm run smoke:package:macos
# bounded known-process and Node-cwd scan
git diff --check
# targeted secret scan excluding lockfiles and generated output
shasum -a 256 package-lock.json
git status --short --branch
```

| Step marker | Exit | Observed result |
| --- | ---: | --- |
| `environment` | 0 | `PWD` and top level were the isolated Lane A worktree; HEAD and merge-base were both `764bfe0df895abb29a6cdc841845743dd7cf7e7f`; host/version facts match the paragraph above. |
| `cold npm ci` | 0 | Added 592 packages, audited 599, found 0 vulnerabilities. Lock SHA-256 before/after remained `1c40dff8b49dd17bf38c4344d09be40a82c4aedd5ab3fd71d5d544565c024a60`. |
| `focused script behavior tests` | 0 | 15/15 passed, including real temp-tree verifier/cleaner, signature-classifier, report polling, temp confinement, cleanup aggregation, and fast-exit leader behavior. |
| `focused desktop main behavior tests` | 0 | 17/17 passed, including smoke-control stripping, descriptor/nonce/lifecycle, PID/identity mutants, reused-origin selection, and live process cleanup. |
| `focused packaged renderer entry test` | 0 | 2/2 passed: static smoke entry made zero representative bridge calls; ordinary entry still rendered `App`. |
| `full repository check` | 0 | scripts 19/19; UI 31/31; server 148 passed + 1 expected skip; renderer 157/157; desktop main 54/54; audit 0 vulnerabilities. |
| `native macOS arm64 unpacked staging with poison parent env` | 0 | electron-builder 26.15.3 produced `release/staging/mac-arm64/Org Workbench.app` from Electron 43.4.1 for darwin arm64; product signing was skipped because identity is null. Only unpacked `dir` staging was requested and poisoned CSC variables were not consumed. |
| `verify native macOS staging` | 0 | Exact allowlisted inventory/bytes, version/main, no-product-signature state, and native arm64 executable verified. |
| `clean-copy native macOS smoke with poison parent env` | 0 | Static renderer entry and control-plane readiness observed; dummy external credentials were not forwarded; known/bound residual count was 0 and temp staging was removed. The one snapshot observed zero Qoder descendants; it is not a universal never-executed claim. |
| Final residual/cwd, diff, secret, and lock checks | 0 | Known residual processes 0; Node cwd residuals 0; `git diff --check` clean; targeted secret-like matches 0; final lock SHA-256 unchanged. |
| `complete` | 0 | `AUTHORITY_CHAIN_EXIT=0`; the entire post-fix foreground chain completed. |

Sanitized verifier output:

```json
{"schemaVersion":"org-workbench-staging-manifest.v1","ok":true,"platform":"macos","artifact":"release/staging/mac-arm64/Org Workbench.app","version":"0.0.0","architecture":"arm64","unsigned":true,"signature":"unsealed-linker-adhoc","requiredEntries":30,"packagedFiles":185,"mainSha256":"60ccd15ced0ee0b0c473daeda1df53ee5bd4577383bbd54ca3a076aae388b86c","rendererSha256":"133a77f216a8b0cca86b846902e1891b6492de02883ae2f13be717a365ab6dcd","serverSha256":"deeb8a71871d341107bc04db3a12c853c20463b70f37fc78e93dc37d2f1c6bb7"}
```

Sanitized smoke output:

```json
{"schemaVersion":"org-workbench-clean-staging-smoke.v1","ok":true,"platform":"macos","architecture":"arm64","artifact":"release/staging/mac-arm64/Org Workbench.app","stagedOutsideSourceTree":true,"stagedPathHasSpaces":true,"rendererEntryObserved":true,"staticSmokeEntry":true,"controlPlaneReady":true,"trackedWorkbenchPid":true,"trackedControlPlanePid":true,"externalCredentialsForwarded":false,"liveDescendants":4,"qoderDescendantsObserved":0,"knownResidualProcesses":0,"stagingCleaned":true}
```

No PID, boot token, environment secret, response body, or machine-specific absolute path is retained in this ledger.

## Current-main macOS arm64 authority chain

This is the authority chain for code head `4f9a98396beebd00a1a3d0ed3d93f38f763c7f66`, whose first parent chain reaches exact integration base `ff878d8eaacc441e2674b57897554944358ea614`. The eventual evidence-only descendant does not change executable code. All commands ran serially in the isolated R4 integration worktree with bundled Node 24 exposed first on `PATH`. Fixed dummy values were supplied only under the environment names `QODER_PERSONAL_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `CSC_LINK`, `WIN_CSC_LINK`, and `CSC_IDENTITY_AUTO_DISCOVERY`; their values were neither printed nor retained. No real credential or external account was accessed. The command block preserves the exact argv and order; `…` deliberately redacts only the fixed dummy values.

```bash
git rev-parse HEAD
git merge-base HEAD ff878d8eaacc441e2674b57897554944358ea614
node --version && npm --version && uname -mrs && arch
shasum -a 256 package-lock.json
test ! -d node_modules
npm ci
shasum -a 256 package-lock.json
node --test --test-concurrency=1 \
  scripts/test/package-layout.test.mjs \
  scripts/test/package-safety.test.mjs \
  scripts/test/smoke-packaged-app.test.mjs \
  apps/desktop/test/control-plane-launch.test.cjs \
  apps/desktop/test/macos-login-path.test.cjs \
  apps/desktop/test/packaged-behavior-smoke.test.cjs \
  apps/desktop/test/packaged-smoke.test.cjs
npm run test:renderer -- renderer/test/packaged-smoke-entry.test.tsx
npm run check
env QODER_PERSONAL_ACCESS_TOKEN=… ANTHROPIC_API_KEY=… \
  CSC_LINK=… WIN_CSC_LINK=… CSC_IDENTITY_AUTO_DISCOVERY=false \
  npm run package:staging:macos
env QODER_PERSONAL_ACCESS_TOKEN=… ANTHROPIC_API_KEY=… \
  CSC_LINK=… WIN_CSC_LINK=… CSC_IDENTITY_AUTO_DISCOVERY=false \
  npm run verify:package:macos
env QODER_PERSONAL_ACCESS_TOKEN=… ANTHROPIC_API_KEY=… \
  CSC_LINK=… WIN_CSC_LINK=… CSC_IDENTITY_AUTO_DISCOVERY=false \
  npm run smoke:package:macos
env QODER_PERSONAL_ACCESS_TOKEN=… ANTHROPIC_API_KEY=… \
  CSC_LINK=… WIN_CSC_LINK=… CSC_IDENTITY_AUTO_DISCOVERY=false \
  npm run smoke:package:macos:behavior
git diff --check ff878d8eaacc441e2674b57897554944358ea614..HEAD
# exact main-only byte audit; targeted secret-like match counts only
shasum -a 256 package-lock.json
npm run clean:package:staging
git status --short --branch
```

| Step marker | Exit | Current-main observed result |
| --- | ---: | --- |
| `environment` | 0 | macOS 15.5 (`24F74`) / Darwin 24.5.0 arm64; bundled Node v24.19.0; npm 11.19.0; design-system exact `9d048faaabe0429a6a8720bfbb31418544237b6b` and clean. |
| `current-main manifest RED` | 1 | After the six-commit replay, layout passed 3/4 and named missing `stable-read.js`; after the explicit assertion was added it remained 3/4 and named missing packaged entry `apps/server/dist/src/stable-read.js`. No old-base absence was presented as this RED. |
| `cold npm ci` | 0 | With `node_modules` absent, added 592 packages, audited 599, found 0 vulnerabilities. Lock SHA-256 before/after remained `49bb1ab7621e69bb7c6f4fd68e2b48e3316fe73731bc8fd5d2e4f282a91333d9`. |
| `focused integrated regression` | 0 | Expected 71/71 and observed 71/71 in the exact seven-file order above. This includes the missing-file production verifier mutant; five production-renderer stage-timeout mutants for control status, workspace, session create, Qoder session fixture turn, and session history; Windows-casing/dual-mode controls; shared static/behavior lifecycle; descriptor reuse; path/command spoof sentinels; fast-exit orphan; TERM-spawned child; and PID-generation mutants. The separate static renderer entry expected and observed 2/2, exit 0. |
| `full repository check` | 0 | Expected all repository gates green. Observed scripts 21/21; UI 31/31; server 181 passed + 1 expected skip; renderer 157/157; desktop main 91/91; audit 0 vulnerabilities. Existing antd/jsdom and bundle-size warnings were non-failing. |
| `native macOS arm64 unpacked staging` | 0 | electron-builder 26.15.3 produced only `release/staging/mac-arm64/Org Workbench.app` from Electron 43.4.1 with explicit `--mac --arm64 --dir --publish never`; identity null skipped product signing. |
| `exact macOS verifier` | 0 | 34 required entries and all 189 packaged files matched the explicit inventory and source bytes, including `apps/server/dist/src/stable-read.js`; architecture was exactly arm64; signature classification was exactly `unsealed-linker-adhoc`. |
| `Lane A static smoke` | 0 | Static renderer marker and control-plane ready line observed; no external credential forwarded; post-report Qoder descendants 0; known/bound residuals 0; temp staging removed. It made no health/Host/business-turn claim. |
| `separate #111/#119 behavior smoke` | 0 | Renderer/preload, recovered login PATH, local Qoder/MCP fixture, health, completed session fixture turn, and durable session-history readback all true; `sessionHistoryReadback` was true. Login-only shell environment did not cross; post-report Qoder descendants 0; known/bound residuals 0; temp staging removed. This is not Lane A static smoke or real entitlement proof. |
| `lock/main-only/secret/diff/cleanup` | 0 | Lock remained byte-identical to `ff878d8`; all 25 protected paths were byte-identical; targeted secret-like scan reported zero added credential values; diff check clean; ignored staging output removed. No broad process listing was used. |

Sanitized current-main verifier output:

```json
{"schemaVersion":"org-workbench-staging-manifest.v1","ok":true,"platform":"macos","artifact":"release/staging/mac-arm64/Org Workbench.app","version":"0.0.0","architecture":"arm64","unsigned":true,"signature":"unsealed-linker-adhoc","requiredEntries":34,"packagedFiles":189,"mainSha256":"945867bad05808b9aea044bdb49ac1fe80bc6f3534d4b4c439584e013c0345b7","rendererSha256":"133a77f216a8b0cca86b846902e1891b6492de02883ae2f13be717a365ab6dcd","serverSha256":"63f7851d1da9cb1733794bfaf460ed257e459e086c05392c7c5be9727a0bcf0a"}
```

Sanitized current-main Lane A static smoke output:

```json
{"schemaVersion":"org-workbench-clean-staging-smoke.v1","ok":true,"platform":"macos","architecture":"arm64","artifact":"release/staging/mac-arm64/Org Workbench.app","stagedOutsideSourceTree":true,"stagedPathHasSpaces":true,"controlPlaneReady":true,"trackedWorkbenchPid":true,"trackedControlPlanePid":true,"externalCredentialsForwarded":false,"liveDescendants":4,"qoderDescendantsObservedAfterReport":0,"knownResidualProcesses":0,"rendererEntryObserved":true,"staticSmokeEntry":true,"stagingCleaned":true}
```

Sanitized current-main #111/#119 behavior qualification output:

```json
{"schemaVersion":"org-workbench-clean-staging-behavior-smoke.v1","ok":true,"platform":"macos","architecture":"arm64","artifact":"release/staging/mac-arm64/Org Workbench.app","stagedOutsideSourceTree":true,"stagedPathHasSpaces":true,"controlPlaneReady":true,"trackedWorkbenchPid":true,"trackedControlPlanePid":true,"externalCredentialsForwarded":false,"liveDescendants":4,"qoderDescendantsObservedAfterReport":0,"knownResidualProcesses":0,"rendererMounted":true,"preloadBridge":true,"loginPathRecovered":true,"nestedMcpResolvedViaRecoveredPath":true,"loginShellEnvironmentImported":false,"qoderReady":true,"turnCompleted":true,"historyReadback":true,"sessionHistoryReadback":true,"stagingCleaned":true}
```

The process claim is deliberately bounded to verified/bound identities, the current verified root and descendants, and on POSIX the expected detached group while its spawn-origin generation remains unambiguous. Command text and staging paths are diagnostic data only: they never grant signal authority and never support an “owned residual” conclusion. PID and command-line values are not evidence and are not retained.

## Current-main integration dependency and workflow audit

- `package-lock.json` is byte-for-byte identical to current main, SHA-256 `49bb1ab7621e69bb7c6f4fd68e2b48e3316fe73731bc8fd5d2e4f282a91333d9`; the integration adds no package record, resolved URL, integrity, lifecycle script, license, or dependency-closure change. `package.json` changes only packaging scripts.
- The cold Node 24 install added 592 packages, audited 599, reported 0 vulnerabilities, and did not modify the lock. `npm audit --audit-level=high` also passed at the end of the full check.
- The original-candidate dependency review below remains useful provenance for how `electron-builder@26.15.3` entered the old-base candidate, but its old-base lock delta and old SHA must not be attributed to this integration. Against `ff878d8...`, the dependency and lock delta is exactly zero.
- R4 keeps `.github/workflows/verify.yml`, `.gitignore`, `package.json`, `package-lock.json`, and `apps/desktop/electron-builder.config.cjs` byte-identical to source candidate `f619ab5`; the expected integration-only runtime-layout delta is the explicit `stable-read.js` entry, with corresponding layout/safety tests and the separate behavior-path qualification. No dependency, package command, workflow authority, signing, installer, updater, or publisher drift was introduced.
- Workflow authority remains top-level `contents: read`, uses `pull_request`/main push rather than `pull_request_target`, and contains no secret expression or upload/publish step. Native staging jobs use pinned design-system commit `9d048faaabe0429a6a8720bfbb31418544237b6b`, Node 24, cold installs, explicit native architecture commands, verifier, and smoke. The required `check` matrix stays POSIX-only. A `windows-latest` leg was folded in from #122 and then reverted: the suite is written against POSIX process and filesystem semantics, and the leg hung on `npm run check` for over an hour without producing a bounded failure to point at. Windows is covered by a purpose-built staging leg instead, which is green. `NanmiCoder/cc-haha` takes the same shape — every quality job there runs on `ubuntu-latest`, and Windows carries only targeted PowerShell checks alongside packaging.
- Both native package commands contain `--dir --publish never`. The sole CJS builder config has mac identity null and Windows `signExecutable: false`; no DMG/ZIP/NSIS/MSI target, updater, signing/notarization request, release credential, custom mirror, tag, asset upload, or publisher is configured.
- Windows x64 package, verify and smoke now have native CI evidence at the exact commit: run [33601662786](https://github.com/bytefolk/org-workbench/actions/runs/33601662786) on `windows-latest`, head `59b7eaf`. No macOS result is projected onto Windows, and no Windows result is projected onto the installable or signed paths, which remain Lane C. Reaching that green required six defects in the Windows harness path; they are recorded in the branch history and summarised in the PR description.

## Historical original-candidate dependency and workflow audit

- `electron-builder@26.15.3` is an exact, root-level development dependency (MIT metadata), never a shipped runtime dependency. Lock SRI: `sha512-a1KM5heqS3gQCZzizXEI8RjJy3QVogULPdeSknt76uLDpBIW/HDGsMg/XgP0riP6PI9COsRvFITKKGDqA8fJxA==`.
- Final cold reproduction: `npm ci` exited 0, added 592 packages, audited 599 packages with 0 vulnerabilities, and left `package-lock.json` byte-identical; SHA-256 before/after was `1c40dff8b49dd17bf38c4344d09be40a82c4aedd5ab3fd71d5d544565c024a60`.
- Relative to the base lock, the intended lock delta is exactly 265 added package records, all `dev: true`, registry-resolved and integrity-bearing, with no removals or pre-existing resolved/integrity churn. The root metadata is the only changed existing package entry. A local sibling `design-system` metadata rewrite produced by the first lock-only install was rejected and restored to the base lock before validation.
- Lock metadata has no GPL/AGPL/SSPL/unknown blocker. `npm audit --audit-level=high` reports high 0, critical 0, total 0.
- The builder closure contains 284 package records. It reaches all 265 newly added records (each marked `dev: true`) and reuses four pre-existing records that are not dev-marked: `debug@4.4.3`, `ms@2.1.3`, `@types/debug@4.1.13`, and `@types/ms@2.1.0`. The closure's intersection with the runtime manifest is 0, and packaged verification proves none of it was delivered in the artifact. The only lifecycle script in that closure is `electron-winstaller@5.4.0`; its install script selects/copies bundled local host-architecture 7-Zip files and does not perform a network fetch. Its npm metadata says MIT, but bundled WiX/7-Zip/Windows SDK/Squirrel notice/provenance is **NOT VERIFIED** (the WiX config names MS-RL and the tarball lacks the referenced `LICENSE.TXT`). Do not ship this graph, select Squirrel, or redistribute its vendor payload without a separate third-party-license review; Lane C's planned NSIS route is a separate review.
- Builder may fetch checksum-pinned Electron/7-Zip/NSIS/rcedit/winCodeSign toolsets in future lanes. Do not add custom mirror/override environment variables without separate HTTPS and checksum review. Checksum integrity is not code signing.
- Every package command includes `--publish never`; there is no updater, signing identity, release credential, custom mirror, or publish configuration.
- Workflow top-level authority remains `permissions: contents: read`; trigger remains `pull_request`/main push, not `pull_request_target`; no `${{ secrets.* }}` expression exists. Windows was not added to the existing required `check` matrix.
- The new arm64 staging job uses `macos-15`, which the official runner-image table maps to macOS 15 arm64. `macos-14` began deprecation on 2026-07-06 and retires on 2026-11-02, so it is not used for new staging evidence. The existing required `check` matrix still names `macos-14`; changing that required-check context is intentionally left to a separately coordinated policy update. Sources: <https://github.com/actions/runner-images#available-images>, <https://github.com/actions/runner-images/issues/13518>.
- Existing mutable `actions/checkout@v6` and `actions/setup-node@v6` tags remain a supply-chain residual. Lane A reuses those existing action identities/versions; full-SHA pinning is recommended in a separately reviewed workflow change.

## Cleanup, rollback, and limits

Packaging output is confined to ignored `release/staging/`. Smoke temp roots use trusted canonical harness-supplied launch-environment confinement: the resolved temp parent, direct-child staging root, and copied app must be canonical, source-disjoint, and free of link/special-node substitution, while the report remains descriptor/nonce-bound. This is not an independent/native security anchor; a malicious direct caller controlling the entire launch environment, including `TMPDIR`/`TEMP`, is outside the privilege boundary. Process termination and recursive temp removal are separately attempted even when either fails; the accepted report records `stagingCleaned: true`. No tag, release, upload, issue/PR mutation, signing request, installer execution, real credential access, or other external state was created.

Rollback is a normal revert of the eventual current-main integration commits, followed by deletion of ignored `release/staging/` if locally retained. Because the lane has no migration, publish, update feed, or durable external state, no data rollback is required. Source development remains available through the unchanged `npm run dev:desktop` path.

## Folded in from #122

PR #122 built a parallel Windows CI leg on the pre-Lane-A generation of the verifier and smoke scripts. Its packaging surface is superseded here — a two-entry `WIN_APP_REQUIRED_ENTRIES` against this branch's exact 33-entry byte inventory, `signAndEditExecutable: false` against the narrower `signExecutable: false` that keeps PE metadata editing, and a duplicate `package-windows` job. Those were dropped rather than merged.

Three things from it were not superseded and are now part of this slice:

- **Windows launcher execution.** Node refuses to exec `.bat`/`.cmd` launcher scripts without a shell (CVE-2024-27980 hardening). `apps/server/src/routes/health.ts` and `apps/server/bin/qoder-engine.mjs` now route exactly those resolved targets through a shell and keep every other target shell-free. Without this the packaged Windows app cannot start Qoder at all, which no staging assertion in this branch would have caught.
- **Windows process-startup environment.** `PATHEXT`, `ComSpec`, `SystemRoot`/`SYSTEMROOT` and `WINDIR` are added to the Qoder child environment allowlist. They are non-credential keys required for child process creation on Windows and mirror `runtimeExecutableEnvironment`.
- **Test-suite portability helpers, retained without the Windows leg.** `assertPosixMode` skips permission-bit assertions on NTFS, which reports synthetic `0o666`/`0o444` regardless of the written mode, and the probe/engine tests that exec `#!/bin/sh` fixtures skip on win32. The `windows-latest` check leg they were written for was reverted, but the helpers are correct on their own terms — `assertPosixMode` still asserts on POSIX — and they are what a future attempt would start from.

The following are explicitly **NOT VERIFIED / out of Lane A scope**:
- `npm run check` on Windows. The suite has never passed there. A `windows-latest` matrix leg was added from #122 and reverted after it hung on `Verify workbench` for over an hour on this branch, and for over two hours on #122's own branch before that. The two changes that came out of the attempt are kept: bounded `--test-timeout` on every `node --test` invocation and a `timeout-minutes` on the check job, so a future attempt fails with a named test instead of running to the six-hour default. What Windows does have is the staging package, verify and smoke leg, which is green and is what Lane A claims.

- The Qoder/Host residual contract on Windows. `scripts/smoke-packaged-app.mjs` asserts that no Qoder-named descendant outlives the report, but the Qoder fixture is created only in behavior mode, and no `smoke:package:windows:behavior` exists — the Windows job runs static mode only. That assertion therefore passes on Windows by construction, without a Qoder process ever having existed, and it is **not** evidence of Windows residual cleanup. Separately, `listWindowsProcesses` maps a null `Win32_Process.CommandLine` to an empty string, so a descendant whose command line the querying user cannot read would escape the filter on any platform. Both are tracked in #131. What does hold on Windows: the harness lease, the health-route liveness proof, the non-empty descendant assertion, and the post-exit identity/group residual oracle.

- CI job completion on post-merge `main`; the exact PR head is now covered by run 33601662786, but nothing has merged, so no post-merge result exists.
- DMG, ZIP, NSIS, MSI, Program Files installation, uninstall, install-over-old-version, explicit release architecture policy, Intel Mac, signing, notarization, Authenticode signing, GitHub Release assets, tags, publishing permissions, or auto-update. Those belong to Lane C or later release lanes.
- Real user login profiles, an installed real Qoder/MCP binary, remote Host entitlement, or credential-backed business output. The separate #111/#119 behavior result uses only a deterministic local fixture; Windows PATHEXT behavior has test coverage but no native staging run here.
- External credentials, memory/onboarding/first-run behavior, or release rollback drills.
- A universal containment guarantee for arbitrary or malicious process breakaway. The macOS E3 proves the actual Workbench, reported control plane, observed bound descendants, and expected detached POSIX group reached zero; explicit adversarial fixtures prove a TERM-spawned same-group child is reaped while command/path spoof, path-prefix collision, and PID-reuse sentinels are not signaled. A child that deliberately creates a new session with `setsid` is outside the claimed boundary. Windows can use only a verified current root/descendant relationship or an already-bound creation/start/executable identity; null-root provenance fails closed, and path/command text has no ownership authority. Reparent/breakaway is **NOT GUARANTEED / NOT VERIFIED** without a native Job Object; Lane A adds no native helper or dependency. Windows has now run natively, which does not change that boundary.
- Subprocess timeout/output caps for every `ps`/PowerShell/codesign/lipo helper and generated renderer total-size ceilings remain defense-in-depth follow-ups. Current processes are bounded by the outer workflow timeout and exact/extension-constrained inventory, but those are not equivalent controls.

Evidence grade for the Lane A static path is E3 on current macOS arm64 only. The separate #111/#119 behavior qualification is also a local macOS fixture result, not a Lane A release, entitlement, or live-Host claim. No cross-platform or installable-release claim is inferred from either result.

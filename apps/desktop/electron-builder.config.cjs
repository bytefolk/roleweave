const { RUNTIME_FILE_SETS } = require("./packaging/runtime-layout.cjs");
const path = require("node:path");

const ROLEWEAVE_ICONS = path.resolve(__dirname, "..", "..", "branding", "roleweave", "platform-icons");

// Lane A (staging) remains deliberately unsigned. The release workflow opts
// into this branch only after it has imported an ephemeral Developer ID
// certificate and validated the Apple notarization credentials.
const macSignedBuild = process.env.OWB_MAC_SIGNED_BUILD === "true";
const macSigning = macSignedBuild
  ? {
      hardenedRuntime: true,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.inherit.plist",
      forceCodeSigning: true,
      afterSign: "scripts/notarize-macos.cjs",
    }
  : { identity: null };

module.exports = {
  appId: "org.fullstack-ai-infra.org-workbench",
  productName: "RoleWeave",
  directories: {
    output: "release/staging",
  },
  asar: false,
  // npm ci materializes the checksum-verified, platform-native Electron dist.
  // Native CI jobs reuse it and never ask builder to fetch another Electron.
  electronDist: "node_modules/electron/dist",
  npmRebuild: false,
  extraMetadata: {
    main: "apps/desktop/src/main.js",
  },
  files: RUNTIME_FILE_SETS,
  // Pinned so the asset-set validator can name what it expects rather than
  // pattern-match. `name` rather than `productName`: the product name contains a
  // space, and a space in an artifact filename has already cost this lane one
  // round of Windows shell defects.
  artifactName: "${name}-${version}-${arch}.${ext}",
  mac: {
    category: "public.app-category.developer-tools",
    icon: path.join(ROLEWEAVE_ICONS, "roleweave.icns"),
    ...macSigning,
  },
  // Lane A is deterministic unsigned staging even when an operator shell has
  // CSC_LINK/WIN_CSC_LINK. Keep PE metadata editing, but never enter signing.
  win: {
    icon: path.join(ROLEWEAVE_ICONS, "roleweave.ico"),
    signExecutable: false,
  },
  linux: {
    icon: path.join(ROLEWEAVE_ICONS, "roleweave.png"),
  },
  // No publish provider here, deliberately. A provider makes electron-builder
  // write `app-update.yml` into the packaged resources, and that file would then
  // appear in the staging tree, which asserts its contents byte-exact against
  // source. The update feed is declared on the dist commands instead -- the only
  // ones that produce an artifact anybody updates from.
  nsis: {
    // Strictly per-user install. Assisted mode exposes an all-users choice and
    // can elevate; one-click mode with perMachine=false keeps this unsigned lane
    // out of that path. Installation-directory choice is intentionally disabled
    // because electron-builder only supports it for assisted installers.
    oneClick: true,
    perMachine: false,
  },
};

const { createBridgeChannel } = require("./workbuddy-bridge.cjs");

// This carries native task status/results, never an Office account credential.
module.exports = createBridgeChannel({ name: "qwen-office", errorPrefix: "qwen_office", timeoutMs: 180_000, progress: true });

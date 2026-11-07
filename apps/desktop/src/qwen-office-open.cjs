// The installed Windows client registers this scheme through its updater
// launcher, so updates and custom installation directories remain supported.
// No renderer-provided URL, path, command, or argument is accepted.
async function openQwenOffice({ event, isTrusted, openExternal, platform = process.platform }) {
  if (!isTrusted(event)) return { opened: false, reason: "untrusted_sender" };
  if (platform !== "win32") return { opened: false, reason: "platform_unavailable" };
  try {
    await openExternal("qwenwork-cn://");
    return { opened: true };
  } catch {
    return { opened: false, reason: "client_unavailable" };
  }
}

module.exports = { openQwenOffice };

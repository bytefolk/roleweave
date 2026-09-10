// @ts-check

/*
 * Windows refuses to exec a `.bat`/`.cmd` launcher without a shell, and #125
 * settled how this repo answers that: build the whole command line, escape it
 * explicitly, and hand it to cmd.exe as one verbatim argument with
 * `shell: false`, so prompt metacharacters remain argv data instead of
 * becoming shell commands.
 *
 * This lived inside bin/qoder-engine.mjs until the #221 review found the Codex
 * version probe in routes/health.ts had reintroduced `shell: true` on an
 * env-derived path. Reimplementing the construction there dropped
 * `windowsVerbatimArguments`, which silently re-quotes the escaped command
 * line — exactly the class of mistake that argues for one implementation. Both
 * callers now share this module.
 *
 * The CMD escaping below is adapted from cross-spawn 7.0.6
 * (MIT; Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>):
 * https://github.com/moxystudio/node-cross-spawn
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions: the
 * above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
 * "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 * PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * The escaping stays local rather than adding a third-party runtime dependency
 * just for launcher scripts; qoder-engine is a standalone packaged entrypoint.
 */
const WINDOWS_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
const WINDOWS_CMD_SHIM_PATTERN = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/** @param {string} value @returns {string} */
function escapeWindowsCommand(value) {
  return String(value).replace(WINDOWS_CMD_META_CHARS, "^$1");
}

/** @param {string} value @param {boolean} [doubleEscapeMetaChars] @returns {string} */
function escapeWindowsArgument(value, doubleEscapeMetaChars = false) {
  let argument = String(value);
  argument = argument.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  argument = argument.replace(/(?=(\\+?)?)\1$/g, "$1$1");
  argument = `"${argument}"`;
  argument = argument.replace(WINDOWS_CMD_META_CHARS, "^$1");
  if (doubleEscapeMetaChars) argument = argument.replace(WINDOWS_CMD_META_CHARS, "^$1");
  return argument;
}

/**
 * True when Node cannot exec this target without a shell.
 *
 * @param {string} command
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isWindowsLauncher(command, platform = process.platform) {
  return platform === "win32" && /\.(bat|cmd)$/i.test(command);
}

/**
 * Build a child_process spawn spec without passing raw input to Node's shell
 * option. A Windows batch launcher still requires cmd.exe, so the entire
 * command line is escaped and handed over as one verbatim /c argument.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 * @returns {{ command: string, args: string[], options: Record<string, unknown> }}
 */
export function createLauncherSpawnSpec(command, args, env, platform = process.platform) {
  if (!isWindowsLauncher(command, platform)) {
    return { command, args, options: { env, shell: false } };
  }

  const commandText = escapeWindowsCommand(command);
  const doubleEscapeMetaChars = WINDOWS_CMD_SHIM_PATTERN.test(command);
  const shellCommand = [commandText, ...args.map((arg) => escapeWindowsArgument(arg, doubleEscapeMetaChars))].join(" ");
  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    options: {
      env,
      shell: false,
      // Without this Node re-quotes the escaped command line and the escaping
      // above stops meaning anything.
      windowsVerbatimArguments: true,
    },
  };
}

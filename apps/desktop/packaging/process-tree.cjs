const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Windows PowerShell invocation is routed through this helper for three reasons,
// each of which has produced a CI failure or is one argv entry away from doing so:
//
//  * `-Command` does not bind trailing argv entries to a `param()` block. It appends
//    them to the script text, so a parameter is parsed as source — and any value with
//    a space (a packaged path) or a quote breaks the parse. Values travel in the
//    environment instead, where no quoting rules apply.
//  * The script text itself carries quotes and parentheses that Windows command-line
//    escaping mangles. `-EncodedCommand` takes base64 UTF-16LE and bypasses that layer
//    completely.
//  * CI runs these steps under pwsh 7, which exports a PSModulePath covering only
//    PowerShell 7 modules. Inheriting it leaves Windows PowerShell unable to autoload
//    its own system modules (CimCmdlets, Microsoft.PowerShell.Security), so the pinned
//    path below keeps the child independent of whichever shell invoked it.
function windowsPowerShellInvocation(script, values = {}, baseEnv = process.env) {
  const systemRoot = baseEnv.SystemRoot ?? baseEnv.SYSTEMROOT ?? "C:\\Windows";
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    env: {
      ...baseEnv,
      PSModulePath: path.win32.join(systemRoot, "system32", "WindowsPowerShell", "v1.0", "Modules"),
      ...values,
    },
  };
}

function windowsPowerShell(script, values = {}) {
  const { command, args, env } = windowsPowerShellInvocation(script, values);
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true, env });
}

function descendantProcesses(processes, rootPid, { nativePlatform = process.platform } = {}) {
  // Windows keeps the original ParentProcessId after a parent exits. If that
  // PID is reused, an older, unrelated tree can appear below the new process.
  // Validate every edge against CIM creation ticks, including intermediate
  // parents. Keep them as BigInts: .NET ticks exceed Number's exact range.
  const creationTimes = nativePlatform === "win32"
    ? new Map(processes.map(({ pid, startTime }) => [
      pid,
      typeof startTime === "string" && /^\d+$/.test(startTime) ? BigInt(startTime) : null,
    ]))
    : null;
  const result = [];
  const pending = [rootPid];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const parent = pending.shift();
    for (const processInfo of processes) {
      if (processInfo.ppid !== parent || seen.has(processInfo.pid)) continue;
      if (creationTimes !== null) {
        const parentStart = creationTimes.get(parent);
        const childStart = creationTimes.get(processInfo.pid);
        if (typeof parentStart !== "bigint" || typeof childStart !== "bigint" || childStart < parentStart) continue;
      }
      seen.add(processInfo.pid);
      pending.push(processInfo.pid);
      result.push(processInfo);
    }
  }
  return result;
}

function normalizedCommand(value) {
  const normalized = path.normalize(String(value ?? ""));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function identityCoreMatches(expected, current) {
  if (!expected || !current || expected.pid !== current.pid) return false;
  if (typeof expected.startTime !== "string" || expected.startTime.length === 0) return false;
  if (expected.startTime !== current.startTime) return false;
  if (Number.isInteger(expected.pgid) && expected.pgid !== current.pgid) return false;
  return true;
}

function sameProcessIdentity(expected, current) {
  return identityCoreMatches(expected, current) &&
    typeof expected.executable === "string" &&
    expected.executable.length > 0 &&
    normalizedCommand(expected.executable) === normalizedCommand(current.executable) &&
    (expected.handleStartTime === undefined || expected.handleStartTime === current.handleStartTime);
}

function residualProcesses(processes, { stagingRoot, trackedProcesses = [], processGroup = null }) {
  return processes.filter((processInfo) => (
    trackedProcesses.some((identity) => identityCoreMatches(identity, processInfo)) ||
    (Number.isInteger(processGroup) && processInfo.pgid === processGroup)
  ));
}

function parsePosixProcesses(output) {
  const processes = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      pgid: Number.parseInt(match[3], 10),
      startTime: `${match[4]} ${match[5]} ${match[6]} ${match[7]} ${match[8]}`,
      command: match[9],
    });
  }
  return processes;
}

function listPosixProcesses(pid = null) {
  const args = pid === null
    ? ["-axo", "pid=,ppid=,pgid=,lstart=,command="]
    : ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart=,command="];
  const listed = spawnSync("/bin/ps", args, { encoding: "utf8" });
  if (listed.status !== 0) {
    if (pid !== null && listed.status === 1) return [];
    throw new Error(`ps failed: ${listed.stderr ?? "unknown error"}`);
  }
  return parsePosixProcesses(listed.stdout);
}

// Script text is kept at module scope so the parse guard in the test suite can
// check exactly what ships, rather than a re-typed copy of it. Each entry is a
// standalone statement, so they are newline-joined: run together on one line the
// parser sees `$a = 1 $b = 2` and rejects the whole script. -EncodedCommand is
// what makes the newlines safe to transport.
const INVENTORY_SCRIPT = [
  "@(",
  "Get-CimInstance Win32_Process |",
  "Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath,",
  "@{Name='StartIdentity';Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}}",
  ") | ConvertTo-Json -Compress",
].join("\n");

const IDENTITY_SCRIPT = [
  "$TargetPid = [int]$env:OWB_TARGET_PID",
  "$cim = Get-CimInstance Win32_Process -Filter \"ProcessId=$TargetPid\"",
  "if ($null -eq $cim) { exit 3 }",
  "try { $process = [Diagnostics.Process]::GetProcessById($TargetPid) } catch { exit 3 }",
  "[pscustomobject]@{",
  "ProcessId=$cim.ProcessId; ParentProcessId=$cim.ParentProcessId;",
  "StartIdentity=$cim.CreationDate.ToUniversalTime().Ticks.ToString();",
  "HandleStartIdentity=$process.StartTime.ToUniversalTime().Ticks.ToString();",
  "ExecutablePath=$process.MainModule.FileName; CommandLine=$cim.CommandLine",
  "} | ConvertTo-Json -Compress",
].join("\n");

const IDENTITIES_SCRIPT = [
  "$targets = @($env:OWB_TARGET_PIDS -split ',' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ })",
  "$rows = @()",
  "if ($targets.Count -gt 0) {",
  "  $filter = ($targets | ForEach-Object { \"ProcessId=$_\" }) -join ' or '",
  "  $index = @{}",
  "  foreach ($entry in @(Get-CimInstance Win32_Process -Filter $filter)) { $index[[int]$entry.ProcessId] = $entry }",
  "  foreach ($target in $targets) {",
  "    $cim = $index[$target]",
  "    if ($null -eq $cim) { continue }",
  "    try { $process = [Diagnostics.Process]::GetProcessById($target) } catch { continue }",
  "    try {",
  "      $rows += [pscustomobject]@{",
  "        ProcessId=$cim.ProcessId",
  "        ParentProcessId=$cim.ParentProcessId",
  "        StartIdentity=$cim.CreationDate.ToUniversalTime().Ticks.ToString()",
  "        HandleStartIdentity=$process.StartTime.ToUniversalTime().Ticks.ToString()",
  "        ExecutablePath=$process.MainModule.FileName",
  "        CommandLine=$cim.CommandLine",
  "      }",
  "    } catch { continue }",
  "  }",
  "}",
  "$rows | ConvertTo-Json -Compress",
].join("\n");

const TERMINATE_SCRIPT = [
  "$TargetPid = [int]$env:OWB_TARGET_PID",
  "$HandleStart = [string]$env:OWB_HANDLE_START",
  "$Executable = [string]$env:OWB_EXECUTABLE",
  "try { $process = [Diagnostics.Process]::GetProcessById($TargetPid) } catch { exit 3 }",
  "if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $HandleStart) { exit 4 }",
  "if (-not [StringComparer]::OrdinalIgnoreCase.Equals($process.MainModule.FileName,$Executable)) { exit 4 }",
  "$process.Kill(); if (-not $process.WaitForExit(5000)) { exit 5 }",
].join("\n");

function listWindowsProcesses() {
  const script = INVENTORY_SCRIPT;
  const listed = windowsPowerShell(script);
  if (listed.status !== 0) throw new Error(`process inventory failed: ${listed.stderr ?? "unknown error"}`);
  const rows = JSON.parse(listed.stdout || "[]");
  return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    pgid: null,
    startTime: String(row.StartIdentity ?? ""),
    executable: String(row.ExecutablePath ?? ""),
    command: String(row.CommandLine ?? ""),
  }));
}

function listNativeProcesses() {
  return process.platform === "win32" ? listWindowsProcesses() : listPosixProcesses();
}

function readPosixExecutable(pid) {
  const listed = spawnSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
  if (listed.status !== 0) return null;
  const executable = listed.stdout.trim();
  return executable.length > 0 ? executable : null;
}

function readWindowsBoundIdentity(pid) {
  const script = IDENTITY_SCRIPT;
  const result = windowsPowerShell(script, { OWB_TARGET_PID: String(pid) });
  if (result.status === 3) return null;
  if (result.status !== 0) throw new Error(`process identity failed: ${result.stderr ?? "unknown error"}`);
  return boundIdentityFromRow(JSON.parse(result.stdout));
}

function boundIdentityFromRow(row) {
  return {
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    pgid: null,
    startTime: String(row.StartIdentity),
    handleStartTime: String(row.HandleStartIdentity),
    executable: String(row.ExecutablePath),
    command: String(row.CommandLine ?? ""),
  };
}

/**
 * Bind a whole set of pids in one shell round trip.
 *
 * The per-pid path costs a PowerShell start plus a filtered CIM query each, so a
 * snapshot of an Electron tree ran to several seconds -- longer than the window the
 * packaged app holds itself open for the external oracle. One filtered query covers
 * every target instead. Nothing about the identity is weakened: CreationDate is still
 * read fresh from CIM at bind time, and HandleStartIdentity still comes from an open
 * .NET handle, only now from a single process rather than one per pid.
 */
function readWindowsBoundIdentities(pids) {
  if (pids.length === 0) return [];
  const result = windowsPowerShell(IDENTITIES_SCRIPT, { OWB_TARGET_PIDS: pids.join(",") });
  if (result.status !== 0) {
    throw new Error(`process identity batch failed: ${result.stderr ?? "unknown error"}`);
  }
  const parsed = JSON.parse(result.stdout || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map(boundIdentityFromRow);
}

/**
 * Batch form of bindNativeProcessIdentity. Same acceptance rule per process -- an
 * entry survives only when the freshly read identity still matches what the caller
 * observed -- applied across the set.
 */
function bindNativeProcessIdentities(processInfos) {
  const candidates = processInfos.filter(
    (processInfo) => processInfo && Number.isInteger(processInfo.pid) && processInfo.pid > 1,
  );
  if (process.platform !== "win32") {
    return candidates.map((processInfo) => bindNativeProcessIdentity(processInfo)).filter((identity) => identity !== null);
  }
  const bound = new Map();
  for (const identity of readWindowsBoundIdentities(candidates.map(({ pid }) => pid))) {
    bound.set(identity.pid, identity);
  }
  const identities = [];
  for (const processInfo of candidates) {
    const identity = bound.get(processInfo.pid);
    if (identity !== undefined && identityCoreMatches(processInfo, identity)) identities.push(identity);
  }
  return identities;
}

function bindNativeProcessIdentity(processInfo) {
  if (!processInfo || !Number.isInteger(processInfo.pid) || processInfo.pid <= 1) return null;
  if (process.platform === "win32") {
    const identity = readWindowsBoundIdentity(processInfo.pid);
    return identity !== null && identityCoreMatches(processInfo, identity) ? identity : null;
  }

  const before = listPosixProcesses(processInfo.pid)[0];
  if (!identityCoreMatches(processInfo, before)) return null;
  const executable = readPosixExecutable(processInfo.pid);
  if (executable === null) return null;
  const after = listPosixProcesses(processInfo.pid)[0];
  if (!identityCoreMatches(before, after)) return null;
  return { ...after, executable };
}

function currentBoundIdentity(expected) {
  if (!expected || !Number.isInteger(expected.pid)) return null;
  const inventory = process.platform === "win32"
    ? listWindowsProcesses()
    : listPosixProcesses(expected.pid);
  const current = inventory.find(({ pid }) => pid === expected.pid);
  if (!identityCoreMatches(expected, current)) return null;
  const bound = bindNativeProcessIdentity(current);
  return bound !== null && sameProcessIdentity(expected, bound) ? bound : null;
}

async function waitForBoundProcessIdentity(pid, { timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error("cannot bind an invalid process id");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processInfo = listNativeProcesses().find((entry) => entry.pid === pid);
    if (processInfo) {
      const identity = bindNativeProcessIdentity(processInfo);
      if (identity !== null) return identity;
    }
    await delay(25);
  }
  throw new Error(`could not bind stable identity for spawned process ${pid}`);
}

function terminateBoundWindowsProcess(identity) {
  const script = TERMINATE_SCRIPT;
  const killed = windowsPowerShell(script, {
    OWB_TARGET_PID: String(identity.pid),
    OWB_HANDLE_START: identity.handleStartTime,
    OWB_EXECUTABLE: identity.executable,
  });
  if (killed.status === 3 || killed.status === 4) return false;
  if (killed.status !== 0) throw new Error(`bound process termination failed: ${killed.stderr ?? killed.status}`);
  return true;
}

function signalBoundProcess(identity, signal) {
  const current = currentBoundIdentity(identity);
  if (current === null) return false;
  if (process.platform === "win32") return terminateBoundWindowsProcess(current);
  try {
    process.kill(current.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function identityKey(identity) {
  return `${identity.pid}:${identity.startTime}:${identity.executable}`;
}

function spawnOriginGenerationIsAmbiguous(inventory, rootIdentity, originPid) {
  if (!Number.isInteger(originPid)) return false;
  const currentOrigin = inventory.find(({ pid }) => pid === originPid) ?? null;
  if (currentOrigin === null) return false;
  return rootIdentity === null || !identityCoreMatches(rootIdentity, currentOrigin);
}

function selectCleanupCandidates(
  inventory,
  {
    rootIdentity = null,
    stagingRoot,
    knownIdentities = [],
    originPid = null,
    processGroup = null,
    nativePlatform = process.platform,
  },
) {
  const currentRoot = rootIdentity === null
    ? null
    : inventory.find((processInfo) => identityCoreMatches(rootIdentity, processInfo)) ?? null;
  const descendantPids = new Set(
    currentRoot === null
      ? []
      : descendantProcesses(inventory, currentRoot.pid, { nativePlatform }).map(({ pid }) => pid),
  );
  const ambiguousOrigin = spawnOriginGenerationIsAmbiguous(
    inventory,
    rootIdentity,
    originPid,
  );
  return inventory.filter((processInfo) => (
    (currentRoot !== null && processInfo === currentRoot) ||
    descendantPids.has(processInfo.pid) ||
    (nativePlatform !== "win32" &&
      Number.isInteger(processGroup) &&
      !ambiguousOrigin &&
      processInfo.pgid === processGroup) ||
    knownIdentities.some((identity) => identityCoreMatches(identity, processInfo))
  ));
}

function collectBoundTree(rootIdentity, stagingRoot, known, provenance = {}) {
  const inventory = listNativeProcesses();
  const requireVerifiedRoot = provenance.requireVerifiedRoot === true;
  if (spawnOriginGenerationIsAmbiguous(inventory, rootIdentity, provenance.originPid)) {
    throw new Error("refusing cleanup because spawn origin PID is unbound or has been reused");
  }
  const currentRoot = rootIdentity === null
    ? null
    : inventory.find((processInfo) => identityCoreMatches(rootIdentity, processInfo)) ?? null;
  if (requireVerifiedRoot && process.platform === "win32" && rootIdentity !== null && currentRoot === null) {
    throw new Error("refusing Windows cleanup because the bound root is no longer current");
  }
  if (requireVerifiedRoot && currentRoot !== null) {
    const verifiedRoot = bindNativeProcessIdentity(currentRoot);
    if (verifiedRoot === null || !sameProcessIdentity(rootIdentity, verifiedRoot)) {
      throw new Error("refusing cleanup because the root process identity changed");
    }
  }
  const candidates = selectCleanupCandidates(inventory, {
    rootIdentity,
    stagingRoot,
    knownIdentities: [...known.values()],
    originPid: provenance.originPid,
    processGroup: provenance.processGroup,
  });
  for (const processInfo of candidates) {
    const identity = bindNativeProcessIdentity(processInfo);
    if (identity !== null) {
      const expectedIdentity = [rootIdentity, ...known.values()]
        .find((expected) => identityCoreMatches(expected, processInfo));
      if (expectedIdentity !== undefined && !sameProcessIdentity(expectedIdentity, identity)) {
        if (requireVerifiedRoot) {
          throw new Error(`refusing cleanup because process identity ${processInfo.pid} changed`);
        }
        // It may be a short-lived POSIX zombie, or the same generation may
        // have exec'd. Either way the old bound identity has no signal
        // authority. Leave it un-signalled; the identity/group residual oracle
        // must observe it disappear or fail the cleanup.
        continue;
      }
      known.set(identityKey(identity), identity);
      continue;
    }
    const expectedIdentity = [rootIdentity, ...known.values()]
      .find((expected) => identityCoreMatches(expected, processInfo));
    if (!requireVerifiedRoot && expectedIdentity !== undefined) continue;
    const stillPresent = listNativeProcesses().find((current) => identityCoreMatches(processInfo, current));
    if (stillPresent) {
      throw new Error(`refusing cleanup because process identity ${processInfo.pid} is denied or ambiguous`);
    }
  }
  return inventory;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForNoResidualProcesses(
  stagingRoot,
  trackedProcesses,
  { timeoutMs = 10000, processGroup = null } = {},
) {
  if (!Array.isArray(trackedProcesses) || trackedProcesses.some((identity) => (
    !identity || typeof identity !== "object" || !Number.isInteger(identity.pid) ||
    typeof identity.startTime !== "string"
  ))) {
    throw new Error("tracked process identities must be bound objects, never raw PIDs");
  }
  const deadline = Date.now() + timeoutMs;
  let residual = [];
  while (Date.now() < deadline) {
    residual = residualProcesses(listNativeProcesses(), {
      stagingRoot,
      trackedProcesses,
      processGroup,
    });
    if (residual.length === 0) return;
    await delay(100);
  }
  throw new Error(`staged process tree did not exit: ${residual.map(({ pid }) => pid).join(",")}`);
}

async function terminateNativeProcessTree(rootIdentity, stagingRoot, provenance = {}) {
  if (
    rootIdentity !== null &&
    (!rootIdentity || typeof rootIdentity !== "object" || !Number.isInteger(rootIdentity.pid) ||
      typeof rootIdentity.startTime !== "string" || typeof rootIdentity.executable !== "string")
  ) {
    throw new Error("root process must be a bound identity, never a raw PID");
  }
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    (provenance.originPid !== undefined &&
      (!Number.isInteger(provenance.originPid) || provenance.originPid <= 1)) ||
    (provenance.processGroup !== undefined && provenance.processGroup !== null &&
      (!Number.isInteger(provenance.processGroup) || provenance.processGroup <= 1))
  ) {
    throw new Error("spawn provenance must contain only validated origin/group identifiers");
  }
  const originPid = provenance.originPid ?? rootIdentity?.pid ?? null;
  const processGroup = process.platform === "win32"
    ? null
    : provenance.processGroup ?? rootIdentity?.pgid ?? null;
  if (rootIdentity === null && originPid === null && processGroup === null) {
    throw new Error("cleanup requires a bound root identity or spawn provenance");
  }
  if (process.platform === "win32" && rootIdentity === null) {
    throw new Error("Windows cleanup requires a bound root identity; raw spawn provenance cannot prove ownership");
  }
  if (rootIdentity !== null && originPid !== rootIdentity.pid) {
    throw new Error("spawn origin PID does not match the bound root identity");
  }
  if (process.platform !== "win32" && processGroup !== originPid) {
    throw new Error("POSIX spawn provenance must name the detached leader's own process group");
  }
  if (rootIdentity !== null && process.platform !== "win32" && rootIdentity.pgid !== processGroup) {
    throw new Error("refusing to clean a POSIX process that does not own an isolated process group");
  }
  const boundedProvenance = { originPid, processGroup };
  const known = new Map();
  if (rootIdentity) known.set(identityKey(rootIdentity), rootIdentity);
  collectBoundTree(rootIdentity, stagingRoot, known, {
    ...boundedProvenance,
    requireVerifiedRoot: true,
  });

  if (process.platform === "win32") {
    // Re-enumerate after each forced-kill wave. Windows has no POSIX TERM
    // handler, but a concurrently spawning descendant can appear after the
    // first inventory and keeps its original ParentProcessId after reparenting.
    let stableEmptyInventories = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      collectBoundTree(rootIdentity, stagingRoot, known, boundedProvenance);
      for (const identity of [...known.values()].reverse()) signalBoundProcess(identity, "SIGKILL");
      await delay(50);
      const residual = residualProcesses(listNativeProcesses(), {
        stagingRoot,
        trackedProcesses: [...known.values()],
      });
      stableEmptyInventories = residual.length === 0 ? stableEmptyInventories + 1 : 0;
      if (stableEmptyInventories >= 3) return;
    }
    throw new Error("Windows staged process tree did not reach three stable empty inventories");
  }

  for (const identity of [...known.values()].reverse()) signalBoundProcess(identity, "SIGTERM");

  // A TERM handler can spawn and reparent a child whose argv does not contain
  // the staging root. The isolated process group is the provenance boundary;
  // bind every newly observed member before any subsequent signal.
  const collectDeadline = Date.now() + 750;
  while (Date.now() < collectDeadline) {
    await delay(50);
    collectBoundTree(rootIdentity, stagingRoot, known, boundedProvenance);
  }

  for (const identity of [...known.values()].reverse()) signalBoundProcess(identity, "SIGKILL");
  collectBoundTree(rootIdentity, stagingRoot, known, boundedProvenance);
  for (const identity of [...known.values()].reverse()) signalBoundProcess(identity, "SIGKILL");
  await waitForNoResidualProcesses(stagingRoot, [...known.values()], {
    timeoutMs: 5000,
    processGroup,
  });
}

module.exports = {
  WINDOWS_POWERSHELL_SCRIPTS: {
    inventory: INVENTORY_SCRIPT,
    identity: IDENTITY_SCRIPT,
    identities: IDENTITIES_SCRIPT,
    terminate: TERMINATE_SCRIPT,
  },
  bindNativeProcessIdentity,
  bindNativeProcessIdentities,
  windowsPowerShellInvocation,
  descendantProcesses,
  listNativeProcesses,
  parsePosixProcesses,
  residualProcesses,
  sameProcessIdentity,
  selectCleanupCandidates,
  signalBoundProcess,
  terminateNativeProcessTree,
  waitForBoundProcessIdentity,
  waitForNoResidualProcesses,
};

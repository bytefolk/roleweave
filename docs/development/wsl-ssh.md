# Driving a WSL workspace over SSH

RoleWeave's Windows shell reaches its control plane through `wsl.exe` (see
[the control-plane lifecycle](../design/control-plane-lifecycle-v1.md)). That
path is automatic and stays unchanged. This page covers a different, optional
convenience: a **passwordless SSH login from Windows into the local WSL
distribution**, so a human or a script can work inside the Linux workspace with
ordinary `ssh`, `scp`, and `rsync` instead of wrapping every command in
`wsl.exe --exec`.

Nothing here changes how the application runs. It is a developer-environment
helper for operators who keep their workspace (for example
`~/data/<org>`) inside WSL and want a native Linux shell on it.

## Why SSH instead of `wsl.exe`

| Aspect | `wsl.exe --exec` | SSH into the distribution |
| --- | --- | --- |
| Invocation | One Windows process per command | One persistent session, many commands |
| Tooling | Quoting and path translation per call | Native POSIX tools (`ssh`, `scp`, `rsync`, `git push` over a host) |
| File transfer | UNC paths (`\\wsl.localhost\...`) | `scp` / `rsync`, resumable and scriptable |
| Editing | Windows editors over 9p | Linux-native tooling inside the distro |
| Availability | Ships with WSL | Requires `sshd` in the distribution |

`wsl.exe` remains the right transport for the application itself: it needs no
daemon and works on a fresh machine. SSH suits interactive and scripted
operator work where a real Linux environment is easier.

## Prerequisites

- Windows 10/11 with WSL2, and a distribution with `openssh-server` installed.
- The Linux user's login shell is Bash or Zsh (the launcher already supports
  these; SSH does not care, but keep one shell for a predictable PATH).
- Nothing in this guide needs Administrator rights beyond what `sshd` itself
  requires.

## One-command setup

From Windows, in the repository checkout:

```powershell
node scripts/setup-wsl-ssh.mjs
```

The helper:

1. detects the WSL distribution and its default user (override with
   `--distro` and `--user`),
2. reuses `%USERPROFILE%\.ssh\id_ed25519` or generates an ed25519 key pair,
3. appends the **public** key to the distribution's
   `~/.ssh/authorized_keys` (idempotent; it never rewrites other keys),
4. writes a managed `Host` block into `%USERPROFILE%\.ssh\config`,
5. verifies the login and prints the result.

Useful flags:

```
--distro <name>   WSL distribution (auto-detected when omitted)
--user <name>     Linux user in the distribution
--host <alias>    ssh_config Host alias to write (default: wsl)
--key <name>      Key file name under ~/.ssh (default: id_ed25519)
--port <n>        SSH port (default: 22)
--dry-run         Print the plan; write nothing
--check           Verify the current login only
--force-key       Generate a new key pair even if one exists
```

After it succeeds:

```bash
ssh wsl                # opens a shell in the distribution
ssh wsl 'ls ~/data'    # runs one remote command
scp file.txt wsl:~/data/        # copy into the workspace
rsync -av ./dir/ wsl:~/data/dir/
```

## What is written, and where

| Path | Side | Purpose |
| --- | --- | --- |
| `%USERPROFILE%\.ssh\id_ed25519` | Windows | Private key. **Never leaves the Windows host.** |
| `%USERPROFILE%\.ssh\id_ed25519.pub` | Windows | Public key copied into the distribution. |
| `~/.ssh/authorized_keys` | WSL | Receives the public key (mode `600`, `~/.ssh` mode `700`). |
| `%USERPROFILE%\.ssh\config` | Windows | A managed block fenced by `# >>> roleweave wsl ssh >>>` / `# <<< roleweave wsl ssh <<<`. |

Only the public key crosses into the distribution. The private key is read
exclusively by the Windows OpenSSH client. The helper never prints, copies, or
commits key material, and the managed config block refers to the key by path.

## Start `sshd` in the distribution

Some distributions do not start `sshd` automatically. Inside the distribution:

```bash
sudo apt-get install -y openssh-server
sudo service ssh start
```

To keep it running across `wsl --shutdown`, enable the service:

```bash
sudo systemctl enable --now ssh    # on systemd-enabled distributions
```

## Verify

```powershell
node scripts/setup-wsl-ssh.mjs --check
ssh -o BatchMode=yes wsl 'echo OK; id -un; uname -sr'
```

A working setup prints the Linux user and kernel without prompting for a
password. `BatchMode=yes` makes the check fail loudly if a password would be
required, which is what CI and scripts want.

## Troubleshooting

- **`Permission denied (publickey,password)`** — the key is not in
  `authorized_keys`, or `~/.ssh` / `authorized_keys` have loose permissions.
  Re-run the helper; it fixes both modes. Check with
  `ssh -v wsl` and look for which identity was offered.
- **`wsl.exe` blocked by a security policy** — some managed Windows hosts
  blacklist `wsl.exe` for automated processes. Run the helper from an
  interactive terminal, or perform step 3 manually: append the contents of
  `%USERPROFILE%\.ssh\id_ed25519.pub` to `~/.ssh/authorized_keys` inside the
  distribution.
- **Connection refused on `127.0.0.1:22`** — `sshd` is not listening. Start it
  as shown above; confirm with `ss -tlnp | grep :22` inside the distribution.
- **Wrong user or distro** — pass `--distro` and `--user` explicitly; the
  auto-detection picks the first installed distribution and its default user.
- **Key already exists but login still fails** — the existing key may not be
  the one in `authorized_keys`. Re-run the helper (it installs the current
  public key), or use `--force-key` to rotate deliberately.

## Removing the setup

Delete the fenced block from `%USERPROFILE%\.ssh\config` and remove the matching
line from `~/.ssh/authorized_keys` in the distribution. No other state is
written.

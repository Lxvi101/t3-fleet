# t3-fleet

A live map of every agent across all your [T3 Code](https://github.com/pingdotgg/t3code) machines. It shows
which agents are running, what each one is doing right now, the subagents it spawned, which ones need you,
and how much usage you have left on each provider.

It is **read-only** and runs **beside** T3 Code. It never modifies T3 Code, needs no fork or plugin, and
keeps working as T3 Code updates.

```sh
curl -fsSL https://raw.githubusercontent.com/Lxvi101/t3-fleet/main/install.sh | sh
```

The installer installs Bun if needed and connects to the T3 Code server on this machine with a read-only
token. It then starts in the background at **http://127.0.0.1:4777**. It runs on macOS (launchd) and Linux
(systemd user service).

## Add your other machines

```sh
t3-fleet add macmini http://100.64.0.12:3773 --ssh macmini
```

With `--ssh`, the read-only token is minted on that machine for you. Without it, run this on the remote
machine and paste the token when asked:

```sh
t3 auth session issue --scope orchestration:read --label fleet-monitor --ttl 365d --token-only
```

The remote server has to be reachable from this machine, for example over Tailscale or your LAN.

## What you see

- **Usage left**: for every provider account, the share of each limit window that remains (Claude's
  session and weekly limits, Codex's weekly limit, …) and when it resets. Accounts shared by several
  machines are shown once.
- **Map**: each machine is a hub. Its agents branch off it as cards, and subagents branch off their
  parent. Each card shows what the agent is doing right now (running a command, editing a file,
  running tests, thinking), plus its project, branch and elapsed time. Agents that need your approval or
  input turn pink. Finished agents fold their subagents into a badge; click it to expand them.
- **List**: the same information as rows, grouped by machine and project.
- **Activity**: a feed across all machines: agents starting and finishing, commands, edits, test results,
  failures and spawned subagents.

Click any agent for its details: where it runs, its prompt, result and recent timeline.

Some states are deliberately cautious, so the dashboard never guesses:

- **live**: the provider is reporting that activity right now.
- **last · 3m ago**: the last observed activity.
- **Unknown** (dashed): a subagent still claims to be running after its parent stopped.
- **stale**: the machine is unreachable, and the values shown are the last ones received.

## Commands

```
t3-fleet open        open the dashboard
t3-fleet add …       add a machine
t3-fleet setup       (re)connect this machine's T3 Code server
t3-fleet servers     list configured machines
t3-fleet logs        follow the log
t3-fleet restart     restart the background service
t3-fleet update      pull the latest version
t3-fleet uninstall   remove it (your config stays in ~/.config/t3-fleet)
```

## How it works

For each server, t3-fleet reads the public descriptor and checks the orchestration protocol version. It
then exchanges its `orchestration:read` token for a short-lived WebSocket ticket and subscribes to the same
streams the T3 Code app uses:

- `orchestration.subscribeShell`: every project and thread (status, lineage, branch, worktree).
- `orchestration.subscribeThread`: only for threads that are working, just finished, or open in the
  dashboard. This stream supplies live activity and subagents.
- `subscribeServerConfig`: provider status and usage limits.

Tokens never reach the browser. They stay in `~/.config/t3-fleet/` with mode 600. To revoke one, run
`t3 auth session list` and then `t3 auth session revoke <id>` on that machine.

The dashboard listens on 127.0.0.1 only. To expose it, set `FLEET_HOST` and `FLEET_ACCESS_TOKEN`;
without an access token it refuses to start on a public address.

### When T3 Code changes

Everything that knows T3 Code's wire format lives in [`src/t3/adapter.ts`](src/t3/adapter.ts). Unknown
fields, events and item types are skipped. A server that advertises an orchestration protocol version
this build doesn't support shows as `incompatible` rather than being misread.

## Development

```sh
bun install          # dev types only; there are no runtime dependencies
bun run dev          # restarts on change
bun test
bun run typecheck
```

Configuration is in `~/.config/t3-fleet/config.json`; see
[`fleet.config.example.json`](fleet.config.example.json). Open `/?poll` to use polling instead of
Server-Sent Events, for proxies or headless browsers.

## License

MIT

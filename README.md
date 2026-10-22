# t3-fleet

A live map of every agent across all your [T3 Code](https://github.com/pingdotgg/t3code) machines. It shows
which agents are running, what each one is doing right now, the subagents it spawned, which ones need you,
and how much usage you have left on each provider. A small watcher agent alerts you only when a thread
really needs you, and an MCP server lets any of your agents ask about the fleet.

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

- **Usage left**: one ring per provider account in the top bar, showing its tightest limit (Claude's
  session or weekly, Codex's weekly, …). Hover a ring for every window and when it resets. Accounts
  shared by several machines are shown once.
- **Map**: one starburst per machine. Agents radiate out as dots, closer in the more recently they
  worked, so live work sits near the centre. Subagents burst from their parent. Blue dots are
  working, pink ones need you, red ones failed, dark ones are done. Only agents doing something get a
  label; hover any dot for the rest. The map always fits the screen until you pan or zoom.
- **List**: the same information as rows, grouped by machine and project.
- **Activity**: only outcomes and problems: completions, failures, failed tests, things that need you,
  and machines going offline. Every command and edit is still in each agent's timeline and in the MCP.

Click any agent for its details: where it runs, its prompt, result and recent timeline.

## Sentinel: alerts only when it matters

The sentinel watches the fleet so you don't have to. Cheap rules pick out threads that *might* need you:

- blocked on an approval or a question;
- failed recently, unless the failed thread is a subagent whose parent is still working;
- finished on a question to you;
- running with no activity for 25 minutes;
- a provider with 10% or less left;
- a machine offline for more than 3 minutes.

A [Codex CLI](https://github.com/openai/codex) agent (`gpt-6-luna` by default: fast and cheap) looks at each
new candidate once, through the fleet MCP. It decides whether the thread *really* needs you, and you are
notified only when it does. Optional follow-ups, routine completions, retried failures and subagent errors
that the parent handles stay quiet.

Alerts show in the dashboard and as desktop notifications (macOS Notification Center, or `notify-send` on
Linux). For phone alerts, set an [ntfy](https://ntfy.sh) topic. The sentinel also keeps a short **briefing**
of the whole fleet and answers questions:

```sh
t3-fleet brief
t3-fleet ask "what failed on the mac mini today?"
```

The dashboard's sidebar has the same: an **Ask your fleet** box, the alert cards, and the briefing.

Without the Codex CLI, the sentinel uses only the rules that are unambiguous: blocked threads, machines
offline, and usage at 5% or less.

```jsonc
// ~/.config/t3-fleet/config.json
"sentinel": {
  "model": "gpt-6-luna",          // any Codex model
  "effort": "low",
  "briefEveryMinutes": 60,         // 0 to brief only on demand
  "desktop": true,
  "ntfy": "https://ntfy.sh/your-secret-topic"
}
```

## MCP server

t3-fleet serves a read-only MCP server at `http://127.0.0.1:4777/mcp` (streamable HTTP). It is also
available over stdio with `t3-fleet mcp`. Register it with Claude Code and Codex in one step:

```sh
t3-fleet mcp-install
```

| Tool | What it returns |
| --- | --- |
| `fleet_overview` | machines, counts by state, everything working or blocked, open alerts, usage |
| `list_agents` | agents filtered by state, machine, project, provider, text or time window |
| `get_agent` | one agent: where it runs, its parent and children, prompt and result, timeline |
| `get_usage` | usage left per provider account, with reset times |
| `recent_activity` | the fleet-wide activity feed |
| `get_alerts` | what the sentinel thinks needs you |

Any agent can then answer "what's running on the mac mini?" or "did the migration thread finish?".

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
t3-fleet brief       print a fresh briefing
t3-fleet ask "…"     ask the sentinel about your fleet
t3-fleet mcp-install register the MCP with Claude Code and Codex
t3-fleet mcp         run the MCP server over stdio
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

The sentinel runs `codex exec --ignore-user-config --ephemeral --sandbox read-only` with only the fleet
MCP attached. It never sees your other Codex configuration, and it cannot change anything.

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

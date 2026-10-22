#!/bin/sh
# Installs t3-fleet: a read-only, live map of every agent across your t3code servers.
#   curl -fsSL https://raw.githubusercontent.com/Lxvi101/t3-fleet/main/install.sh | sh
set -eu

REPO="${T3_FLEET_REPO:-https://github.com/Lxvi101/t3-fleet.git}"
APP_DIR="${T3_FLEET_HOME:-$HOME/.t3-fleet}"
CONFIG_DIR="${T3_FLEET_CONFIG_DIR:-$HOME/.config/t3-fleet}"
BIN_DIR="$HOME/.local/bin"
LABEL="dev.t3fleet"

say() { printf '\033[1;34m›\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null || die "git is required."

# 1. Bun
if ! command -v bun >/dev/null && [ ! -x "$HOME/.bun/bin/bun" ]; then
  say "Installing Bun"
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

# 2. App
if [ -d "$APP_DIR/.git" ]; then
  say "Updating $APP_DIR"
  git -C "$APP_DIR" pull --ff-only --quiet
else
  say "Downloading t3-fleet to $APP_DIR"
  git clone --quiet --depth 1 "$REPO" "$APP_DIR"
fi
mkdir -p "$CONFIG_DIR/data" "$BIN_DIR"
chmod 700 "$CONFIG_DIR"

# 3. Connect this machine's t3code server, if there is one.
if "$BUN" "$APP_DIR/scripts/setup-local.ts"; then :; else
  say "No local t3code found; add servers later with: t3-fleet add <name> <url> --ssh <host>"
fi

# 4. Background service
case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>src/server.ts</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$CONFIG_DIR/data/fleet.log</string>
  <key>StandardErrorPath</key><string>$CONFIG_DIR/data/fleet.log</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    ;;
  Linux)
    UNIT="$HOME/.config/systemd/user/t3-fleet.service"
    mkdir -p "$(dirname "$UNIT")"
    cat >"$UNIT" <<UNIT
[Unit]
Description=t3-fleet agent map
After=network-online.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$BUN src/server.ts
Restart=always
StandardOutput=append:$CONFIG_DIR/data/fleet.log
StandardError=append:$CONFIG_DIR/data/fleet.log

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now t3-fleet >/dev/null
    systemctl --user restart t3-fleet
    ;;
  *) say "Unknown OS: start it yourself with: t3-fleet run" ;;
esac

# 5. Command
ln -sf "$APP_DIR/bin/t3-fleet" "$BIN_DIR/t3-fleet"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Add $BIN_DIR to your PATH to use the t3-fleet command." ;; esac

say "t3-fleet is running at http://127.0.0.1:4777"
echo "  t3-fleet open                          open the dashboard"
echo "  t3-fleet add <name> <url> --ssh <host> watch another machine"
echo "  t3-fleet help                          everything else"

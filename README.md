# remote-vibe

Use your phone as a terminal for your PC: a real shell and any terminal-based AI coding agent (Claude Code, Codex CLI, Aider, Gemini CLI, …), from anywhere through [Tailscale](https://tailscale.com) or over a USB cable through adb.

```
Phone (PWA) ──HTTPS/WSS── tailscale serve ──► remote-vibe 127.0.0.1:7681 ──► node-pty (shell / agent)
Phone (USB) ── adb reverse tcp:7681 ────────┘
```

## Features
- **Installable web app (PWA).** Nothing to sideload: open a URL on your phone and add it to the home screen.
- **Persistent sessions.** Shells and agents keep running on the PC. Lock the phone, lose signal or switch networks, and the screen is replayed when you reconnect. Several devices can attach to the same session.
- **Agent launcher.** Pick a project folder and start your configured agent in it. When the agent exits you're left in a shell in the same folder.
- **Mobile controls.** A key bar (Esc, Tab, ⇧Tab, sticky Ctrl/Alt, arrows, ^C, paste), and a **Prompt** box that sends a multi-line prompt as a single bracketed paste, so phone keyboards don't fight the terminal.
- **Private by design.** The server only listens on `127.0.0.1`. It's reached through your own tailnet or a USB cable, never the public internet, and every request needs a 256-bit token.

## Requirements
- Linux PC with Node.js ≥ 20, plus a C/C++ toolchain (`base-devel` / `build-essential`) and Python, which `node-pty` needs to build
- Android phone with a modern browser (Chrome recommended). iOS Safari works too, minus USB mode.
- A free Tailscale account for remote access (optional if you only use USB)
- The agent CLI you want to use, installed and logged in on the PC (e.g. `claude`, `codex`, `aider`)

## Setup

### 1. Install the server
```sh
git clone <this-repo> remote-vibe
cd remote-vibe
npm install
```
`node-pty` compiles a native module. If npm blocks install scripts, approve that one package (`npm install-scripts approve node-pty`; the approval is saved in `package.json` under `allowScripts`) and then run `npm rebuild node-pty`.

Put the CLI on your PATH. Either:
```sh
ln -s "$PWD/bin/remote-vibe.js" ~/.local/bin/remote-vibe    # no sudo, if ~/.local/bin is on PATH
# or
npm link                                                     # may need sudo, depending on your npm prefix
```

Run it as a systemd user service (it starts now and on every login):
```sh
remote-vibe install-service
sudo loginctl enable-linger $USER    # optional: keep it running at boot without a desktop login
```
Or run it in the foreground with `remote-vibe start`.

Check it's up:
```sh
curl -i http://127.0.0.1:7681/api/ping    # → 401 (running; the token is required)
```

### 2. Remote access with Tailscale
Install Tailscale on the PC ([docs for other distros](https://tailscale.com/download/linux)):
```sh
sudo pacman -S tailscale                   # Arch; use your distro's package manager otherwise
sudo systemctl enable --now tailscaled
sudo tailscale up                          # opens a login URL
sudo tailscale set --operator=$USER        # optional: run `tailscale serve` without sudo
```

In the [Tailscale admin console → DNS](https://login.tailscale.com/admin/dns), turn on **MagicDNS** and **HTTPS Certificates**.

Proxy HTTPS from your tailnet to the local server. This survives reboots, and the first run may print a link to enable Serve on your tailnet:
```sh
tailscale serve --bg 7681
tailscale serve status        # → https://<machine>.<tailnet>.ts.net (tailnet only)
```

Install the **Tailscale** app on your phone and sign in with the same account.

> Use `tailscale serve`, **not** `tailscale funnel`. Funnel makes the server public.

### 3. Pair your phone
```sh
remote-vibe pair
```
Scan the **Remote (Tailscale)** QR code with your phone camera. It opens `https://<machine>.<tailnet>.ts.net/#token=…`, and the app stores the token and removes it from the URL. Then use the browser menu: **Add to Home screen**.

You can also paste the token by hand on the pairing screen.

### 4. Optional: USB cable (Android)
Works with no network at all.
```sh
sudo pacman -S android-tools               # provides adb
# On the phone: Settings → Developer options → USB debugging. Plug in and accept the prompt.
adb reverse tcp:7681 tcp:7681
```
On the phone, open the **USB** URL printed by `remote-vibe pair` (`http://localhost:7681/#token=…`). Run `adb reverse` again each time you reconnect the cable.

## Usage
- **✦ New agent session**: pick a project under the projects root, or type a `/…` or `~/…` path. Your `agentCommand` starts there.
- **New shell**: a login shell (`$SHELL -li`) in the chosen folder.
- Tap a session to reattach, and tap ✕ to kill it.
- **✎ Prompt**: **Send ⏎** pastes the text and presses Enter. **Insert** pastes without pressing Enter.
- **⇧Tab** is handy for agents that use it to switch modes (e.g. plan / auto-accept).
- **A− / A+** change the font size, which is remembered per device.

## Configuration
The config file is `~/.config/remote-vibe/config.json` (created on first run, mode 0600):

| key | default | description |
|---|---|---|
| `port` | `7681` | local port (also update `tailscale serve` / `adb reverse`) |
| `host` | `127.0.0.1` | bind address. Keep it on loopback. |
| `projectsRoot` | `~/dev` | folders listed in the project picker |
| `shell` | `$SHELL` | shell used for sessions |
| `agentCommand` | `claude` | command for agent sessions, e.g. `codex`, `aider --model …`, `claude --continue` |
| `scrollbackBytes` | `1048576` | replay buffer per session |
| `extraHosts` | `[]` | extra hostnames allowed besides `localhost` and `*.ts.net` |
| `token` | random | access token. Rotate it with `remote-vibe rotate-token`. |

Apply changes with `systemctl --user restart remote-vibe`.

## CLI
```
remote-vibe start             run the server in the foreground (default)
remote-vibe pair              print pairing URLs and QR codes
remote-vibe rotate-token      generate a new token (restart and re-pair afterwards)
remote-vibe install-service   install and start the systemd user service
remote-vibe config            print the config file path
```

## Security
- The token gives **full shell access as your user**. Treat it like an SSH private key and never commit or share `config.json`. If a phone is lost, run `remote-vibe rotate-token`, restart, and remove the device from your tailnet.
- Requests are refused unless the `Host` header is loopback or `*.ts.net`, which blocks DNS rebinding. WebSocket `Origin` must match the host, and after 10 bad tokens in a minute, auth locks for 60 s.
- Static assets are served without a token, so the pairing screen can load. Everything under `/api` and `/ws` requires it.
- Sessions live in the server process, so restarting the service ends them.

## Troubleshooting
- **`tailscale up` → `503 no backend`**: check `journalctl -u tailscaled`. "Module tun not found" usually means a kernel update is waiting for a reboot.
- **The shell shows a setup wizard (e.g. Powerlevel10k)**: that's your normal shell startup. Finish it once on the PC, or set `"shell": "/bin/bash"`.
- **Agent command not found**: sessions start through a login shell (`$SHELL -lic`), so make sure the agent is on the PATH your login shell sets.

## Project layout
```
bin/remote-vibe.js   CLI (start, pair, rotate-token, install-service)
src/config.js        config load/create, token generation
src/server.js        HTTP + WebSocket server, auth, static files
src/sessions.js      PTY sessions with replay buffer
public/              PWA: UI, xterm.js frontend, service worker, manifest, icons
```

## License
MIT

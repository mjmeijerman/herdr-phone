# herdr-phone

Watch the Herdr agent terminals on this machine from a phone, and type into them.

One Node process: it serves the page, the JSON API, and the gate. Zero npm
dependencies — `node:http`, `node:child_process`, `node:crypto` and `node:test`
only. The data comes from the tools that already exist here (`herdr-app ls`,
`hc ls`, `hc read`, `hc send`, `hc keys`, `hc interrupt`); nothing is written
back to Herdr.

## Requirements

- Node 22 or newer. Tested on Node 26.13.0 (`~/.local/share/fnm/node-versions/v26.13.0`),
  where `node --test tests/` takes a directory; Node 22/24 need `node --test tests/*.test.mjs`.
  `bin/herdr-phone` picks the newest node it can find (fnm, nvm, then `PATH`).
- `hc`, `herdr-app`, `curl` on `PATH`. Everything else is stdlib.

## Run it

```sh
bin/herdr-phone run            # foreground, 127.0.0.1:7455
bin/herdr-phone run --port 7600
node server.mjs                # same thing, PORT=... also works
```

First run creates `~/.config/herdr-phone/token`: 32 hex characters, mode 0600,
directory 0700. `bin/herdr-phone token` prints the path, never the token.

Open `http://127.0.0.1:7455/` and paste the token. The cookie it sets is
`sha256(token)`, `HttpOnly`, `SameSite=Strict`, 30 days.

Then, from a phone: [`docs/tailscale.md`](docs/tailscale.md) — userspace
networking, no root, no `sudo`.

## Install as a user unit

```sh
bin/herdr-phone install     # writes, enables and starts herdr-phone.service (no root)
bin/herdr-phone uninstall   # stops, disables, removes the unit
loginctl enable-linger "$USER"   # optional: keep it up when you log out
```

The unit it writes is a plain systemd **user** unit:

```ini
[Unit]
Description=herdr-phone — mobile web UI for Herdr sessions
After=network.target

[Service]
Type=simple
WorkingDirectory=<repo>
ExecStart=<node> <repo>/server.mjs --port 7455
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

## HTTP API

Every `/api/*` call needs `Authorization: Bearer <token>` or the `hp` cookie.
Without one: `401` with an **empty** body — no hint for a scanner.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | the page. Public: it holds no data and never the token. |
| POST | `/login` | `{token}` → sets `hp`, `204`; wrong token → `401`, empty. |
| POST | `/logout` | drops the cookie, `204`. |
| GET | `/api/tabs` | `{ok, at, problems, live, spaces:[{name, active, tabs:[{name, active, terminals:[{address, agent, cwd, state, status, working, turn, app, label}]}]}]}` |
| GET | `/api/screen?terminal=t19b` | `{terminal, at, screen}` — ANSI and control bytes already stripped. |
| POST | `/api/send` | `{terminal, text[, confirm]}` → `hc send ADDRESS TEXT` |
| POST | `/api/keys` | `{terminal, keys:["esc"]}` → `hc keys ADDRESS esc`; allowlist: `enter esc ctrl+c ctrl+d tab up down left right backspace space` |
| POST | `/api/interrupt` | `{terminal}` → `hc interrupt ADDRESS` |

`/api/tabs` merges `herdr-app ls` (spaces, tabs, terminal ids) with `hc ls`
(live status, turn, cwd). If `herdr-app ls` is unavailable the space/tab tree is
rebuilt from `hc ls`'s `where` field (`"space / tab"`) and `problems` says so.
`hc read` failing is a `502`, never a `200` with an empty screen.

## Safety

- A send over 400 characters, or one matching the destructive list (`rm -rf` /
  `rm -fr` / `rm -r -f`, `--force`, `git push -f`, `DROP TABLE|DATABASE|SCHEMA|INDEX|USER`),
  is refused with `428` unless the same payload carries `confirm: true`. The page
  arms the Send button for a second tap on `428`; the server is the authority.
- `hc` is always called with an argv array — no shell, so `$(...)`, backticks and
  `;` inside a message are just text.
- A terminal id must match `^t[0-9a-z]{2,40}$` before it reaches argv.
- Keys are an allowlist, not a passthrough.
- The server binds `127.0.0.1` only and refuses any other host (`0.0.0.0`
  included) — the Tailscale side is `tailscale serve`, which keeps it loopback.
- The token never appears in a URL, a log line, or the HTML. Logging is
  `time method path status duration` — path only, no query, no headers.

## The page

Mobile-first, one column, readable at 390px:

- one row per space, its tabs under it, a live dot from `hc ls` (green pulse =
  working, grey = done), `44px` tap targets;
- screen view of the selected terminal, `hc read` polled every 2s (paused when
  the tab is hidden), auto-scroll only when you are already at the bottom;
- `wrap` / `nowrap` toggle: wrapped by default, which is what fits a phone;
- input pinned above the iOS keyboard: `100dvh` plus a `visualViewport` listener,
  16px text so iOS does not zoom on focus, `env(safe-area-inset-bottom)`;
- `?t=t19b` preselects a terminal, so one tab can be bookmarked;
- key row (`esc`, `^C`, `⏎`, `stop`) and Send; a refused send turns into
  "Tap again" for 6 seconds.

## Tests

```sh
node --test tests/                 # Node 26
node --test tests/*.test.mjs       # Node 22/24: they do not take a directory
```

No network, no real Herdr: every `hc` / `herdr-app` call is stubbed, and the
tests talk to a real server on an ephemeral loopback port. They pin the token
gate (`401` empty without, `200` with, `/` reachable, token never in the HTML),
the `/api/tabs` shape (including the `herdr-app` fallback), `/api/send` argv, the
allowlist, and the `428` gate.

## What it does not do

No space or tab management (create, rename, close) — the spec's data sources are
read/write only for terminals. No scrollback paging, no file transfer, no
multi-user accounts: one token, one phone-sized view.

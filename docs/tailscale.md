# Reaching herdr-phone from a phone, without root

herdr-phone listens on `127.0.0.1:7455` only. To open it from a phone you need a
private network path to loopback. On this machine there is no `sudo`, so
Tailscale runs in **userspace networking** mode: `tailscaled` as your user, no
`/dev/net/tun`, no kernel routes, no capability, outbound traffic through a
local SOCKS5 proxy.

Everything below happens as your own user. Nothing is installed system-wide.

## One command

```sh
bin/herdr-phone tailscale
```

What it does, in order:

1. Downloads the static `tailscale` + `tailscaled` binaries for this
   architecture into `~/.local/bin` (version from
   `https://pkgs.tailscale.com/stable/`; pin it with `TAILSCALE_VERSION=1.80.2`).
2. Starts `tailscaled` in the background, detached:

   ```sh
   tailscaled \
     --tun=userspace-networking \
     --statedir=$HOME/.local/share/tailscaled \
     --socket=$HOME/.local/share/tailscale/tailscaled.sock \
     --socks5-server=localhost:1055
   ```

3. Runs `tailscale up`. If the node is not logged in yet it prints **the login
   URL and exits 0** — it never waits for you to open it:

   ```
   Open this on any device and log in:
     https://login.tailscale.com/a/xxxxxxxxxxxx

   then run 'herdr-phone tailscale' again to finish (serve --bg 7455)
   ```

4. On the second run, once the node is logged in, it publishes loopback port
   7455 to your tailnet and prints the URL:

   ```sh
   tailscale --socket=$HOME/.local/share/tailscale/tailscaled.sock serve --bg 7455
   # serving: https://<machine>.<tailnet>.ts.net/  ->  127.0.0.1:7455
   ```

Open that URL on the phone, over the tailnet, and paste the token from
`~/.config/herdr-phone/token`. `tailscale serve` proxies to loopback, so the
server still never binds a LAN address.

## Files it touches

| Path | What |
| --- | --- |
| `~/.local/bin/tailscale`, `~/.local/bin/tailscaled` | the static binaries |
| `~/.local/share/tailscaled/` | node state (keys, node id) |
| `~/.local/share/tailscale/tailscaled.sock` | the CLI/daemon socket |
| `~/.local/share/tailscale/tailscaled.log`, `up.log` | daemon and `up` output |
| `~/.local/share/tailscale/` | nothing else |

## Verifying by hand

```sh
SOCK=$HOME/.local/share/tailscale/tailscaled.sock
tailscale --socket=$SOCK status          # peer list, and whether you are logged in
tailscale --socket=$SOCK serve status    # what is published
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7455/    # 200 locally
curl -s -o /dev/null -w '%{http_code}\n' https://<machine>.<tailnet>.ts.net/   # 200 over the tailnet
```

A `401` on `/api/tabs` from the phone means the network path works and the token
is missing — that is the gate, not a broken tunnel.

## Caveats

- **Userspace mode is outbound-only.** This machine can reach the tailnet; it
  cannot be used as an exit node, cannot serve raw TCP to the LAN, and does not
  see tailnet peers as normal routes. `tailscale serve` and `tailscale status`
  work; anything that needs a kernel interface does not.
- **The daemon does not survive a reboot.** Restart it with
  `bin/herdr-phone tailscale` (it skips the download and the login). A systemd
  user unit for it is not in this change; say the word and it can be added next
  to `herdr-phone.service`.
- **The tailnet is not the gate.** `tailscale serve` exposes the port to every
  device your ACLs allow, plus anyone with a shared node. The token still has to
  be pasted, and it is the only credential — treat the URL as public.
- **Logging in is interactive.** A login URL expires; if it does, run
  `bin/herdr-phone tailscale` again for a fresh one.
- **To undo:** `tailscale --socket=$SOCK serve --bg off`, `tailscale --socket=$SOCK
  down`, then kill the `tailscaled` process; `rm -rf ~/.local/share/tailscaled`
  forgets the node (revoke it in the admin console as well).

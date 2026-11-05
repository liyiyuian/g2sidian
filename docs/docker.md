# Docker deployment (alternative to install.sh)

For servers where you don't want to install Python deps and a systemd unit on
the host, the backend ships as a plain Docker container. The API is
Python-stdlib-only, so the image is just three copied files — no pip install,
no base-image churn.

```bash
cp .env.example .env          # edit: token + vault path (chmod 600)
docker compose up -d --build
curl -s localhost:8793/api/health        # {"ok":true,"service":"g2sidian-api"}
```

Security posture is identical to `install.sh`, with the port publish playing
the role of the loopback bind:

| install.sh | docker-compose.yml |
|---|---|
| binds `127.0.0.1` via `G2SIDIAN_BIND` | publishes `127.0.0.1:8793:8793` only |
| systemd `--user` unit | `restart: unless-stopped` |
| runs as your user | runs as a non-root `g2sidian` user |
| `~/.local/state/g2sidian/backups` | same path inside the container (ephemeral unless you add a volume) |

Exposure to the tailnet is the host's job, same as before:

```bash
sudo tailscale set --operator=$USER
sudo tailscale serve --bg --https=8445 8793
```

The glasses app's Hub build whitelists `https://*.ts.net:8445`, so this serve
line is what makes it connect — the container needs no changes for that.

## Read-only vaults

The compose file mounts the vault `:ro` by default. In read-only mode,
browsing, reading, search, Jump, and Tasks-due all work; capture and
"add to this note" will fail with a write error (the backend backs up and
appends atomically when the mount is writable — drop the `:ro` to enable).

## More than one vault

Add one volume line per vault and match the paths in `G2SIDIAN_VAULTS`:

```yaml
    volumes:
      - /home/me/Documents/Work:/vaults/work:ro
      - /home/me/Documents/Personal:/vaults/personal:ro
```
```dotenv
G2SIDIAN_VAULTS=[{"name":"Work","path":"/vaults/work"},{"name":"Personal","path":"/vaults/personal"}]
```

## Keeping write backups across container restarts

The backend copies pre-write note snapshots to
`~/.local/state/g2sidian/backups`. Inside the container that is
`/home/g2sidian/.local/state/g2sidian/backups`; mount a host dir over it if
you use capture with a writable vault mount:

```yaml
    volumes:
      - /home/me/.local/state/g2sidian/backups:/home/g2sidian/.local/state/g2sidian/backups
```

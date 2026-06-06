# sjs-browser

The **sjs-browser** Docker image — the [Smart Job Seeker](https://smartjobseeker.com)
browser client that runs on a NAS or home server and connects to SJS over a
long-lived WebSocket channel. It drives a real Chrome instance with your home
IP, so scraping happens on your own device instead of a shared cloud pool. The
desktop equivalent is [sjs-desktop](https://github.com/gitaarik/sjs-desktop).

This repository contains the **full source** of that client, plus the workflow
that builds and signs every release. It is the code your NAS actually runs —
you can read it, diff it between versions, and verify that the published image
and tarball were built from it.

## Trust model

Smart Job Seeker's design keeps the **client on your device open** and the
**scraping intelligence on the server proprietary**:

- **This client is open source.** Everything that runs on your hardware —
  Chrome launch flags, the CDP bridge, the tunnel connection, the VNC relay —
  lives in `src/` and is auditable here.
- **Releases are signed.** Each release ships a `*.tar.gz` bundle and a
  minisign signature (`*.tar.gz.minisig`). The in-container bootstrap verifies
  the signature against the public key baked into the image
  (`/sjs-browser/release.pub`, also published below) before running any update.
- **The server is proprietary.** Match scoring, run orchestration, and the
  anti-detection tuning that drives the browser live server-side and are not
  part of this repo.

## What's here

| Path | What it is |
|---|---|
| `src/` | The TypeScript client (run via `tsx` in the container) |
| `Dockerfile` | Builds the image: Chrome + Xvfb + VNC + the client |
| `bootstrap.sh` | On-start auto-update: fetch → verify signature → run latest |
| `entrypoint.sh`, `chrome-common.sh` | Container startup + Chrome supervisor |
| `release.pub` | minisign public key for verifying release tarballs |
| `docker-compose.example.yml` | Starting point for your own deployment |

## Running it

Install instructions, the current Docker Compose template, and the
`gitaarik036/sjs-browser` image tag live in the SJS dashboard under
**Devices → Add device**. A minimal starting point is in
`docker-compose.example.yml` — copy it, set `SJS_SERVER_URL` and
`SJS_API_TOKEN` (from the dashboard), and start the container.

The image auto-updates: on each container start the bootstrap fetches the
latest signed release from this repo, verifies it, and runs it — so you stay
current without editing your compose file. Pin or disable this via the
`SJS_BROWSER_CHANNEL` env var (`stable` default, a tag like `v1.0.0`, or
`disabled`).

## Keeping it up to date

sjs-browser self-updates in two layers, and you mostly only think about the
first:

- **App code** (the client in `src/`) auto-updates on every container start
  and once every six hours while running. No setup, no second container.
- **Image** (Chrome, Node, base OS) only changes when you pull a new Docker
  image — manually, or via your platform's image-update flow.

### How the app-code auto-update works

On startup the in-container bootstrap fetches the
[latest signed release](https://github.com/gitaarik/sjs-browser/releases/latest),
verifies its minisign signature against the public key baked into the image,
extracts it under `/data/app/<version>/`, and atomically swaps
`/data/app/current` to point at it. The runtime exec's from that directory.

Once running, a watchdog re-checks every six hours. When a new release is
found it exits `0`; with `restart: unless-stopped` Docker recreates the
container and the bootstrap picks up the new tarball.

If the bootstrap can't reach GitHub, fails the signature check, or hits any
other error, it falls back to the previously-installed code or to the source
baked into the image — the container is always runnable, including fully
offline on first boot.

Pin the app to one release, or opt out of the bootstrap entirely, via
`SJS_BROWSER_CHANNEL`:

```yaml
environment:
  - SJS_BROWSER_CHANNEL=v1.0.0    # pin to this release tag; no auto-update beyond it
  # - SJS_BROWSER_CHANNEL=disabled  # no network calls to GitHub; run on-disk code only
```

### Updating the image (Chrome, Node, base OS)

The app code auto-updates, but the image does not. Pull a new image when you
want Chrome, Node, or the base OS updated:

```bash
docker compose pull
docker compose up -d
```

You only need this every few months, or when there's a security advisory you
want to follow promptly. Chrome bumps only happen on image pulls, not on
app-code auto-updates.

If your platform has a built-in image-update flow, use it:

- **Synology** (Container Manager): enable **Auto-update** on the project.
- **TrueNAS Scale 24.10+**: enable **Auto Update** on the custom app;
  optionally schedule the system-wide **Update Applications** task.
- **Unraid**: install the **CA Auto Update Applications** plugin and enable it
  for the sjs-browser container.
- **QNAP** (Container Station): no built-in scheduler — pull manually, or cron
  `docker compose pull && up -d`.
- **Plain Docker**: a cron entry, e.g.
  `0 4 * * 0 cd /opt/sjs-browser && docker compose pull && docker compose up -d`.

**TrueNAS Scale ≤ 24.04** (Bluefin / Cobia / Dragonfish) runs apps on
k3s + containerd, not Docker. The bootstrap still works, but image updates are
awkward: if the app updates yet the startup version line doesn't change,
containerd is serving a stale cached image. Force a fresh pull from the system
shell:

```bash
sudo k3s crictl pull docker.io/gitaarik036/sjs-browser:latest
# or evict the cached image and let the redeploy pull it:
sudo k3s crictl rmi  docker.io/gitaarik036/sjs-browser:latest
sudo k3s crictl images | grep sjs-browser   # list cached versions
```

### Which version is running, and rolling back

The container logs its app-code version on startup:

```
============================================
 Smart Job Seeker — sjs-browser
   Build: 1.0.0 (2026-06-06T17:23:35Z)
   Server: wss://...
============================================
```

`Build` is the *runtime* version (whatever the bootstrap last extracted),
which can differ from the image tag if the bootstrap has upgraded the app
beyond what shipped baked into the image. Run `docker inspect` on the
container to see the image tag itself.

If an update breaks something, pin the channel to the last known good release
and restart — the bootstrap fetches it (or uses the disk cache) and stays
there until you set the channel back to `stable`. Release tags are immutable,
so any prior tarball is always fetchable; all versions are listed at
<https://github.com/gitaarik/sjs-browser/releases>.

## Verifying a release

Each tarball is signed with the project's minisign key. The matching public
key ships in the image at `/sjs-browser/release.pub` and is published here for
offline verification.

**Public key** (`untrusted comment: minisign public key FF5126A6C6B6C206`):

```
RWQGwrbGpiZR/1LYFGtHDhBoFMwRUGITN8r4Gv1wRhoFO22tBL2mNRKQ
```

To verify a tarball you've downloaded:

```bash
minisign -Vm sjs-browser-vX.Y.Z.tar.gz \
  -P RWQGwrbGpiZR/1LYFGtHDhBoFMwRUGITN8r4Gv1wRhoFO22tBL2mNRKQ
```

## Building from source

```bash
docker build -t sjs-browser .
```

The build context is this repository root. Type-check the client with
`npm install && npx tsc --noEmit`.

## License

See [LICENSE](LICENSE).

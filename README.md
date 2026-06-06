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

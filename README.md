# sjs-browser

Release artifacts for the **sjs-browser** Docker image — the
[Smart Job Seeker](https://smartjobseeker.com) browser that runs on a NAS or
home server and connects to SJS via a long-lived WebSocket channel. The
desktop equivalent is [sjs-desktop](https://github.com/gitaarik/sjs-desktop).

The actual source code lives in a separate, private monorepo. This repo
exists only to host the signed release tarballs that the in-container
bootstrap auto-update path fetches at runtime, so users always run the
latest version without redeploying their compose file.

## Releases

Each release publishes:

- `sjs-browser-vX.Y.Z.tar.gz` — the runnable application bundle
  (`src/`, `package.json`, `tsconfig.json`, production `node_modules`,
  and a `.build-info.json` build stamp)
- `sjs-browser-vX.Y.Z.tar.gz.minisig` — minisign signature over the
  tarball

## Verifying a release

Each tarball is signed with the minisign keypair generated when the
auto-update path was set up. The matching public key ships inside the
Docker image at `/sjs-browser/release.pub`, and is also published below
for offline verification.

**Public key** (`untrusted comment: minisign public key FF5126A6C6B6C206`):

```
RWQGwrbGpiZR/1LYFGtHDhBoFMwRUGITN8r4Gv1wRhoFO22tBL2mNRKQ
```

To verify a tarball you've downloaded:

```bash
minisign -Vm sjs-browser-vX.Y.Z.tar.gz \
  -P RWQGwrbGpiZR/1LYFGtHDhBoFMwRUGITN8r4Gv1wRhoFO22tBL2mNRKQ
```

## Installing or updating sjs-browser

See the install instructions inside the SJS dashboard
(**Devices → Add device**) for current Docker Compose templates and the
gitaarik036/sjs-browser image.

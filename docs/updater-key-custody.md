# Updater signing key — custody & setup

Prompture Desk's in-app updater only installs an update whose artifact carries
a valid **minisign signature** matching the public key in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). That signature check is
the whole security model: the private key that signs releases must stay secret,
and it must never be lost.

## Current state

- A signing keypair has been generated. The **public** key is committed in
  `src-tauri/tauri.conf.json`.
- The **private** key lives at `.updater/prompture-desk-updater.key`
  (gitignored — it is **not** in the repo), with an **empty password**.
- CI (`.github/workflows/release.yml`) builds signed updater artifacts and
  uploads `latest.json` **only when the signing secret is present**. Until
  then releases build exactly as before, just without the in-app update path.

## To turn on in-app updates (one-time, maintainer only)

Add two repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | the full contents of `.updater/prompture-desk-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty string (the key has no password) |

The next push to `main` then builds signed artifacts and uploads `latest.json`
to the GitHub Release, which the app checks at:

```
https://github.com/jhd3197/Prompture-Desk/releases/latest/download/latest.json
```

Installs from before the updater shipped can't update themselves; users install
the first update-capable release by hand, and every release after that arrives
in the app.

## Rotating the key

Only possible **before** the first update-capable release ships (afterwards,
installed copies trust the old key only):

```bash
npx tauri signer generate -w .updater/prompture-desk-updater.key -p "" --ci -f
cat .updater/prompture-desk-updater.key.pub   # paste into tauri.conf.json pubkey
```

Then update the `TAURI_SIGNING_PRIVATE_KEY` secret to the new key's contents.

## Custody rules

- **Never commit** the private key or paste it anywhere public. `.updater/` is
  gitignored; keep it that way.
- **Back it up** (a password manager). If it is lost, existing installs can
  never be updated again — you'd have to ship a new key in a release that users
  install manually.

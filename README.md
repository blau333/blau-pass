blau is an open source app, passwords vault that have TOTP feature and supports encryption 
Available on Windows 7+
Sharing feature is in the process of developing

## Windows updates

The app checks GitHub Releases for updates and installs signed updates after confirmation. Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. Existing installations need to install the first updater-enabled release manually; later releases can be installed in the app.

### One-time updater signing setup

The updater public key is configured in `src-tauri/tauri.conf.json`. The matching private key must be added as a GitHub Actions repository secret named `TAURI_SIGNING_PRIVATE_KEY`; for this checkout, the generated private key is stored locally at `%USERPROFILE%\.tauri\blau-pass-updater.key`. Copy the **contents** of that file into the secret, not its path. Never commit or share the private key.

To generate a replacement key pair, use PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.tauri"
npm run tauri -- signer generate --ci --write-keys "$env:USERPROFILE\.tauri\blau-updater.key"
```

If you replace the key, update `plugins.updater.pubkey` with the contents of the generated `.pub` file and replace the GitHub secret with the matching private key. The `--ci` option creates an unencrypted private key, so protect the file and secret; if you create a password-protected key instead, also set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

### Publishing an update

Set the `version` in `src-tauri/tauri.conf.json` to the new semantic version, commit the change, and push the matching version tag, for example:

```powershell
git tag v0.1.1
git push origin v0.1.1
```

The workflow publishes a signed Windows NSIS installer and updater metadata to the GitHub Release. Users can then select **Проверить обновления** in the app. The release tag must match the version in `tauri.conf.json`.

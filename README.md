# blau

Blau is a local, encrypted vault for passwords and other secrets. It runs on Windows and stores your data in an encrypted file on your device.

**[Browse blau releases and download the Windows installer](https://github.com/blau333/blau-pass/releases)**

If there are no releases listed, an installer has not been published yet.

## Getting started

1. Download and run the installer.
2. The first time you launch blau, create a master password that is at least 12 characters long.
3. Click **Добавить** (Add) to create an entry. You can save a website password, an SSH private key, or an API token. Password entries can also include a secret for generating two-factor authentication (2FA) codes.
4. Find entries using search or the categories in the sidebar.

When you open blau again, enter your master password to unlock the vault. Click **Заблокировать** (Lock) when you are finished.

## Back up and restore

In the sidebar, click **Экспорт в файл** (Export to file) to save an encrypted backup with the `.rsv` extension. Keep the backup somewhere safe and create new backups regularly.

To restore your data, unlock blau, click **Импорт из файла** (Import from file), select the backup, and enter the master password that was used to create it. **Importing replaces all current entries.** The master password for the currently open vault remains unchanged.

## Security

- Your data is stored locally in an encrypted vault. The master password is used for encryption and is not saved by the app.
- The master password cannot be reset. Backups are encrypted too, so you need the password used to create a backup to import it.
- Do not share your master password. Protect your device and backups.
- When you copy a password or another secret, remember that it is placed on your clipboard.

## Sharing

Sharing through **Google Sheets** is an experimental feature, not a way to sync your entire vault. You can select password entries to share or read a shared set. Only entry names, usernames, passwords, and website addresses are shared; SSH keys, API tokens, and notes are not included. Deleting an entry in blau does not remove it from the shared set.

To use sharing, set up Google Apps Script and a spreadsheet, then enter the script URL, access token, spreadsheet URL, and shared encryption key in blau. The spreadsheet stores an encrypted package. Give participants the connection details, but share the encryption key separately from the spreadsheet link. Only share secrets with people you trust.

## Updates

Click **Проверить обновления** (Check for updates) in the app. If a new version is available, blau will offer to install it. Installers for published versions are available on the [releases page](https://github.com/blau333/blau-pass/releases).

## Report a problem

If you find a bug or have a suggestion, [open an issue on GitHub](https://github.com/blau333/blau-pass/issues/new).

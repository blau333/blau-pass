//! Модель данных хранилища и сохранение/загрузка (всегда в зашифрованном виде).

use crate::crypto::{self, EncryptedFile};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Vault {
    #[serde(default)]
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub google_share: Option<GoogleShareConfig>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GoogleShareConfig {
    pub script_url: String,
    pub access_token: String,
    pub spreadsheet_url: String,
    pub share_key: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Entry {
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub kind: EntryKind,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub notes: String,
    /// base32-секрет TOTP
    #[serde(default)]
    pub totp_secret: Option<String>,
    /// Задел на будущее: passkeys. Старые файлы без этого поля читаются нормально.
    #[serde(default)]
    pub passkeys: Vec<PasskeyRecord>,
}

#[derive(Serialize, Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    #[default]
    Password,
    SshKey,
    ApiToken,
}

/// Пока только хранилище. Чтобы сайты реально использовали такие ключи,
/// нужна интеграция с системным WebAuthn API (см. описание в чате).
#[derive(Serialize, Deserialize, Clone)]
pub struct PasskeyRecord {
    pub rp_id: String,
    pub credential_id_b64: String,
    pub user_handle_b64: String,
    pub private_key_pkcs8_b64: String,
}

impl Vault {
    pub fn find(&self, name: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|e| e.name.eq_ignore_ascii_case(name))
    }
}

pub fn load(path: &Path, password: &str) -> Result<Vault> {
    let text = fs::read_to_string(path)
        .with_context(|| format!("Не удалось прочитать {}", path.display()))?;
    let file: EncryptedFile = serde_json::from_str(&text).context("Файл не похож на хранилище")?;
    let plain = crypto::decrypt(&file, password)?;
    Ok(serde_json::from_slice(&plain)?)
}

pub fn save(path: &Path, password: &str, vault: &Vault) -> Result<()> {
    let plain = Zeroizing::new(serde_json::to_vec(vault)?);
    let file = crypto::encrypt(&plain, password)?;
    // Атомарная запись: сначала во временный файл, потом переименование,
    // чтобы сбой посреди записи не уничтожил хранилище.
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&file)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn older_entries_default_to_password_kind() {
        let vault: Vault = serde_json::from_str(
            r#"{"entries":[{"name":"Legacy","username":"user","password":"secret"}]}"#,
        )
        .unwrap();

        assert_eq!(vault.entries.len(), 1);
        assert!(vault.entries[0].icon.is_empty());
        assert!(matches!(vault.entries[0].kind, EntryKind::Password));
    }

    #[test]
    fn typed_credentials_remain_in_the_legacy_password_field() {
        let entry = Entry {
            name: "Deploy key".into(),
            kind: EntryKind::SshKey,
            password: "private-key-material".into(),
            ..Entry::default()
        };
        let serialized = serde_json::to_value(entry).unwrap();

        assert_eq!(serialized["kind"], "ssh_key");
        assert_eq!(serialized["password"], "private-key-material");
        assert!(serialized.get("ssh_private_key").is_none());
    }
}

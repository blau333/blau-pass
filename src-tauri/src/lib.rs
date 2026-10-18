#[path = "../../crypto.rs"]
mod crypto;
#[path = "../../totp.rs"]
mod totp;
#[path = "../../vault.rs"]
mod vault;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use tauri::{Manager, State};
use zeroize::{Zeroize, Zeroizing};

const MAX_SHARE_PACKAGE_SIZE: usize = 5 * 1024 * 1024;

struct Session {
    password: Zeroizing<String>,
    vault: vault::Vault,
}

#[derive(Default)]
struct AppState {
    session: Mutex<Option<Session>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntrySummary {
    name: String,
    icon: String,
    username: String,
    url: String,
    kind: vault::EntryKind,
    has_password: bool,
    has_totp: bool,
    has_api_token: bool,
    has_ssh_private_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryDetails {
    name: String,
    icon: String,
    kind: vault::EntryKind,
    username: String,
    password: String,
    url: String,
    notes: String,
    api_token: String,
    ssh_private_key: String,
    code: Option<String>,
    seconds_remaining: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryInput {
    original_name: Option<String>,
    name: String,
    icon: String,
    kind: vault::EntryKind,
    username: String,
    password: String,
    url: String,
    notes: String,
    totp_secret: String,
    #[serde(default)]
    remove_totp: bool,
    api_token: String,
    ssh_private_key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedEntry {
    name: String,
    username: String,
    password: String,
    url: String,
}

impl Drop for SharedEntry {
    fn drop(&mut self) {
        self.name.zeroize();
        self.username.zeroize();
        self.password.zeroize();
        self.url.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharePackage {
    format: String,
    encrypted: crypto::EncryptedFile,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleSheetResponse {
    ok: bool,
    #[serde(default)]
    package: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

const ENTRY_ICONS: &[&str] = &[
    "🌐", "🔐", "🔑", "🐙", "💼", "📧", "☁️", "🏦", "🎮", "🛒", "🖥️", "📱",
];

fn vault_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("vault.rsv"))
}

fn same_file(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn spreadsheet_id_from_url(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value)
        .map_err(|_| "Введите корректную ссылку Google Sheets".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("docs.google.com") {
        return Err("Ссылка должна вести на docs.google.com".into());
    }
    let segments: Vec<_> = url
        .path_segments()
        .ok_or_else(|| "Некорректная ссылка Google Sheets".to_string())?
        .collect();
    if segments.first() != Some(&"spreadsheets") {
        return Err("Ссылка должна вести на таблицу Google Sheets".into());
    }
    let id = segments
        .windows(2)
        .find(|pair| pair[0] == "d")
        .map(|pair| pair[1])
        .filter(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
        .ok_or_else(|| "В ссылке не найден идентификатор таблицы Google Sheets".to_string())?;
    Ok(id.to_string())
}

fn validate_script_url(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value)
        .map_err(|_| "Введите корректную ссылку опубликованного Apps Script".to_string())?;
    let path = url.path();
    let deployment = path
        .strip_prefix("/macros/s/")
        .and_then(|path| path.strip_suffix("/exec"));
    if url.scheme() != "https"
        || url.host_str() != Some("script.google.com")
        || deployment.is_none_or(|id| id.is_empty() || id.contains('/'))
    {
        return Err(
            "Используйте HTTPS-ссылку веб-приложения script.google.com/macros/s/…/exec".into(),
        );
    }
    Ok(())
}

fn generate_share_key() -> String {
    let mut key_bytes = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(&mut *key_bytes);
    URL_SAFE_NO_PAD.encode(&*key_bytes)
}

fn validate_share_key(value: &str) -> Result<(), String> {
    if value.len() != 43
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Ключ общего доступа имеет неверный формат".into());
    }
    Ok(())
}

fn locked_session<'a>(
    state: &'a State<'_, AppState>,
) -> Result<MutexGuard<'a, Option<Session>>, String> {
    state
        .session
        .lock()
        .map_err(|_| "Не удалось получить доступ к хранилищу".to_string())
}

#[tauri::command]
fn vault_exists(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(vault_path(&app)?.exists())
}

#[tauri::command]
fn initialize(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<(), String> {
    if password.chars().count() < 12 {
        return Err("Мастер-пароль должен быть не короче 12 символов".into());
    }
    let mut session = locked_session(&state)?;
    let path = vault_path(&app)?;
    if path.exists() {
        return Err("Хранилище уже существует".into());
    }
    let vault = vault::Vault::default();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    vault::save(&path, &password, &vault).map_err(|e| e.to_string())?;
    *session = Some(Session {
        password: Zeroizing::new(password),
        vault,
    });
    Ok(())
}

#[tauri::command]
fn unlock(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<(), String> {
    let mut session = locked_session(&state)?;
    let vault = vault::load(&vault_path(&app)?, &password).map_err(|e| e.to_string())?;
    *session = Some(Session {
        password: Zeroizing::new(password),
        vault,
    });
    Ok(())
}

#[tauri::command]
fn lock(state: State<'_, AppState>) -> Result<(), String> {
    *locked_session(&state)? = None;
    Ok(())
}

#[tauri::command]
fn export_vault(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    destination: String,
) -> Result<(), String> {
    let session = locked_session(&state)?;
    if session.is_none() {
        return Err("Хранилище заблокировано".into());
    }
    let source = vault_path(&app)?;
    let destination = PathBuf::from(destination);
    if same_file(&source, &destination) {
        return Err("Выберите другой файл для резервной копии".into());
    }
    fs::copy(&source, &destination)
        .map(|_| ())
        .map_err(|e| format!("Не удалось экспортировать хранилище: {e}"))
}

#[tauri::command]
fn import_vault(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    source: String,
    password: String,
) -> Result<(), String> {
    let mut session = locked_session(&state)?;
    let session = session
        .as_mut()
        .ok_or_else(|| "Хранилище заблокировано".to_string())?;
    let source = PathBuf::from(source);
    let destination = vault_path(&app)?;
    if same_file(&source, &destination) {
        return Err("Выберите файл резервной копии, а не текущее хранилище".into());
    }

    let password = Zeroizing::new(password);
    let imported = vault::load(&source, &password)
        .map_err(|e| format!("Не удалось открыть резервную копию. Проверьте пароль и файл: {e}"))?;
    vault::save(&destination, &session.password, &imported)
        .map_err(|e| format!("Не удалось сохранить импортированное хранилище: {e}"))?;
    session.vault = imported;
    Ok(())
}

#[tauri::command]
fn list_entries(state: State<'_, AppState>) -> Result<Vec<EntrySummary>, String> {
    let session = locked_session(&state)?;
    let session = session
        .as_ref()
        .ok_or_else(|| "Хранилище заблокировано".to_string())?;
    Ok(session
        .vault
        .entries
        .iter()
        .map(|entry| EntrySummary {
            name: entry.name.clone(),
            icon: entry.icon.clone(),
            username: entry.username.clone(),
            url: entry.url.clone(),
            kind: entry.kind,
            has_password: entry.kind == vault::EntryKind::Password && !entry.password.is_empty(),
            has_totp: entry.totp_secret.is_some(),
            has_api_token: entry.kind == vault::EntryKind::ApiToken && !entry.password.is_empty(),
            has_ssh_private_key: entry.kind == vault::EntryKind::SshKey
                && !entry.password.is_empty(),
        })
        .collect())
}

#[tauri::command]
fn get_entry(state: State<'_, AppState>, name: String) -> Result<EntryDetails, String> {
    let session = locked_session(&state)?;
    let session = session
        .as_ref()
        .ok_or_else(|| "Хранилище заблокировано".to_string())?;
    let entry = session
        .vault
        .find(&name)
        .ok_or_else(|| "Запись не найдена".to_string())?;
    let (code, seconds_remaining) = match entry.totp_secret.as_deref() {
        Some(secret) => {
            let (code, remaining) = totp::current_code(secret).map_err(|e| e.to_string())?;
            (Some(code), Some(remaining))
        }
        None => (None, None),
    };
    Ok(EntryDetails {
        name: entry.name.clone(),
        icon: entry.icon.clone(),
        kind: entry.kind,
        username: entry.username.clone(),
        password: if entry.kind == vault::EntryKind::Password {
            entry.password.clone()
        } else {
            String::new()
        },
        url: entry.url.clone(),
        notes: entry.notes.clone(),
        api_token: if entry.kind == vault::EntryKind::ApiToken {
            entry.password.clone()
        } else {
            String::new()
        },
        ssh_private_key: if entry.kind == vault::EntryKind::SshKey {
            entry.password.clone()
        } else {
            String::new()
        },
        code,
        seconds_remaining,
    })
}

#[tauri::command]
fn save_entry(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: EntryInput,
) -> Result<(), String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Введите название записи".into());
    }
    if !input.icon.is_empty() && !ENTRY_ICONS.contains(&input.icon.as_str()) {
        return Err("Выбран неподдерживаемый значок".into());
    }
    match input.kind {
        vault::EntryKind::SshKey if input.ssh_private_key.trim().is_empty() => {
            return Err("Введите закрытый SSH-ключ".into())
        }
        vault::EntryKind::ApiToken if input.api_token.trim().is_empty() => {
            return Err("Введите API-токен".into())
        }
        _ => {}
    }
    let mut session = locked_session(&state)?;
    let session = session
        .as_mut()
        .ok_or_else(|| "Хранилище заблокировано".to_string())?;
    let existing_index = input
        .original_name
        .as_deref()
        .map(|original| {
            session
                .vault
                .entries
                .iter()
                .position(|entry| entry.name.eq_ignore_ascii_case(original))
                .ok_or_else(|| "Запись больше не существует".to_string())
        })
        .transpose()?;
    let secret = if input.totp_secret.trim().is_empty() {
        if input.remove_totp {
            None
        } else {
            existing_index.and_then(|index| session.vault.entries[index].totp_secret.clone())
        }
    } else {
        Some(totp::normalize_secret(&input.totp_secret).map_err(|e| e.to_string())?)
    };
    let credential = match input.kind {
        vault::EntryKind::Password => input.password,
        vault::EntryKind::SshKey => input.ssh_private_key,
        vault::EntryKind::ApiToken => input.api_token,
    };
    if session
        .vault
        .entries
        .iter()
        .enumerate()
        .any(|(index, entry)| {
            Some(index) != existing_index && entry.name.eq_ignore_ascii_case(name)
        })
    {
        return Err(format!("Запись «{name}» уже существует"));
    }

    let mut updated = session.vault.clone();
    let entry = vault::Entry {
        name: name.to_string(),
        icon: input.icon,
        kind: input.kind,
        username: input.username.trim().to_string(),
        password: credential,
        url: input.url.trim().to_string(),
        notes: input.notes,
        totp_secret: secret,
        passkeys: existing_index
            .map(|index| updated.entries[index].passkeys.clone())
            .unwrap_or_default(),
    };
    if let Some(index) = existing_index {
        updated.entries[index] = entry;
    } else {
        updated.entries.push(entry);
    }
    vault::save(&vault_path(&app)?, &session.password, &updated).map_err(|e| e.to_string())?;
    session.vault = updated;
    Ok(())
}

#[tauri::command]
fn remove_entry(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let mut session = locked_session(&state)?;
    let session = session
        .as_mut()
        .ok_or_else(|| "Хранилище заблокировано".to_string())?;
    let mut updated = session.vault.clone();
    let Some(index) = updated
        .entries
        .iter()
        .position(|entry| entry.name.eq_ignore_ascii_case(&name))
    else {
        return Err("Запись не найдена".into());
    };
    updated.entries.remove(index);
    vault::save(&vault_path(&app)?, &session.password, &updated).map_err(|e| e.to_string())?;
    session.vault = updated;
    Ok(())
}

#[tauri::command]
fn get_google_share_config(
    state: State<'_, AppState>,
) -> Result<Option<vault::GoogleShareConfig>, String> {
    let session = locked_session(&state)?;
    let session = session
        .as_ref()
        .ok_or_else(|| "Хранилище заблокировано".to_string())?;
    Ok(session.vault.google_share.clone())
}

#[tauri::command]
fn save_google_share_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    script_url: String,
    access_token: String,
    spreadsheet_url: String,
    share_key: String,
) -> Result<(), String> {
    validate_script_url(&script_url)?;
    spreadsheet_id_from_url(&spreadsheet_url)?;
    validate_share_key(&share_key)?;
    if access_token.len() < 32 || access_token.len() > 256 {
        return Err("Токен моста должен содержать от 32 до 256 символов".into());
    }
    if !access_token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Токен моста может содержать только латинские буквы, цифры, «-» и «_»".into());
    }
    let mut session = locked_session(&state)?;
    let session = session
        .as_mut()
        .ok_or_else(|| "Хранилище заблокировано".to_string())?;
    let mut updated = session.vault.clone();
    updated.google_share = Some(vault::GoogleShareConfig {
        script_url,
        access_token,
        spreadsheet_url,
        share_key,
    });
    vault::save(&vault_path(&app)?, &session.password, &updated).map_err(|e| e.to_string())?;
    session.vault = updated;
    Ok(())
}

async fn call_google_script(
    config: &vault::GoogleShareConfig,
    action: &str,
    package: Option<&str>,
) -> Result<Option<String>, String> {
    if action != "read" && action != "write" {
        return Err("Неподдерживаемое действие с таблицей".into());
    }
    if let Some(value) = package {
        if value.len() > MAX_SHARE_PACKAGE_SIZE {
            return Err("Зашифрованный пакет слишком большой".into());
        }
    }
    if action == "write" && package.is_none() {
        return Err("Нет зашифрованного пакета для записи".into());
    }

    validate_script_url(&config.script_url)?;
    let spreadsheet_id = spreadsheet_id_from_url(&config.spreadsheet_url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.stop();
            }
            match (attempt.url().scheme(), attempt.url().host_str()) {
                ("https", Some("script.google.com" | "script.googleusercontent.com")) => {
                    attempt.follow()
                }
                _ => attempt.stop(),
            }
        }))
        .build()
        .map_err(|e| format!("Не удалось подготовить соединение: {e}"))?;
    let response = client
        .post(&config.script_url)
        .json(&serde_json::json!({
            "token": &config.access_token,
            "spreadsheetId": spreadsheet_id,
            "action": action,
            "package": package,
        }))
        .send()
        .await
        .map_err(|e| format!("Не удалось связаться с Google Apps Script: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Не удалось прочитать ответ Google Apps Script: {e}"))?;
    if body.len() > MAX_SHARE_PACKAGE_SIZE + 1024 {
        return Err("Ответ Google Apps Script слишком большой".into());
    }
    if !status.is_success() {
        return Err(format!("Google Apps Script вернул HTTP {status}"));
    }
    let result: GoogleSheetResponse =
        serde_json::from_str(&body).map_err(|e| format!("Некорректный ответ Apps Script: {e}"))?;
    if !result.ok {
        return Err(result
            .error
            .unwrap_or_else(|| "Apps Script не выполнил операцию".into()));
    }
    if action == "read" {
        let package = result
            .package
            .ok_or_else(|| "Apps Script не вернул зашифрованный пакет".to_string())?;
        if package.len() > MAX_SHARE_PACKAGE_SIZE {
            return Err("Полученный пакет слишком большой".into());
        }
        Ok(Some(package))
    } else {
        Ok(None)
    }
}

fn google_share_config(state: &State<'_, AppState>) -> Result<vault::GoogleShareConfig, String> {
    let session = locked_session(state)?;
    let session = session
        .as_ref()
        .ok_or_else(|| "Хранилище заблокировано".to_string())?;
    session
        .vault
        .google_share
        .clone()
        .ok_or_else(|| "Сначала настройте подключение Google Sheets".to_string())
}

#[tauri::command]
async fn google_sheet_exchange(
    state: State<'_, AppState>,
    action: String,
    package: Option<String>,
) -> Result<Option<String>, String> {
    let config = google_share_config(&state)?;
    call_google_script(&config, &action, package.as_deref()).await
}

#[tauri::command]
async fn sync_google_sheet(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<usize, String> {
    let (config, mut selected_entries) = {
        let session = locked_session(&state)?;
        let session = session
            .as_ref()
            .ok_or_else(|| "Хранилище заблокировано".to_string())?;
        let config = session
            .vault
            .google_share
            .clone()
            .ok_or_else(|| "Сначала настройте подключение Google Sheets".to_string())?;
        let selected_entries = collect_shared_entries(&session.vault, &names)?;
        (config, selected_entries)
    };

    let remote = call_google_script(&config, "read", None).await?;
    let mut shared_entries = match remote.as_deref() {
        Some(value) if !value.is_empty() => decrypt_shared_entries(value, &config.share_key)?,
        _ => Vec::new(),
    };
    for entry in selected_entries.drain(..) {
        if let Some(index) = shared_entries
            .iter()
            .position(|current| current.name.eq_ignore_ascii_case(&entry.name))
        {
            shared_entries[index] = entry;
        } else {
            shared_entries.push(entry);
        }
    }
    let count = shared_entries.len();
    let package = encrypt_shared_entries(&shared_entries, &config.share_key)?;
    call_google_script(&config, "write", Some(&package)).await?;
    Ok(count)
}

#[tauri::command]
fn create_google_share_key() -> String {
    generate_share_key()
}

fn collect_shared_entries(
    vault: &vault::Vault,
    names: &[String],
) -> Result<Vec<SharedEntry>, String> {
    if names.is_empty() {
        return Err("Выберите хотя бы один пароль для общего доступа".into());
    }
    let mut shared_entries = Vec::with_capacity(names.len());
    for name in names {
        let entry = vault
            .find(name)
            .ok_or_else(|| format!("Запись «{name}» не найдена"))?;
        if entry.kind != vault::EntryKind::Password {
            return Err(format!("Запись «{}» не является паролем", entry.name));
        }
        if entry.password.is_empty() {
            return Err(format!("В записи «{}» не задан пароль", entry.name));
        }
        if shared_entries
            .iter()
            .any(|shared: &SharedEntry| shared.name.eq_ignore_ascii_case(&entry.name))
        {
            return Err(format!("Запись «{}» выбрана несколько раз", entry.name));
        }
        shared_entries.push(SharedEntry {
            name: entry.name.clone(),
            username: entry.username.clone(),
            password: entry.password.clone(),
            url: entry.url.clone(),
        });
    }
    Ok(shared_entries)
}

fn encrypt_shared_entries(entries: &[SharedEntry], key: &str) -> Result<String, String> {
    let plaintext = Zeroizing::new(serde_json::to_vec(entries).map_err(|e| e.to_string())?);
    let encrypted = crypto::encrypt_share(&plaintext, key).map_err(|e| e.to_string())?;
    let package = SharePackage {
        format: "blau-share-v1".into(),
        encrypted,
    };
    serde_json::to_string(&package).map_err(|e| e.to_string())
}

fn decrypt_shared_entries(package: &str, key: &str) -> Result<Vec<SharedEntry>, String> {
    if package.len() > MAX_SHARE_PACKAGE_SIZE {
        return Err("Зашифрованный пакет слишком большой".into());
    }
    validate_share_key(key)?;
    let package: SharePackage =
        serde_json::from_str(package).map_err(|e| format!("Некорректный пакет: {e}"))?;
    if package.format != "blau-share-v1" {
        return Err("Неподдерживаемый формат общего доступа".into());
    }
    let plaintext = crypto::decrypt_share(&package.encrypted, key).map_err(|e| e.to_string())?;
    let entries: Vec<SharedEntry> =
        serde_json::from_slice(&plaintext).map_err(|e| format!("Пакет повреждён: {e}"))?;
    if entries.is_empty() {
        return Err("В пакете нет записей".into());
    }
    Ok(entries)
}

#[tauri::command]
fn decrypt_share_package(package: String, key: String) -> Result<Vec<SharedEntry>, String> {
    let key = Zeroizing::new(key);
    decrypt_shared_entries(&package, &key)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            vault_exists,
            initialize,
            unlock,
            lock,
            export_vault,
            import_vault,
            list_entries,
            get_entry,
            save_entry,
            remove_entry,
            decrypt_share_package,
            get_google_share_config,
            save_google_share_config,
            google_sheet_exchange,
            create_google_share_key,
            sync_google_sheet
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска RustVault");
}

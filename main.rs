mod crypto;
mod totp;
mod vault;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use rand::{rngs::OsRng, Rng};
use std::{fs, path::PathBuf};
use vault::{Entry, Vault};
use zeroize::Zeroizing;

#[derive(Parser)]
#[command(name = "rustvault", about = "Локальный зашифрованный менеджер паролей и TOTP")]
struct Cli {
    /// Путь к файлу хранилища
    #[arg(short, long, default_value = "vault.rsv", global = true)]
    file: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Создать новое хранилище
    Init,
    /// Добавить запись
    Add {
        name: String,
        #[arg(short, long)]
        username: Option<String>,
        #[arg(long)]
        url: Option<String>,
        /// base32-секрет или ссылка otpauth://
        #[arg(long)]
        totp: Option<String>,
        /// Сгенерировать пароль вместо ввода
        #[arg(short, long)]
        generate: bool,
    },
    /// Список записей
    List,
    /// Показать запись (включая пароль)
    Show { name: String },
    /// Показать текущий TOTP-код
    Totp { name: String },
    /// Сгенерировать случайный пароль
    Gen {
        #[arg(default_value_t = 20)]
        length: usize,
    },
    /// Удалить запись
    Remove { name: String },
    /// Экспорт: копия зашифрованного файла для переноса на другое устройство
    Export { out: PathBuf },
    /// Импорт зашифрованного файла с другого устройства
    Import {
        input: PathBuf,
        /// Перезаписать существующее хранилище
        #[arg(long)]
        force: bool,
    },
    /// Сменить мастер-пароль
    Passwd,
}

fn ask(prompt: &str) -> Result<Zeroizing<String>> {
    Ok(Zeroizing::new(rpassword::prompt_password(prompt)?))
}

fn ask_new_password() -> Result<Zeroizing<String>> {
    let p1 = ask("Новый мастер-пароль: ")?;
    if p1.chars().count() < 12 {
        bail!("Мастер-пароль должен быть не короче 12 символов");
    }
    let p2 = ask("Повторите: ")?;
    if *p1 != *p2 {
        bail!("Пароли не совпали");
    }
    Ok(p1)
}

fn generate_password(len: usize) -> String {
    const CHARS: &[u8] =
        b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+?";
    (0..len.max(8))
        .map(|_| CHARS[OsRng.gen_range(0..CHARS.len())] as char)
        .collect()
}

fn read_line(prompt: &str) -> Result<String> {
    use std::io::{self, Write};
    print!("{prompt}");
    io::stdout().flush()?;
    let mut s = String::new();
    io::stdin().read_line(&mut s)?;
    Ok(s.trim().to_string())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let path = cli.file;

    match cli.cmd {
        Cmd::Gen { length } => println!("{}", generate_password(length)),

        Cmd::Init => {
            if path.exists() {
                bail!("{} уже существует", path.display());
            }
            let pw = ask_new_password()?;
            vault::save(&path, &pw, &Vault::default())?;
            println!("Хранилище создано: {}", path.display());
        }

        Cmd::Add { name, username, url, totp, generate } => {
            let pw = ask("Мастер-пароль: ")?;
            let mut v = vault::load(&path, &pw)?;
            if v.find(&name).is_some() {
                bail!("Запись «{name}» уже есть");
            }
            let password = if generate {
                generate_password(20)
            } else {
                ask("Пароль для записи: ")?.to_string()
            };
            let (totp_secret, totp_config) = totp
                .map(|value| totp::parse_secret(&value))
                .transpose()?
                .map(|(secret, config)| (Some(secret), Some(config)))
                .unwrap_or((None, None));
            let notes = read_line("Заметки (Enter — пропустить): ")?;
            v.entries.push(Entry {
                name: name.clone(),
                username: username.unwrap_or_default(),
                password: password.clone(),
                url: url.unwrap_or_default(),
                notes,
                totp_secret,
                totp_config,
                ..Entry::default()
            });
            vault::save(&path, &pw, &v)?;
            println!("Добавлено: {name}");
            if generate {
                println!("Сгенерированный пароль: {password}");
            }
        }

        Cmd::List => {
            let pw = ask("Мастер-пароль: ")?;
            let v = vault::load(&path, &pw)?;
            for e in &v.entries {
                let mut tags = String::new();
                if e.totp_secret.is_some() {
                    tags.push_str(" [TOTP]");
                }
                match e.kind {
                    vault::EntryKind::Password => {}
                    vault::EntryKind::SshKey => tags.push_str(" [SSH-ключ]"),
                    vault::EntryKind::ApiToken => tags.push_str(" [API-токен]"),
                    vault::EntryKind::WifiNetwork => tags.push_str(" [Wi-Fi]"),
                }
                if !e.passkeys.is_empty() {
                    tags.push_str(" [passkey]");
                }
                println!("{:<24} {}{}", e.name, e.username, tags);
            }
        }

        Cmd::Show { name } => {
            let pw = ask("Мастер-пароль: ")?;
            let v = vault::load(&path, &pw)?;
            let e = v.find(&name).ok_or_else(|| anyhow::anyhow!("Нет такой записи"))?;
            println!("Название:  {}", e.name);
            println!("Логин:     {}", e.username);
            match e.kind {
                vault::EntryKind::Password => println!("Пароль:    {}", e.password),
                vault::EntryKind::SshKey => println!("SSH-ключ:  {}", e.password),
                vault::EntryKind::ApiToken => println!("API-токен: {}", e.password),
                vault::EntryKind::WifiNetwork => println!("Пароль Wi-Fi: {}", e.password),
            }
            println!("URL:       {}", e.url);
            println!("Заметки:   {}", e.notes);
        }

        Cmd::Totp { name } => {
            let pw = ask("Мастер-пароль: ")?;
            let v = vault::load(&path, &pw)?;
            let e = v.find(&name).ok_or_else(|| anyhow::anyhow!("Нет такой записи"))?;
            let secret = e
                .totp_secret
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("У записи нет TOTP"))?;
            let config = e.totp_config.unwrap_or_default();
            let (code, left) = totp::current_code(secret, &config)?;
            println!("{code}  (ещё {left} с)");
        }

        Cmd::Remove { name } => {
            let pw = ask("Мастер-пароль: ")?;
            let mut v = vault::load(&path, &pw)?;
            let before = v.entries.len();
            v.entries.retain(|e| !e.name.eq_ignore_ascii_case(&name));
            if v.entries.len() == before {
                bail!("Нет такой записи");
            }
            vault::save(&path, &pw, &v)?;
            println!("Удалено: {name}");
        }

        Cmd::Export { out } => {
            if !path.exists() {
                bail!("Хранилище не найдено");
            }
            fs::copy(&path, &out)?;
            println!(
                "Зашифрованная копия сохранена: {}\nПеренесите её на новое устройство и выполните `import`.",
                out.display()
            );
        }

        Cmd::Import { input, force } => {
            if path.exists() && !force {
                bail!("{} уже существует (используйте --force)", path.display());
            }
            // Проверяем, что файл открывается вашим мастер-паролем, прежде чем принять его
            let pw = ask("Мастер-пароль импортируемого хранилища: ")?;
            vault::load(&input, &pw)?;
            fs::copy(&input, &path)?;
            println!("Импортировано в {}", path.display());
        }

        Cmd::Passwd => {
            let old = ask("Текущий мастер-пароль: ")?;
            let v = vault::load(&path, &old)?;
            let new = ask_new_password()?;
            vault::save(&path, &new, &v)?;
            println!("Мастер-пароль изменён");
        }
    }
    Ok(())
}

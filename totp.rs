//! TOTP по RFC 6238 (SHA-1, 6 цифр, шаг 30 с — то, что использует большинство сервисов).

use anyhow::{anyhow, bail, Result};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use std::time::{SystemTime, UNIX_EPOCH};

const STEP: u64 = 30;

/// Принимает либо чистый base32-секрет, либо ссылку otpauth://...?secret=...
/// Возвращает нормализованный base32 (верхний регистр, без пробелов и '=').
pub fn normalize_secret(input: &str) -> Result<String> {
    let raw = if input.starts_with("otpauth://") {
        let query = input.split_once('?').map(|x| x.1).unwrap_or("");
        query
            .split('&')
            .find_map(|kv| kv.strip_prefix("secret="))
            .ok_or_else(|| anyhow!("В otpauth-ссылке нет параметра secret"))?
    } else {
        input
    };

    let s: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .collect::<String>()
        .to_uppercase();

    decode(&s)?; // проверка валидности
    Ok(s)
}

fn decode(s: &str) -> Result<Vec<u8>> {
    base32::decode(base32::Alphabet::Rfc4648 { padding: false }, s)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| anyhow!("Некорректный base32-секрет"))
}

fn hotp(key: &[u8], counter: u64) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("HMAC принимает ключ любой длины");
    mac.update(&counter.to_be_bytes());
    let r = mac.finalize().into_bytes();
    let off = (r[19] & 0x0f) as usize;
    let bin = u32::from_be_bytes([r[off] & 0x7f, r[off + 1], r[off + 2], r[off + 3]]);
    format!("{:06}", bin % 1_000_000)
}

/// Текущий код и сколько секунд он ещё действителен.
pub fn current_code(secret_b32: &str) -> Result<(String, u64)> {
    let key = decode(secret_b32)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| anyhow!("Системные часы выставлены до 1970 года"))?
        .as_secs();
    if key.is_empty() {
        bail!("Пустой секрет");
    }
    Ok((hotp(&key, now / STEP), STEP - now % STEP))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4226_test_vectors() {
        // Ключ "12345678901234567890", тестовые значения из RFC 4226
        let key = b"12345678901234567890";
        assert_eq!(hotp(key, 0), "755224");
        assert_eq!(hotp(key, 1), "287082");
        assert_eq!(hotp(key, 9), "520489");
    }

    #[test]
    fn parses_otpauth_url() {
        let s = normalize_secret("otpauth://totp/Site:me?secret=jbsw y3dp&issuer=Site").unwrap();
        assert_eq!(s, "JBSWY3DP");
    }
}

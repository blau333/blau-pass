//! TOTP по RFC 6238 с параметрами из otpauth-ссылки.

use anyhow::{anyhow, bail, Result};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TotpAlgorithm {
    Sha1,
    Sha256,
    Sha512,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(default)]
pub struct TotpConfig {
    pub algorithm: TotpAlgorithm,
    pub digits: u32,
    pub period: u64,
}

impl Default for TotpAlgorithm {
    fn default() -> Self {
        Self::Sha1
    }
}

impl Default for TotpConfig {
    fn default() -> Self {
        Self {
            algorithm: TotpAlgorithm::Sha1,
            digits: 6,
            period: 30,
        }
    }
}

impl TotpConfig {
    fn validate(&self) -> Result<()> {
        if !matches!(self.digits, 6 | 8) {
            bail!("Поддерживаются TOTP-коды из 6 или 8 цифр");
        }
        if self.period == 0 {
            bail!("Интервал TOTP-кода должен быть больше нуля");
        }
        Ok(())
    }
}

/// Принимает base32-секрет или ссылку otpauth://totp/...?secret=...
/// Возвращает нормализованный секрет и параметры генерации.
pub fn parse_secret(input: &str) -> Result<(String, TotpConfig)> {
    let input = input.trim();
    let (raw, config) = if input
        .get(..10)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("otpauth://"))
    {
        let uri = &input[10..];
        let (path, query) = uri
            .split_once('?')
            .ok_or_else(|| anyhow!("В otpauth-ссылке отсутствуют параметры"))?;
        if !path
            .split('/')
            .next()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("totp"))
        {
            bail!("Поддерживаются ссылки otpauth://totp");
        }

        let query = query.split('#').next().unwrap_or(query);
        let mut secret = None;
        let mut config = TotpConfig::default();
        for parameter in query.split('&').filter(|part| !part.is_empty()) {
            let (key, value) = parameter.split_once('=').unwrap_or((parameter, ""));
            let key = decode_query_component(key)?.to_ascii_lowercase();
            let value = decode_query_component(value)?;
            match key.as_str() {
                "secret" => secret = Some(value),
                "algorithm" => {
                    config.algorithm = match value.replace('-', "").to_ascii_uppercase().as_str() {
                        "SHA1" => TotpAlgorithm::Sha1,
                        "SHA256" => TotpAlgorithm::Sha256,
                        "SHA512" => TotpAlgorithm::Sha512,
                        _ => bail!("Неподдерживаемый алгоритм TOTP: {value}"),
                    };
                }
                "digits" => {
                    config.digits = value
                        .parse()
                        .map_err(|_| anyhow!("Некорректное число цифр в TOTP-ссылке"))?;
                }
                "period" => {
                    config.period = value
                        .parse()
                        .map_err(|_| anyhow!("Некорректный интервал в TOTP-ссылке"))?;
                }
                _ => {}
            }
        }
        (
            secret.ok_or_else(|| anyhow!("В otpauth-ссылке нет параметра secret"))?,
            config,
        )
    } else {
        (input.to_string(), TotpConfig::default())
    };

    config.validate()?;
    let secret: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .collect::<String>()
        .to_uppercase();
    decode(&secret)?;
    Ok((secret, config))
}

fn decode(s: &str) -> Result<Vec<u8>> {
    base32::decode(base32::Alphabet::Rfc4648 { padding: false }, s)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| anyhow!("Некорректный base32-секрет"))
}

fn decode_query_component(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' => {
                let hex = bytes
                    .get(index + 1..index + 3)
                    .ok_or_else(|| anyhow!("Некорректное кодирование otpauth-ссылки"))?;
                let high = hex_digit(hex[0])
                    .ok_or_else(|| anyhow!("Некорректное кодирование otpauth-ссылки"))?;
                let low = hex_digit(hex[1])
                    .ok_or_else(|| anyhow!("Некорректное кодирование otpauth-ссылки"))?;
                decoded.push((high << 4) | low);
                index += 3;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).map_err(|_| anyhow!("Некорректная кодировка otpauth-ссылки"))
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn hmac_digest(key: &[u8], counter: u64, algorithm: TotpAlgorithm) -> Vec<u8> {
    macro_rules! calculate {
        ($digest:ty) => {{
            let mut mac = Hmac::<$digest>::new_from_slice(key).expect("HMAC принимает ключ любой длины");
            mac.update(&counter.to_be_bytes());
            mac.finalize().into_bytes().to_vec()
        }};
    }
    match algorithm {
        TotpAlgorithm::Sha1 => calculate!(Sha1),
        TotpAlgorithm::Sha256 => calculate!(Sha256),
        TotpAlgorithm::Sha512 => calculate!(Sha512),
    }
}

fn hotp(key: &[u8], counter: u64, config: &TotpConfig) -> String {
    let digest = hmac_digest(key, counter, config.algorithm);
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = u32::from_be_bytes([
        digest[offset] & 0x7f,
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]);
    format!(
        "{:0width$}",
        binary % 10u32.pow(config.digits),
        width = config.digits as usize
    )
}

/// Текущий код и сколько секунд он ещё действителен.
pub fn current_code(secret_b32: &str, config: &TotpConfig) -> Result<(String, u64)> {
    config.validate()?;
    let key = decode(secret_b32)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| anyhow!("Системные часы выставлены до 1970 года"))?
        .as_secs();
    Ok((
        hotp(&key, now / config.period, config),
        config.period - now % config.period,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4226_test_vectors() {
        let key = b"12345678901234567890";
        let config = TotpConfig::default();
        assert_eq!(hotp(key, 0, &config), "755224");
        assert_eq!(hotp(key, 1, &config), "287082");
        assert_eq!(hotp(key, 9, &config), "520489");
    }

    #[test]
    fn rfc6238_test_vectors() {
        let mut config = TotpConfig {
            digits: 8,
            ..TotpConfig::default()
        };
        assert_eq!(hotp(b"12345678901234567890", 59 / 30, &config), "94287082");

        config.algorithm = TotpAlgorithm::Sha256;
        assert_eq!(
            hotp(b"12345678901234567890123456789012", 59 / 30, &config),
            "46119246"
        );

        config.algorithm = TotpAlgorithm::Sha512;
        assert_eq!(
            hotp(
                b"1234567890123456789012345678901234567890123456789012345678901234",
                59 / 30,
                &config,
            ),
            "90693936"
        );
    }

    #[test]
    fn parses_otpauth_url_and_encoding_parameters() {
        let (secret, config) = parse_secret(
            "otpauth://totp/Site:me?issuer=Site&Secret=jbsw3dp%3D&algorithm=SHA256&digits=8&period=60",
        )
        .unwrap();
        assert_eq!(secret, "JBSW3DP");
        assert_eq!(config.algorithm, TotpAlgorithm::Sha256);
        assert_eq!(config.digits, 8);
        assert_eq!(config.period, 60);
    }

    #[test]
    fn parses_plain_secrets_with_standard_defaults() {
        let (secret, config) = parse_secret("jbsw y3dp").unwrap();
        assert_eq!(secret, "JBSWY3DP");
        assert_eq!(config.algorithm, TotpAlgorithm::Sha1);
        assert_eq!(config.digits, 6);
        assert_eq!(config.period, 30);
    }
}

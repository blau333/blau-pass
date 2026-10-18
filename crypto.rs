//! Шифрование: мастер-пароль -> Argon2id -> ключ -> XChaCha20-Poly1305.

use anyhow::{anyhow, bail, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const FORMAT_VERSION: u32 = 1;
/// Связываем шифртекст с версией формата (AAD): подмена версии сломает расшифровку.
const AAD: &[u8] = b"rustvault-format-v1";
const SHARE_AAD: &[u8] = b"blau-share-v1";

#[derive(Serialize, Deserialize, Clone)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        // 64 МиБ памяти, 3 прохода, 1 поток — разумные значения для десктопа
        Self {
            m_cost_kib: 64 * 1024,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

/// То, что лежит на диске (и что переносится при экспорте).
#[derive(Serialize, Deserialize)]
pub struct EncryptedFile {
    pub version: u32,
    pub kdf: String,
    pub params: KdfParams,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

fn derive_key(password: &str, salt: &[u8], p: &KdfParams) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(p.m_cost_kib, p.t_cost, p.p_cost, Some(32))
        .map_err(|e| anyhow!("Неверные параметры KDF: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, &mut *key)
        .map_err(|e| anyhow!("Ошибка Argon2: {e}"))?;
    Ok(key)
}

pub fn encrypt(plaintext: &[u8], password: &str) -> Result<EncryptedFile> {
    encrypt_with_aad(plaintext, password, AAD)
}

pub fn encrypt_share(plaintext: &[u8], key: &str) -> Result<EncryptedFile> {
    encrypt_with_aad(plaintext, key, SHARE_AAD)
}

fn encrypt_with_aad(plaintext: &[u8], password: &str, aad: &[u8]) -> Result<EncryptedFile> {
    let params = KdfParams::default();

    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);

    let key = derive_key(password, &salt, &params)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| anyhow!("Ошибка шифрования"))?;

    Ok(EncryptedFile {
        version: FORMAT_VERSION,
        kdf: "argon2id".into(),
        params,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    })
}

pub fn decrypt(file: &EncryptedFile, password: &str) -> Result<Zeroizing<Vec<u8>>> {
    decrypt_with_aad(file, password, AAD)
}

pub fn decrypt_share(file: &EncryptedFile, key: &str) -> Result<Zeroizing<Vec<u8>>> {
    if file.params.m_cost_kib != 64 * 1024 || file.params.t_cost != 3 || file.params.p_cost != 1 {
        bail!("Неверные параметры шифрования пакета");
    }
    decrypt_with_aad(file, key, SHARE_AAD)
}

fn decrypt_with_aad(
    file: &EncryptedFile,
    password: &str,
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    if file.version != FORMAT_VERSION || file.kdf != "argon2id" {
        bail!("Неподдерживаемый формат файла (версия {})", file.version);
    }
    // Защита от файла с абсурдными параметрами (DoS по памяти)
    if file.params.m_cost_kib > 1024 * 1024 || file.params.t_cost > 20 {
        bail!("Слишком тяжёлые параметры KDF в файле");
    }

    let salt = B64.decode(&file.salt)?;
    let nonce = B64.decode(&file.nonce)?;
    let ciphertext = B64.decode(&file.ciphertext)?;
    if nonce.len() != 24 {
        bail!("Повреждён nonce");
    }

    let key = derive_key(password, &salt, &file.params)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| anyhow!("Неверный пароль или файл повреждён"))?;
    Ok(Zeroizing::new(plaintext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_encryption_round_trips_and_is_separate_from_vault_encryption() {
        let key = "random-share-key";
        let encrypted = encrypt_share(b"shared credentials", key).unwrap();

        assert_eq!(
            &*decrypt_share(&encrypted, key).unwrap(),
            b"shared credentials"
        );
        assert!(decrypt(&encrypted, key).is_err());
    }

    #[test]
    fn share_encryption_rejects_wrong_key() {
        let encrypted = encrypt_share(b"shared credentials", "correct-key").unwrap();
        assert!(decrypt_share(&encrypted, "wrong-key").is_err());
    }
}

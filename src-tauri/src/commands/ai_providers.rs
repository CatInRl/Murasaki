//! AI Provider 配置与 API Key 安全存储
//!
//! 使用 Windows DPAPI (CryptProtectData) 加密 API key，存储在 %APPDATA%\murasaki\secrets.json
//! Provider 元数据（名称、URL、Model 等）以明文存储，仅 API key 字段加密
//!
//! 文件结构 secrets.json:
//! ```json
//! {
//!   "version": 1,
//!   "providers": [
//!     {
//!       "id": "uuid",
//!       "name": "DeepSeek",
//!       "type": "deepseek",
//!       "baseUrl": "https://api.deepseek.com",
//!       "model": "deepseek-v4-flash",
//!       "apiKeyEnc": "base64-encrypted-blob",
//!       "isActive": true
//!     }
//!   ]
//! }
//! ```

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// AI Provider 类型（与前端 AiProvider["type"] 联合类型对齐）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    Deepseek,
    Openai,
    Custom,
}

impl Default for ProviderType {
    fn default() -> Self {
        ProviderType::Custom
    }
}

/// AI Provider 配置（前端可见，apiKey 字段不返回明文）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    /// 唯一 ID（UUID v4）
    pub id: String,
    /// 显示名称
    pub name: String,
    /// Provider 类型（deepseek / openai / custom）
    #[serde(rename = "type")]
    pub provider_type: ProviderType,
    /// Base URL（如 https://api.deepseek.com）
    pub base_url: String,
    /// 默认模型名
    pub model: String,
    /// 加密的 API key（base64 编码的 DPAPI 密文）
    /// 发送到前端时此字段为空字符串（前端不接收密文）
    #[serde(default)]
    pub api_key_enc: String,
    /// 是否为活动 provider（仅一个可为 true）
    #[serde(default)]
    pub is_active: bool,
}

/// secrets.json 文件结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretsFile {
    version: u32,
    providers: Vec<AiProvider>,
}

impl Default for SecretsFile {
    fn default() -> Self {
        Self {
            version: 1,
            providers: Vec::new(),
        }
    }
}

/// 获取 secrets.json 文件路径：%APPDATA%\murasaki\secrets.json
fn secrets_file_path() -> Result<PathBuf, String> {
    let base = dirs::data_dir()
        .ok_or_else(|| "无法确定 app data 目录".to_string())?;
    let dir = base.join("murasaki");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir.join("secrets.json"))
}

/// 读取 secrets.json，不存在则返回默认空结构
fn read_secrets() -> Result<SecretsFile, String> {
    let path = secrets_file_path()?;
    if !path.exists() {
        return Ok(SecretsFile::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(SecretsFile::default());
    }
    serde_json::from_str::<SecretsFile>(&content)
        .map_err(|e| format!("解析 secrets.json 失败: {}", e))
}

/// 写入 secrets.json
fn write_secrets(secrets: &SecretsFile) -> Result<(), String> {
    let path = secrets_file_path()?;
    let json = serde_json::to_string_pretty(secrets).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

// ===== base64 编解码（平台无关，避免引入额外依赖） =====
mod base64 {
    const B64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(data: &[u8]) -> String {
        let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
        let mut i = 0;
        while i + 2 < data.len() {
            let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
            result.push(B64_CHARS[((n >> 18) & 0x3f) as usize] as char);
            result.push(B64_CHARS[((n >> 12) & 0x3f) as usize] as char);
            result.push(B64_CHARS[((n >> 6) & 0x3f) as usize] as char);
            result.push(B64_CHARS[(n & 0x3f) as usize] as char);
            i += 3;
        }
        let rem = data.len() - i;
        if rem == 1 {
            let n = (data[i] as u32) << 16;
            result.push(B64_CHARS[((n >> 18) & 0x3f) as usize] as char);
            result.push(B64_CHARS[((n >> 12) & 0x3f) as usize] as char);
            result.push('=');
            result.push('=');
        } else if rem == 2 {
            let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
            result.push(B64_CHARS[((n >> 18) & 0x3f) as usize] as char);
            result.push(B64_CHARS[((n >> 12) & 0x3f) as usize] as char);
            result.push(B64_CHARS[((n >> 6) & 0x3f) as usize] as char);
            result.push('=');
        }
        result
    }

    pub fn decode(s: &str) -> Result<Vec<u8>, String> {
        let s = s.trim_end_matches('=');
        let mut buf = Vec::with_capacity(s.len() * 3 / 4);
        let mut n: u32 = 0;
        let mut bits: u32 = 0;
        for c in s.bytes() {
            let v = match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => return Err(format!("invalid base64 char: {}", c as char)),
            };
            n = (n << 6) | (v as u32);
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                buf.push((n >> bits) as u8);
                n &= (1 << bits) - 1;
            }
        }
        Ok(buf)
    }
}

// ===== Windows DPAPI =====
//
// 仅 Windows 平台使用 DPAPI（CryptProtectData / CryptUnprotectData）
// 其他平台回退到 base64 编码（仅用于开发/测试，生产环境仅支持 Windows）

#[cfg(windows)]
mod dpapi {
    use super::base64;

    /// Windows API 类型别名
    type DWORD = u32;
    type BOOL = i32;
    type HANDLE = *mut std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct CryptoApiBlob {
        cb_data: DWORD,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const CryptoApiBlob,
            sz_data_descr: *const u16,
            optional_entropy: *const CryptoApiBlob,
            reserved: *const std::ffi::c_void,
            prompt_struct: *const std::ffi::c_void,
            flags: DWORD,
            data_out: *mut CryptoApiBlob,
        ) -> BOOL;

        fn CryptUnprotectData(
            data_in: *const CryptoApiBlob,
            ppsz_data_descr: *mut *mut u16,
            optional_entropy: *const CryptoApiBlob,
            reserved: *const std::ffi::c_void,
            prompt_struct: *const std::ffi::c_void,
            flags: DWORD,
            data_out: *mut CryptoApiBlob,
        ) -> BOOL;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: HANDLE) -> HANDLE;
    }

    /// 使用 DPAPI 加密数据，返回 base64 编码的密文
    pub fn encrypt(plaintext: &[u8]) -> Result<String, String> {
        unsafe {
            let data_in = CryptoApiBlob {
                cb_data: plaintext.len() as DWORD,
                pb_data: plaintext.as_ptr() as *mut u8,
            };
            let mut data_out: CryptoApiBlob = CryptoApiBlob::default();
            let ok = CryptProtectData(
                &data_in,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut data_out,
            );
            if ok == 0 {
                return Err(format!("CryptProtectData 失败，错误码: {}", std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)));
            }
            let cipher = std::slice::from_raw_parts(data_out.pb_data, data_out.cb_data as usize).to_vec();
            LocalFree(data_out.pb_data as HANDLE);
            Ok(base64::encode(&cipher))
        }
    }

    /// 使用 DPAPI 解密 base64 编码的密文，返回明文
    pub fn decrypt(cipher_b64: &str) -> Result<Vec<u8>, String> {
        let cipher = base64::decode(cipher_b64)?;
        unsafe {
            let data_in = CryptoApiBlob {
                cb_data: cipher.len() as DWORD,
                pb_data: cipher.as_ptr() as *mut u8,
            };
            let mut data_out: CryptoApiBlob = CryptoApiBlob::default();
            let mut descr_ptr: *mut u16 = std::ptr::null_mut();
            let ok = CryptUnprotectData(
                &data_in,
                &mut descr_ptr,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut data_out,
            );
            // descr 不需要，释放（若分配）
            if !descr_ptr.is_null() {
                LocalFree(descr_ptr as HANDLE);
            }
            if ok == 0 {
                return Err(format!("CryptUnprotectData 失败，错误码: {}", std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)));
            }
            let plain = std::slice::from_raw_parts(data_out.pb_data, data_out.cb_data as usize).to_vec();
            LocalFree(data_out.pb_data as HANDLE);
            Ok(plain)
        }
    }
}

#[cfg(not(windows))]
mod dpapi {
    use super::base64;

    /// 非 Windows 平台：简单 base64 编码（仅用于开发测试）
    pub fn encrypt(plaintext: &[u8]) -> Result<String, String> {
        Ok(base64::encode(plaintext))
    }
    pub fn decrypt(cipher_b64: &str) -> Result<Vec<u8>, String> {
        base64::decode(cipher_b64)
    }
}

// ===== Tauri Commands =====

/// 返回所有 provider 列表（不返回 apiKey 明文，apiKeyEnc 也清空避免泄露密文）
#[tauri::command]
pub fn get_ai_providers() -> Result<Vec<AiProvider>, String> {
    let secrets = read_secrets()?;
    // 返回给前端时清空 apiKeyEnc 字段（避免密文泄露到 WebView）
    let safe_providers = secrets
        .providers
        .into_iter()
        .map(|mut p| {
            p.api_key_enc = String::new();
            p
        })
        .collect();
    Ok(safe_providers)
}

/// 保存（新增或更新）provider
/// 若 provider.id 为空，生成新 UUID
/// 若 api_key 为空字符串，保留原密文（用于只更新其他字段的情况）
#[tauri::command]
pub fn save_ai_provider(
    mut provider: AiProvider,
    api_key: String,
) -> Result<AiProvider, String> {
    if provider.id.is_empty() {
        provider.id = Uuid::new_v4().to_string();
    }

    let mut secrets = read_secrets()?;

    // 若传入新 api_key（非空），加密；若为空，保留原密文
    if !api_key.is_empty() {
        provider.api_key_enc = dpapi::encrypt(api_key.as_bytes())?;
    } else if let Some(existing) = secrets.providers.iter().find(|p| p.id == provider.id) {
        provider.api_key_enc = existing.api_key_enc.clone();
    }

    // 若此 provider 被设为活动，先将其他全部置为非活动
    if provider.is_active {
        for p in secrets.providers.iter_mut() {
            p.is_active = false;
        }
    }
    // upsert
    if let Some(idx) = secrets.providers.iter().position(|p| p.id == provider.id) {
        secrets.providers[idx] = provider.clone();
    } else {
        secrets.providers.push(provider.clone());
    }
    write_secrets(&secrets)?;

    // 返回时清空密文
    let mut result = provider;
    result.api_key_enc = String::new();
    Ok(result)
}

/// 删除 provider
#[tauri::command]
pub fn delete_ai_provider(id: String) -> Result<(), String> {
    let mut secrets = read_secrets()?;
    let before = secrets.providers.len();
    secrets.providers.retain(|p| p.id != id);
    if secrets.providers.len() == before {
        return Err(format!("Provider 不存在: {}", id));
    }
    write_secrets(&secrets)
}

/// 设置活动 provider
#[tauri::command]
pub fn set_active_provider(id: String) -> Result<(), String> {
    let mut secrets = read_secrets()?;
    let mut found = false;
    for p in secrets.providers.iter_mut() {
        if p.id == id {
            p.is_active = true;
            found = true;
        } else {
            p.is_active = false;
        }
    }
    if !found {
        return Err(format!("Provider 不存在: {}", id));
    }
    write_secrets(&secrets)
}

/// 获取明文 API key（每次对话调用，前端不缓存）
#[tauri::command]
pub fn get_api_key(id: String) -> Result<String, String> {
    let secrets = read_secrets()?;
    let provider = secrets
        .providers
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Provider 不存在: {}", id))?;
    if provider.api_key_enc.is_empty() {
        return Err("Provider 未配置 API key".to_string());
    }
    let plain = dpapi::decrypt(&provider.api_key_enc)?;
    String::from_utf8(plain).map_err(|e| format!("API key 解密后非 UTF-8: {}", e))
}

/// 测试 provider 连接
/// 先尝试 GET {baseUrl}/models，失败则 fallback 到 1-token chat 请求
/// 返回成功时的模型列表（若 /models 返回），或空数组（若 fallback 成功）
#[tauri::command]
pub async fn test_provider_connection(
    base_url: String,
    api_key: String,
    model: String,
) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    // 规范化 URL：去掉尾部斜杠
    let base = base_url.trim_end_matches('/');

    // 1) 尝试 GET /models（OpenAI 兼容端点）
    let models_url = format!("{}/v1/models", base);
    let resp = client
        .get(&models_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await;

    if let Ok(resp) = resp {
        if resp.status().is_success() {
            // 解析 {"data": [{"id": "model-name"}, ...]}
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("解析 /models 响应失败: {}", e))?;
            let models = body
                .get("data")
                .and_then(|d| d.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(String::from))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if !models.is_empty() {
                return Ok(models);
            }
        }
    }

    // 2) Fallback: 1-token chat 请求
    let chat_url = format!("{}/v1/chat/completions", base);
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
        "stream": false
    });
    let resp = client
        .post(&chat_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连接失败: {}", e))?;

    if resp.status().is_success() {
        // 连接成功，返回空数组（无模型列表）
        Ok(Vec::new())
    } else {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Err(format!("HTTP {}: {}", status, text))
    }
}

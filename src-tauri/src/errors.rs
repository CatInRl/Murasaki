//! 命令层错误（#436）。
//!
//! 所有 Tauri 命令统一返回 `Result<T, CommandError>`：错误序列化为
//! `{ code, params }` 结构化对象，**文案由前端 i18n 按 code 渲染**——
//! Rust 侧不再拼中文，前端也不必匹配中文字符串来判断失败原因。
//!
//! `params` 只放用户可读的上下文（路径、目标、系统错误详情），键名稳定，
//! 前端在 locale 文案里用 `{path}` / `{detail}` 等占位符插值。

use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::Path;

/// 稳定的错误码。新增值时同步更新前端 `src/utils/commandError.ts` 与三套 locale。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// 文件 / 目录 / 草稿 / 工作区不存在
    NotFound,
    /// 期望目录，实际不是
    NotADirectory,
    /// 期望文件，实际不是
    NotAFile,
    /// 目标已存在（创建 / 重命名 / 复制 / 移动）
    AlreadyExists,
    /// 没有权限（来自 IO 的 PermissionDenied）
    PermissionDenied,
    /// 路径必须是工作区内的相对路径
    OutsideWorkspace,
    /// 参数非法（非法正则、非法目录名等）
    InvalidArgument,
    /// 操作本身不支持（平台 / 类型限制）
    Unsupported,
    /// 超时（导航、等待回调等）
    Timeout,
    /// 内部错误（任务 join 失败、锁中毒、第三方调用失败）
    Internal,
    /// 其它 IO 错误（`detail` 携带系统原文）
    Io,
}

/// 命令错误：`code` 定类别，`params` 带上下文。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub code: ErrorCode,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
}

impl CommandError {
    pub fn new(code: ErrorCode) -> Self {
        Self {
            code,
            params: BTreeMap::new(),
        }
    }

    /// 附加一个用于前端插值的参数（同名键覆盖）。
    pub fn with_param(mut self, key: &str, value: impl Into<String>) -> Self {
        self.params.insert(key.to_string(), value.into());
        self
    }

    /// 以 `path` 参数构造（绝大多数错误都带路径）。
    pub fn path(code: ErrorCode, path: impl AsRef<Path>) -> Self {
        Self::new(code).with_param("path", path.as_ref().to_string_lossy().to_string())
    }

    /// 从 `std::io::Error` 映射，并附上出错路径。
    pub fn io_at(err: &io::Error, path: impl AsRef<Path>) -> Self {
        let code = match err.kind() {
            io::ErrorKind::NotFound => ErrorCode::NotFound,
            io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            io::ErrorKind::AlreadyExists => ErrorCode::AlreadyExists,
            io::ErrorKind::InvalidInput => ErrorCode::InvalidArgument,
            io::ErrorKind::TimedOut => ErrorCode::Timeout,
            _ => ErrorCode::Io,
        };
        Self::path(code, path).with_param("detail", err.to_string())
    }

    /// 内部错误：第三方库 / 任务调度失败，`detail` 保留原始错误文案。
    pub fn internal(detail: impl ToString) -> Self {
        Self::new(ErrorCode::Internal).with_param("detail", detail.to_string())
    }
}

impl From<io::Error> for CommandError {
    fn from(err: io::Error) -> Self {
        let code = match err.kind() {
            io::ErrorKind::NotFound => ErrorCode::NotFound,
            io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            io::ErrorKind::AlreadyExists => ErrorCode::AlreadyExists,
            io::ErrorKind::InvalidInput => ErrorCode::InvalidArgument,
            io::ErrorKind::TimedOut => ErrorCode::Timeout,
            _ => ErrorCode::Io,
        };
        Self::new(code).with_param("detail", err.to_string())
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.code)?;
        if !self.params.is_empty() {
            let params = self
                .params
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(", ");
            write!(f, " ({params})")?;
        }
        Ok(())
    }
}

impl std::error::Error for CommandError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_kinds_map_to_stable_codes() {
        let cases = [
            (io::ErrorKind::NotFound, ErrorCode::NotFound),
            (io::ErrorKind::PermissionDenied, ErrorCode::PermissionDenied),
            (io::ErrorKind::AlreadyExists, ErrorCode::AlreadyExists),
            (io::ErrorKind::InvalidInput, ErrorCode::InvalidArgument),
            (io::ErrorKind::TimedOut, ErrorCode::Timeout),
            (io::ErrorKind::Other, ErrorCode::Io),
        ];
        for (kind, code) in cases {
            let err: CommandError = io::Error::new(kind, "boom").into();
            assert_eq!(err.code, code);
            assert_eq!(err.params.get("detail").map(String::as_str), Some("boom"));
        }
    }

    #[test]
    fn io_at_carries_path_and_detail() {
        let err = CommandError::io_at(&io::Error::from(io::ErrorKind::NotFound), "C:/ws/a.md");
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(err.params.get("path").map(String::as_str), Some("C:/ws/a.md"));
        assert!(err.params.contains_key("detail"));
    }

    #[test]
    fn serializes_as_code_and_params() {
        let err = CommandError::path(ErrorCode::NotFound, "C:/ws/a.md");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "not_found");
        assert_eq!(json["params"]["path"], "C:/ws/a.md");
    }

    #[test]
    fn empty_params_are_omitted() {
        let json = serde_json::to_value(CommandError::new(ErrorCode::Internal)).unwrap();
        assert_eq!(json["code"], "internal");
        assert!(json.get("params").is_none());
    }
}

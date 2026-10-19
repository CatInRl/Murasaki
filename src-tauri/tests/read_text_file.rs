//! 文件读取的集成测试（#445）。
//!
//! 覆盖「非 UTF-8 文件」这条最容易把应用打挂的边界：读取应返回结构化
//! `io` 错误，而不是 panic 或把损坏内容当成正文。

use murasaki_lib::commands::files::read_text_file;
use murasaki_lib::errors::ErrorCode;
use murasaki_lib::security::policy;

#[test]
fn reads_utf8_text_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("ok.md");
    std::fs::write(&path, "# 标题\n\n正文\n").expect("write fixture");
    policy().allow_read_root(dir.path());

    let text = tauri::async_runtime::block_on(read_text_file(path.to_string_lossy().into_owned()))
        .expect("valid UTF-8 should be readable");
    assert_eq!(text, "# 标题\n\n正文\n");
}

#[test]
fn rejects_non_utf8_file_with_io_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("bad.md");
    std::fs::write(&path, [0xFF, 0xFE, 0x00, 0x80]).expect("write binary fixture");
    policy().allow_read_root(dir.path());

    let err = tauri::async_runtime::block_on(read_text_file(path.to_string_lossy().into_owned()))
        .expect_err("invalid UTF-8 must fail");
    assert_eq!(err.code, ErrorCode::Io, "错误码应保持为 io: {err:?}");
    assert!(
        err.params.get("path").is_some(),
        "错误应带上出错路径，便于前端提示: {err:?}"
    );
}

#[test]
fn rejects_path_outside_policy() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("secret.md");
    std::fs::write(&path, "secret").expect("write fixture");

    // 故意不授权该目录：路径白名单应拒绝读取
    let err = tauri::async_runtime::block_on(read_text_file(path.to_string_lossy().into_owned()))
        .expect_err("unauthorized path must be rejected");
    assert_eq!(err.code, ErrorCode::OutsideWorkspace, "{err:?}");
}

pub mod assets;
pub mod drafts;
pub mod files;
pub mod launch;
pub mod lifecycle;
pub mod locale;
pub mod menu;
pub mod outline;
pub mod pdf;
pub mod search;
pub mod settings;
pub mod watcher;
pub mod windows;

use sha1::{Digest, Sha1};

/// 计算字节序列的 SHA1 摘要并转成小写十六进制串（40 字符）。
///
/// 草稿文件名（`drafts/<hash>`）与资源短哈希都依赖
/// 这个编码：一旦变化，老用户就找不到既有文件。所以集中在这里，并用已知答案测试固定住。
pub(crate) fn sha1_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::sha1_hex;

    #[test]
    fn sha1_hex_matches_known_answer() {
        // 固定「小写、每字节两位、无分隔符」这一编码约定
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            sha1_hex(b"abc"),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
    }
}

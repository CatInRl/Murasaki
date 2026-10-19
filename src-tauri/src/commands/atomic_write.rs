use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process;

/// 原子写入：同目录临时文件 → 写满并 fsync → 继承原权限 → rename 覆盖目标。
///
/// 直接 `fs::write` 是「截断 + 就地写」，进程崩溃、断电或磁盘写满会留下
/// 0 字节或半截文件。对编辑器而言这等于用户正文损坏，所以所有会改动用户
/// 可见内容的写入都必须走这里。
pub(crate) fn write_atomic(path: &Path, content: &[u8]) -> io::Result<()> {
    // 目标是符号链接时改写真实文件，避免 rename 把链接本身替换成普通文件
    let target = resolve_symlink(path);
    let path = target.as_path();

    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "目标路径没有父目录"))?;
    fs::create_dir_all(parent)?;

    // rename 会带走临时文件的权限，先记住原文件的再补回去
    let permissions = fs::metadata(path)
        .ok()
        .map(|metadata| metadata.permissions());
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("murasaki");

    let (tmp_path, mut file) = create_temp_file(parent, file_name)?;

    let write_result = file.write_all(content).and_then(|_| file.sync_all());
    // Windows 上必须先关闭句柄才能 rename 覆盖
    drop(file);

    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }

    if let Some(permissions) = permissions {
        if let Err(error) = fs::set_permissions(&tmp_path, permissions) {
            let _ = fs::remove_file(&tmp_path);
            return Err(error);
        }
    }

    if let Err(error) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }

    // rename 本身是原子的；再把目录项也刷盘，降低断电后「文件在、名字丢」的概率
    #[cfg(unix)]
    {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

/// 目标是符号链接时返回其真实路径；`fs::write` 原本会写穿链接，rename 不会。
fn resolve_symlink(path: &Path) -> PathBuf {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
        }
        _ => path.to_path_buf(),
    }
}

fn create_temp_file(parent: &Path, file_name: &str) -> io::Result<(PathBuf, File)> {
    for attempt in 0..16u32 {
        let candidate = parent.join(format!(".{}.tmp-{}-{}", file_name, process::id(), attempt));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        ErrorKind::AlreadyExists,
        "无法在目标目录创建临时文件",
    ))
}

#[cfg(test)]
mod tests {
    use super::write_atomic;
    use std::fs;
    use std::io::ErrorKind;

    #[test]
    fn writes_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");

        write_atomic(&path, b"hello").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
    }

    #[test]
    fn replaces_existing_file_without_leaving_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "old").unwrap();

        write_atomic(&path, b"new content").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new content");
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["note.md".to_string()]);
    }

    #[test]
    fn creates_missing_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("deep").join("note.md");

        write_atomic(&path, b"content").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "content");
    }

    #[test]
    fn rejects_path_without_parent() {
        let error = write_atomic(std::path::Path::new(""), b"x").unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidInput);
    }

    #[test]
    fn failure_keeps_target_and_cleans_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        // 目标是目录：写入成功但 rename 必然失败
        let target = dir.path().join("note.md");
        fs::create_dir(&target).unwrap();

        let error = write_atomic(&target, b"content").unwrap_err();

        assert!(!error.to_string().is_empty());
        assert!(target.is_dir(), "目标目录不应被破坏");
        let leftovers: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "临时文件未清理: {leftovers:?}");
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_symlink_without_replacing_it() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        let link = dir.path().join("link.md");
        fs::write(&real, "old").unwrap();
        symlink(&real, &link).unwrap();

        write_atomic(&link, b"new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
    }
}

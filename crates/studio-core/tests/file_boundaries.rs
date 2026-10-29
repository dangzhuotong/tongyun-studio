#![cfg(unix)]
use std::{fs, os::unix::fs::symlink};
use studio_core::{append_project_file, write_project_file, Project};
#[test]
fn writing_rejects_symlink_files_and_parents_without_external_side_effects() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let project = Project {
        id: "test".into(),
        name: "test".into(),
        path: root.path().to_str().unwrap().into(),
        created_at: String::new(),
        dev: None,
    };
    let sentinel = outside.path().join("sentinel.txt");
    fs::write(&sentinel, "keep me").unwrap();
    symlink(&sentinel, root.path().join("linked.txt")).unwrap();
    assert!(write_project_file(&project, "linked.txt", "replaced").is_err());
    assert!(append_project_file(&project, "linked.txt", "appended").is_err());
    assert_eq!(fs::read_to_string(&sentinel).unwrap(), "keep me");
    symlink(outside.path(), root.path().join("external")).unwrap();
    assert!(write_project_file(&project, "external/created/file.txt", "data").is_err());
    assert!(!outside.path().join("created").exists());
    assert!(write_project_file(&project, "/absolute.txt", "data").is_err());
    assert!(!root.path().join("absolute.txt").exists());
}

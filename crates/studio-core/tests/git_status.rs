use std::{fs, process::Command};
use studio_core::{get_git_changed_files, git_stage_file, Project};
#[test]
fn status_preserves_unstaged_column_and_literal_non_ascii_filenames() {
    let root = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        assert!(Command::new("git")
            .arg("-C")
            .arg(root.path())
            .args(args)
            .status()
            .unwrap()
            .success());
    };
    git(&["init", "-q"]);
    git(&["config", "core.hooksPath", "/dev/null"]);
    let path = " 空 格中文.txt";
    fs::write(root.path().join(path), "before").unwrap();
    git(&["add", "--", path]);
    git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "initial",
    ]);
    let project = Project {
        id: "test".into(),
        name: "test".into(),
        path: root.path().to_str().unwrap().into(),
        created_at: String::new(),
        dev: None,
    };
    fs::write(root.path().join(path), "after").unwrap();
    let changes = get_git_changed_files(&project).unwrap();
    assert_eq!(changes.len(), 1);
    assert!(
        !changes[0].staged,
        "an unstaged change must not become staged"
    );
    assert_eq!(changes[0].path, path);
    git_stage_file(&project, &changes[0].path).unwrap();
    assert!(get_git_changed_files(&project).unwrap()[0].staged);
    git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "changed",
    ]);
    git(&["mv", "--", path, "renamed.txt"]);
    let renamed = get_git_changed_files(&project).unwrap();
    assert_eq!(renamed.len(), 1);
    assert_eq!(renamed[0].path, "renamed.txt");
}

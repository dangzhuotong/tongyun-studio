use std::{fs, path::Path, process::Command};
use studio_core::{create_git_commit, Project};

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}
fn repository() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q"]);
    for (key, value) in [
        ("user.name", "Studio Test"),
        ("user.email", "studio@example.invalid"),
        ("commit.gpgsign", "false"),
        ("core.hooksPath", "/dev/null"),
    ] {
        git(dir.path(), &["config", key, value]);
    }
    fs::write(dir.path().join("a.txt"), "a original\n").unwrap();
    fs::write(dir.path().join("b.txt"), "b original\n").unwrap();
    git(dir.path(), &["add", "a.txt", "b.txt"]);
    git(dir.path(), &["commit", "-qm", "initial"]);
    let project = Project {
        id: "test".into(),
        name: "test".into(),
        path: dir.path().to_string_lossy().into(),
        created_at: String::new(),
        dev: None,
    };
    (dir, project)
}

#[test]
fn commit_contains_only_staged_files() {
    let (dir, project) = repository();
    fs::write(dir.path().join("a.txt"), "a staged\n").unwrap();
    fs::write(dir.path().join("b.txt"), "b unstaged\n").unwrap();
    fs::write(dir.path().join("untracked.txt"), "not selected").unwrap();
    git(dir.path(), &["add", "a.txt"]);
    create_git_commit(&project, "only staged a").unwrap();
    assert_eq!(git(dir.path(), &["show", "HEAD:a.txt"]), "a staged\n");
    assert_eq!(git(dir.path(), &["show", "HEAD:b.txt"]), "b original\n");
    assert_eq!(
        git(dir.path(), &["status", "--porcelain"]),
        " M b.txt\n?? untracked.txt\n"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("b.txt")).unwrap(),
        "b unstaged\n"
    );
}

#[test]
fn commit_preserves_partial_staging_of_the_same_file() {
    let (dir, project) = repository();
    fs::write(dir.path().join("a.txt"), "selected change\n").unwrap();
    git(dir.path(), &["add", "a.txt"]);
    fs::write(
        dir.path().join("a.txt"),
        "selected change\nadditional unselected change\n",
    )
    .unwrap();
    let unstaged_before = git(dir.path(), &["diff"]);
    create_git_commit(&project, "partial file").unwrap();
    assert_eq!(
        git(dir.path(), &["show", "HEAD:a.txt"]),
        "selected change\n"
    );
    assert_eq!(git(dir.path(), &["diff"]), unstaged_before);
    assert_eq!(git(dir.path(), &["diff", "--cached"]), "");
}

#[test]
fn no_staged_changes_does_not_commit_worktree() {
    let (dir, project) = repository();
    fs::write(dir.path().join("a.txt"), "unstaged\n").unwrap();
    let head = git(dir.path(), &["rev-parse", "HEAD"]);
    assert!(create_git_commit(&project, "nothing selected").is_err());
    assert_eq!(git(dir.path(), &["rev-parse", "HEAD"]), head);
    assert_eq!(git(dir.path(), &["status", "--porcelain"]), " M a.txt\n");
}

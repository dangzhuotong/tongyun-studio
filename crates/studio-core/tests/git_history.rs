use std::{fs, process::Command};
use studio_core::{
    get_git_commit_details, get_git_commit_file_diff, get_git_history, Project,
};

fn project(root: &std::path::Path) -> Project {
    Project {
        id: "test".into(),
        name: "test".into(),
        path: root.to_str().unwrap().into(),
        created_at: String::new(),
        dev: None,
    }
}

struct Fixture {
    root: std::path::PathBuf,
}

impl Fixture {
    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(["-c", "core.hooksPath=/dev/null"])
            .args(["-c", "user.name=Test"])
            .args(["-c", "user.email=test@example.invalid"])
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn write_and_commit(&self, file: &str, content: &str, message: &str) -> String {
        fs::write(self.root.join(file), content).unwrap();
        self.git(&["add", "--", file]);
        self.git(&["commit", "-qm", message])
    }

    fn oid_of(&self, rev: &str) -> String {
        self.git(&["rev-parse", rev])
    }
}

fn init_repo(dir: &std::path::Path) -> Fixture {
    let git = |args: &[&str]| {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success());
    };
    git(&["init", "-q", "-b", "main", dir.to_str().unwrap()]);
    Fixture {
        root: dir.to_path_buf(),
    }
}

#[test]
fn empty_repository_degrades_to_empty_history() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    let history = get_git_history(&project(dir.path()), None, Some(10), None).unwrap();
    assert!(history.commits.is_empty());
    assert_eq!(history.total, 0);
    assert!(!history.has_more);
    // The branch exists but has no commit yet; details must not panic.
    let err = get_git_commit_details(&project(dir.path()), "abcdef").unwrap_err();
    assert!(!err.is_empty());
    // sanity: fixture really is a repo
    assert_eq!(fixture.git(&["symbolic-ref", "--short", "HEAD"]), "main");
}

fn build_diamond(dir: &std::path::Path) -> Fixture {
    let fixture = init_repo(dir);
    fixture.write_and_commit("base.txt", "base", "chore: initial");
    fixture.write_and_commit("main.txt", "one", "feat: main one");
    fixture.git(&["branch", "feature"]);
    fixture.git(&["checkout", "-q", "feature"]);
    fixture.write_and_commit("feature.txt", "f1", "feat: feature work");
    fixture.git(&["tag", "-a", "-m", "v1", "v1"]);
    fixture.git(&["checkout", "-q", "main"]);
    fixture.write_and_commit("main.txt", "two", "fix: main two");
    fixture.git(&["merge", "--no-ff", "-q", "-m", "Merge branch 'feature'", "feature"]);
    fixture
}

#[test]
fn history_reports_topology_refs_and_pagination() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = build_diamond(dir.path());
    let merged = fixture.oid_of("main");
    let tagged = fixture.oid_of("v1^{commit}");

    let full = get_git_history(&project(dir.path()), None, Some(50), Some(false)).unwrap();
    assert_eq!(full.commits.len(), 5, "first-parent + merge history");
    assert!(!full.has_more);
    assert_eq!(full.total, 5);

    let merge_row = full
        .commits
        .iter()
        .find(|c| c.oid == merged)
        .expect("merge commit present");
    assert_eq!(merge_row.parents.len(), 2, "merge commit keeps both parents");
    assert!(
        !merge_row.edges.is_empty(),
        "merge commit carries graph edges"
    );
    assert!(merge_row
        .edges
        .iter()
        .any(|e| e.from_col == merge_row.col && e.to_col != merge_row.col));

    let feature_row = full
        .commits
        .iter()
        .find(|c| c.oid == tagged)
        .expect("tagged commit present");
    assert!(feature_row.refs.iter().any(|r| r.kind == "tag" && r.name == "v1"));
    assert_ne!(
        feature_row.col, merge_row.col,
        "side branch occupies its own lane"
    );

    let head_row = full
        .commits
        .iter()
        .find(|c| c.oid == merged)
        .unwrap();
    assert!(
        head_row.refs.iter().any(|r| r.kind == "head" && r.name == "main"),
        "HEAD badge marks the checked-out branch tip"
    );
    assert_eq!(
        head_row
            .refs
            .iter()
            .filter(|r| r.kind == "head" || r.kind == "local")
            .count(),
        1,
        "the same branch name is not badge-duplicated"
    );

    // short oids, summaries, authors and timestamps come through
    for c in &full.commits {
        assert_eq!(c.short_oid.len(), 7);
        assert!(!c.summary.is_empty());
        assert_eq!(c.author_name, "Test");
        assert!(c.timestamp > 0);
    }

    let first_page = get_git_history(&project(dir.path()), Some(0), Some(2), None).unwrap();
    assert_eq!(first_page.commits.len(), 2);
    assert!(first_page.has_more);
    let second_page = get_git_history(&project(dir.path()), Some(2), Some(2), None).unwrap();
    assert_eq!(second_page.commits.len(), 2);
    let oids: Vec<&str> = full.commits.iter().map(|c| c.oid.as_str()).collect();
    assert_eq!(second_page.commits[0].oid, oids[2]);
}

#[test]
fn commit_details_cover_files_renames_and_diffs() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = build_diamond(dir.path());
    let root = project(dir.path());

    let root_oid = fixture.oid_of("main~3"); // "chore: initial"
    let merge_oid = fixture.oid_of("main"); // merge commit is the branch tip here
    let details = get_git_commit_details(&root, &root_oid).unwrap();
    assert!(details.parents.is_empty());
    assert_eq!(details.files.len(), 1);
    assert_eq!(details.files[0].path, "base.txt");
    assert_eq!(details.files[0].status, "A");
    assert!(details.message.contains("initial"));

    // rename tracking
    fixture.git(&["mv", "--", "base.txt", "renamed.txt"]);
    fixture.git(&["commit", "-qm", "refactor: rename file"]);
    let rename_oid = fixture.oid_of("HEAD");
    let rename_commit = get_git_commit_details(&root, &rename_oid).unwrap();
    assert_eq!(rename_commit.files.len(), 1);
    assert_eq!(rename_commit.files[0].status, "R");
    assert_eq!(rename_commit.files[0].path, "renamed.txt");
    assert_eq!(
        rename_commit.files[0].old_path.as_deref(),
        Some("base.txt")
    );

    // per-file diff against the first parent
    let diff = get_git_commit_file_diff(&root, &rename_oid, "renamed.txt", Some("base.txt")).unwrap();
    assert!(diff.contains("base.txt"), "diff names the old path: {diff}");

    // merge commit diffs against its first parent
    let merge_details = get_git_commit_details(&root, &merge_oid).unwrap();
    assert_eq!(merge_details.parents.len(), 2);
    let paths: Vec<&str> = merge_details.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"feature.txt"));

    // invalid oids are refused before touching git
    assert!(get_git_commit_details(&root, "not-a-hash").is_err());
    assert!(get_git_commit_details(&root, "12345678901234567890123456789012345678901234").is_err());
    assert!(get_git_commit_file_diff(&root, &merge_oid, "  ", None).is_err());
}

#[test]
fn large_history_stays_paginated_and_smooth() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = init_repo(dir.path());
    for i in 0..120 {
        fixture.write_and_commit("counter.txt", &i.to_string(), &format!("chore: commit {i}"));
    }
    let root = project(dir.path());
    let first = get_git_history(&root, None, Some(100), None).unwrap();
    assert_eq!(first.commits.len(), 100);
    assert!(first.has_more);
    assert_eq!(first.total, 120);
    let rest = get_git_history(&root, Some(100), Some(100), None).unwrap();
    assert_eq!(rest.commits.len(), 20);
    assert!(!rest.has_more);
    assert_eq!(rest.commits[0].col, 0, "linear history stays in lane zero");
    assert!(rest
        .commits
        .windows(2)
        .all(|w| w[0].parents.first() == Some(&w[1].oid)));
}

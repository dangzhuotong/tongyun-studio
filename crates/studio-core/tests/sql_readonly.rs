use rusqlite::Connection;
use std::{
    fs,
    time::{Duration, Instant},
};
use studio_core::{execute_sql_query, get_db_tables, get_table_columns, get_table_data, Project};

fn fixture() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let db = Connection::open(dir.path().join("test.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE notes(id INTEGER PRIMARY KEY, label TEXT NOT NULL); INSERT INTO notes VALUES (1, 'kept'), (2, 'second');").unwrap();
    drop(db);
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
fn rejects_writes_attach_pragmas_extensions_and_command_language() {
    let (dir, project) = fixture();
    let original = fs::read(dir.path().join("test.sqlite")).unwrap();
    let attached = dir.path().join("attached.sqlite");
    let attacks = vec![
        "DELETE FROM notes".to_owned(),
        "UPDATE notes SET label = 'changed'".into(),
        "INSERT INTO notes VALUES (3, 'added')".into(),
        "DROP TABLE notes".into(),
        "CREATE TABLE changed(x)".into(),
        "CREATE TEMP TABLE changed(x)".into(),
        "/* benign SELECT */ WITH chosen AS (SELECT 1) DELETE FROM notes WHERE id IN chosen".into(),
        format!("ATTACH DATABASE '{}' AS outside", attached.display()),
        format!("VACUUM INTO '{}'", attached.display()),
        "PRAGMA writable_schema=ON".into(),
        "PRAGMA journal_mode=WAL".into(),
        "PRAGMA user_version=5".into(),
        "PRAGMA query_only=OFF".into(),
        "SELECT load_extension('/tmp/nonexistent-studio-extension')".into(),
        ".shell touch should-not-exist".into(),
        ".read /tmp/should-not-exist".into(),
        "SELECT 1; DELETE FROM notes".into(),
        "SELECT 1; SELECT 2".into(),
        "BEGIN".into(),
    ];
    for sql in attacks {
        let result = execute_sql_query(&project, "test.sqlite", &sql).unwrap();
        assert!(result.error.is_some(), "unexpectedly accepted: {sql}");
        assert_eq!(
            fs::read(dir.path().join("test.sqlite")).unwrap(),
            original,
            "changed database: {sql}"
        );
        assert!(!attached.exists(), "created attached file: {sql}");
    }
}

#[test]
fn select_and_table_inspection_keep_column_order_and_duration_contract() {
    let (_dir, project) = fixture();
    let result = execute_sql_query(
        &project,
        "test.sqlite",
        "/* comment */ SELECT label, id FROM notes ORDER BY id; -- trailing comment",
    )
    .unwrap();
    assert!(result.error.is_none(), "{:?}", result.error);
    assert_eq!(result.columns, ["label", "id"]);
    assert_eq!(result.rows[0], ["kept", "1"]);
    let json = serde_json::to_value(result).unwrap();
    assert!(json.get("durationMs").unwrap().is_number());
    assert!(json.get("elapsedMs").is_none());
    let tables = get_db_tables(&project, "test.sqlite").unwrap();
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].name, "notes");
    let columns = get_table_columns(&project, "test.sqlite", "notes").unwrap();
    assert_eq!(columns[0].name, "id");
    assert!(columns[0].pk);
    assert_eq!(columns[1].name, "label");
    assert!(columns[1].not_null);
    let page = get_table_data(&project, "test.sqlite", "notes", 2, 1).unwrap();
    assert_eq!(page.total_rows, 2);
    assert_eq!(page.rows[0], ["2", "second"]);
    let empty = execute_sql_query(
        &project,
        "test.sqlite",
        "SELECT label, id FROM notes WHERE 0",
    )
    .unwrap();
    assert_eq!(empty.columns, ["label", "id"]);
    assert!(empty.rows.is_empty());
    let quoted = execute_sql_query(&project, "test.sqlite", "SELECT ';' AS delimiter").unwrap();
    assert!(quoted.error.is_none());
}

#[test]
fn query_budget_prevents_unbounded_results_and_expensive_ctes() {
    let (_dir, project) = fixture();
    let rows = execute_sql_query(&project, "test.sqlite", "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 1001) SELECT x FROM n").unwrap();
    assert!(rows.error.unwrap().contains("1000"));
    assert!(rows.rows.is_empty());
    let size = execute_sql_query(&project, "test.sqlite", "SELECT zeroblob(2000000)").unwrap();
    assert!(size.error.is_some());
    let bytes = execute_sql_query(
        &project,
        "test.sqlite",
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10) SELECT printf('%0500000d',x) FROM n",
    ).unwrap();
    assert!(bytes.error.unwrap().contains("4 MiB"));
    assert!(bytes.rows.is_empty());
    let start = Instant::now();
    let timeout = execute_sql_query(
        &project,
        "test.sqlite",
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n",
    )
    .unwrap();
    assert!(timeout.error.unwrap().contains("2 秒"));
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn missing_database_is_not_created_and_outside_paths_are_rejected() {
    let (dir, project) = fixture();
    assert!(execute_sql_query(&project, "new.sqlite", "SELECT 1").is_err());
    assert!(!dir.path().join("new.sqlite").exists());
    assert!(execute_sql_query(&project, "../outside.sqlite", "SELECT 1").is_err());
}

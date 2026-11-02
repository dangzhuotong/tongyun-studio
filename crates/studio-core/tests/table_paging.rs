use rusqlite::Connection;
use std::fs;
use studio_core::{get_table_columns, get_table_data, Project};

fn fixture() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let db = Connection::open(dir.path().join("paging.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE notes(id INTEGER PRIMARY KEY, label TEXT NOT NULL, note TEXT NULL);
         INSERT INTO notes VALUES (1,'a','first'),(2,'b',NULL),(3,'c','third'),(4,'d','fourth'),(5,'e','fifth');
         CREATE TABLE tagged(tag TEXT PRIMARY KEY, weight INTEGER);
         INSERT INTO tagged VALUES ('x',1),('y',2),('z''q',3),('w',4);
         CREATE TABLE links(a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY(a,b));
         INSERT INTO links VALUES (1,1),(1,2),(2,1),(2,2),(3,1);",
    )
    .unwrap();
    drop(db);
    let project = Project {
        id: "paging".into(),
        name: "paging".into(),
        path: dir.path().to_string_lossy().into(),
        created_at: String::new(),
        dev: None,
    };
    (dir, project)
}

fn keys(page: &studio_core::PaginatedData) -> Vec<String> {
    let index = page.columns.iter().position(|name| name == "id").unwrap();
    page.rows.iter().map(|row| row[index].clone()).collect()
}

#[test]
fn sequential_pages_use_the_primary_key_order_and_report_a_cursor() {
    let (_dir, project) = fixture();
    let first = get_table_data(&project, "paging.sqlite", "notes", 1, 2, None, None, None).unwrap();
    assert_eq!(keys(&first), ["1", "2"]);
    assert_eq!(first.total_rows, 5);
    assert_eq!(first.key_column.as_deref(), Some("id"));
    assert_eq!(first.sort_by.as_deref(), Some("id"));
    assert_eq!(first.sort_dir, "asc");
    assert_eq!(first.next_cursor.as_deref(), Some("2"));
    assert!(first.has_more);

    // A cursor continues after the last seen key instead of rescanning with OFFSET.
    let second = get_table_data(
        &project,
        "paging.sqlite",
        "notes",
        2,
        2,
        None,
        None,
        first.next_cursor.as_deref(),
    )
    .unwrap();
    assert_eq!(keys(&second), ["3", "4"]);
    assert_eq!(second.next_cursor.as_deref(), Some("4"));
    assert!(second.has_more);

    let last = get_table_data(
        &project,
        "paging.sqlite",
        "notes",
        3,
        2,
        None,
        None,
        second.next_cursor.as_deref(),
    )
    .unwrap();
    assert_eq!(keys(&last), ["5"]);
    assert!(!last.has_more);
}

#[test]
fn descending_paging_walks_backwards_from_the_cursor() {
    let (_dir, project) = fixture();
    let first = get_table_data(
        &project,
        "paging.sqlite",
        "notes",
        1,
        2,
        Some("id"),
        Some("desc"),
        None,
    )
    .unwrap();
    assert_eq!(keys(&first), ["5", "4"]);
    assert_eq!(first.sort_dir, "desc");
    let second = get_table_data(
        &project,
        "paging.sqlite",
        "notes",
        2,
        2,
        Some("id"),
        Some("desc"),
        first.next_cursor.as_deref(),
    )
    .unwrap();
    assert_eq!(keys(&second), ["3", "2"]);
}

#[test]
fn null_cells_are_returned_as_the_grid_sentinel() {
    let (_dir, project) = fixture();
    let page = get_table_data(&project, "paging.sqlite", "notes", 1, 5, None, None, None).unwrap();
    let note_index = page.columns.iter().position(|name| name == "note").unwrap();
    assert_eq!(page.rows[1][note_index], "NULL");
}

#[test]
fn sorting_by_a_non_key_column_pages_by_offset() {
    let (_dir, project) = fixture();
    let page = get_table_data(
        &project,
        "paging.sqlite",
        "notes",
        2,
        2,
        Some("label"),
        Some("desc"),
        None,
    )
    .unwrap();
    assert_eq!(page.sort_by.as_deref(), Some("label"));
    assert_eq!(keys(&page), ["3", "2"]);
    // A cursor is meaningless for a non-unique sort column, so it is ignored.
    let ignored = get_table_data(
        &project,
        "paging.sqlite",
        "notes",
        2,
        2,
        Some("label"),
        Some("desc"),
        Some("2"),
    )
    .unwrap();
    assert_eq!(keys(&ignored), ["3", "2"]);
}

#[test]
fn text_primary_keys_escape_the_cursor_and_composite_keys_stay_on_offset() {
    let (_dir, project) = fixture();
    let first = get_table_data(&project, "paging.sqlite", "tagged", 1, 2, None, None, None).unwrap();
    assert_eq!(first.next_cursor.as_deref(), Some("x"));
    let second = get_table_data(
        &project,
        "paging.sqlite",
        "tagged",
        2,
        2,
        None,
        None,
        first.next_cursor.as_deref(),
    )
    .unwrap();
    // The apostrophe inside the key must survive the literal round-trip.
    assert_eq!(
        second
            .rows
            .iter()
            .map(|row| row[0].clone())
            .collect::<Vec<_>>(),
        ["y", "z'q"]
    );
    let quoted = get_table_data(
        &project,
        "paging.sqlite",
        "tagged",
        2,
        2,
        None,
        None,
        Some("z'q' OR '1'='1"),
    )
    .unwrap();
    assert!(quoted.rows.is_empty());

    let link_columns = get_table_columns(&project, "paging.sqlite", "links").unwrap();
    let flagged: Vec<(String, i64)> = link_columns
        .iter()
        .filter(|column| column.pk)
        .map(|column| (column.name.clone(), column.pk_position))
        .collect();
    // PRAGMA reports the 1-based position inside the key, so both halves of a composite key count.
    assert_eq!(flagged, [("a".to_owned(), 1), ("b".to_owned(), 2)]);

    let composite = get_table_data(&project, "paging.sqlite", "links", 2, 2, None, None, None).unwrap();
    assert_eq!(composite.key_column, None);
    assert_eq!(composite.next_cursor, None);
    assert_eq!(composite.rows.len(), 2);
    assert!(composite.has_more);
}

#[test]
fn hostile_sort_and_cursor_values_are_rejected_without_touching_the_database() {
    let (dir, project) = fixture();
    let original = fs::read(dir.path().join("paging.sqlite")).unwrap();
    let attacks = [
        ("notes", Some("label; DROP TABLE notes"), None, None),
        ("notes", None, Some("1 OR 1=1"), None),
        ("notes", None, Some("1); DELETE FROM notes;--"), None),
        ("no_table", None, None, None),
    ];
    for (table, sort, cursor, dir_hint) in attacks {
        let outcome = get_table_data(&project, "paging.sqlite", table, 1, 2, sort, dir_hint, cursor);
        assert!(outcome.is_err(), "unexpectedly accepted {table}/{sort:?}/{cursor:?}");
    }
    assert_eq!(fs::read(dir.path().join("paging.sqlite")).unwrap(), original);
    assert!(get_table_data(&project, "paging.sqlite", "notes", 1, 2, None, None, Some("2"))
        .unwrap()
        .rows
        .iter()
        .all(|row| row[0].parse::<i64>().unwrap() > 2));
}

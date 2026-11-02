use rusqlite::Connection;
use studio_core::{
    get_table_columns, plan_row_change, ColumnChange, DbColumnInfo, Project, RowChangePlan,
};

fn column(name: &str, data_type: &str, pk: bool, not_null: bool) -> DbColumnInfo {
    DbColumnInfo {
        cid: 0,
        name: name.into(),
        data_type: data_type.into(),
        not_null,
        dflt_value: None,
        pk,
        pk_position: if pk { 1 } else { 0 },
    }
}

fn notes_columns() -> Vec<DbColumnInfo> {
    vec![
        column("id", "INTEGER", true, false),
        column("label", "TEXT", false, true),
        column("note", "TEXT", false, false),
    ]
}

fn change(column: &str, old: &str, new: &str) -> ColumnChange {
    ColumnChange {
        column: column.into(),
        old_value: old.into(),
        new_value: new.into(),
    }
}

fn bind(plan: &RowChangePlan, db: &Connection) -> rusqlite::Result<usize> {
    let mut statement = db.prepare(&plan.forward_sql)?;
    let bound: Vec<&dyn rusqlite::ToSql> = plan
        .forward_parameters
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    statement.execute(bound.as_slice())
}

#[test]
fn update_plan_is_parameterised_and_carries_the_reverse_binding() {
    let plan = plan_row_change(
        "notes",
        &notes_columns(),
        &["2".into()],
        &[change("label", "second", "renamed"), change("note", "NULL", "added")],
    )
    .unwrap();
    assert_eq!(
        plan.forward_sql,
        "UPDATE \"notes\" SET \"label\" = ?, \"note\" = ? WHERE \"id\" = 2;"
    );
    assert_eq!(
        plan.rollback_sql,
        "UPDATE \"notes\" SET \"label\" = ?, \"note\" = ? WHERE \"id\" = 2;"
    );
    assert_eq!(
        plan.forward_parameters,
        vec![Some("renamed".into()), Some("added".into())]
    );
    // The grid renders a SQL NULL as "NULL"; the rollback must bind a real NULL back.
    assert_eq!(
        plan.rollback_parameters,
        vec![Some("second".into()), None]
    );
    assert_eq!(plan.changed_columns, ["label", "note"]);
    assert_eq!(plan.key_predicate, "\"id\" = 2");
    assert_eq!(plan.table, "notes");
}

#[test]
fn text_key_is_quoted_once_per_side_of_the_rollback() {
    let columns = vec![column("tag", "TEXT", true, false), column("note", "TEXT", false, false)];
    let plan = plan_row_change(
        "tagged",
        &columns,
        &["o'brien".into()],
        &[change("note", "old", "new")],
    )
    .unwrap();
    assert_eq!(
        plan.forward_sql,
        "UPDATE \"tagged\" SET \"note\" = ? WHERE \"tag\" = 'o''brien';"
    );
    assert_eq!(plan.rollback_parameters, vec![Some("old".into())]);
}

#[test]
fn plans_without_a_recoverable_key_or_real_change_are_refused() {
    let refused: Vec<(Vec<DbColumnInfo>, Vec<String>, Vec<ColumnChange>)> = vec![
        // no primary key at all
        (
            vec![column("label", "TEXT", false, false)],
            vec!["1".into()],
            vec![change("label", "a", "b")],
        ),
        // composite primary key cannot be addressed by one value
        (
            vec![column("a", "INTEGER", true, false), column("b", "INTEGER", true, false)],
            vec!["1".into()],
            vec![change("a", "1", "9")],
        ),
        // unknown column
        (
            notes_columns(),
            vec!["2".into()],
            vec![change("missing", "a", "b")],
        ),
        // editing the primary key itself
        (notes_columns(), vec!["2".into()], vec![change("id", "2", "7")]),
        // duplicate column in one row change
        (
            notes_columns(),
            vec!["2".into()],
            vec![change("label", "a", "b"), change("label", "b", "c")],
        ),
        // nothing actually changed
        (
            notes_columns(),
            vec!["2".into()],
            vec![change("label", "same", "same")],
        ),
        // value / key arity mismatch
        (notes_columns(), vec![], vec![change("label", "a", "b")]),
    ];
    for (columns, key_values, changes) in refused {
        assert!(
            plan_row_change("notes", &columns, &key_values, &changes).is_err(),
            "unexpectedly accepted"
        );
    }
    assert!(plan_row_change("bad;name", &notes_columns(), &["1".into()], &[change("label", "a", "b")]).is_err());
}

fn project_fixture() -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let db = Connection::open(dir.path().join("notes.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE notes(id INTEGER PRIMARY KEY, label TEXT NOT NULL, note TEXT NULL);
         INSERT INTO notes VALUES (1,'kept','orig'),(2,'second',NULL);",
    )
    .unwrap();
    drop(db);
    let project = Project {
        id: "notes".into(),
        name: "notes".into(),
        path: dir.path().to_string_lossy().into(),
        created_at: String::new(),
        dev: None,
    };
    (dir, project)
}

#[test]
fn the_generated_rollback_restores_the_previous_row_state() {
    let (dir, project) = project_fixture();
    let columns = get_table_columns(&project, "notes.sqlite", "notes").unwrap();
    let plan = plan_row_change(
        "notes",
        &columns,
        &["2".into()],
        &[change("label", "second", "renamed"), change("note", "NULL", "added")],
    )
    .unwrap();
    assert_eq!(plan.forward_sql, plan.rollback_sql);

    let db = Connection::open(dir.path().join("notes.sqlite")).unwrap();
    bind(&plan, &db).unwrap();
    let after: (String, Option<String>) = db
        .query_row("SELECT label, note FROM notes WHERE id = 2", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(after, ("renamed".into(), Some("added".into())));

    let mut statement = db.prepare(&plan.rollback_sql).unwrap();
    let bound: Vec<&dyn rusqlite::ToSql> = plan
        .rollback_parameters
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    assert_eq!(statement.execute(bound.as_slice()).unwrap(), 1);
    let restored: (String, Option<String>) = db
        .query_row("SELECT label, note FROM notes WHERE id = 2", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(restored, ("second".into(), None));
}

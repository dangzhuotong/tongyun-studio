use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use studio_core::diagnostics::{
    export_diagnostics_to_file, is_sensitive_key, sanitize_env_map, sanitize_project,
    sanitize_text,
};
use studio_core::{DevProfile, EnvPreset, Project, ServiceManager, Workspace};

#[test]
fn test_is_sensitive_key() {
    assert!(is_sensitive_key("API_KEY"));
    assert!(is_sensitive_key("db_password"));
    assert!(is_sensitive_key("secretToken"));
    assert!(is_sensitive_key("AUTH_HEADER"));
    assert!(is_sensitive_key("user_passwd"));
    assert!(is_sensitive_key("access_token"));
    assert!(is_sensitive_key("client_secret"));
    assert!(is_sensitive_key("jwt_cookie"));
    assert!(is_sensitive_key("db_pwd"));
    assert!(is_sensitive_key("bearer_auth"));

    assert!(!is_sensitive_key("PORT"));
    assert!(!is_sensitive_key("NODE_ENV"));
    assert!(!is_sensitive_key("APP_NAME"));
    assert!(!is_sensitive_key("HOST"));
    assert!(!is_sensitive_key("PATH"));
}

#[test]
fn test_sanitize_env_map() {
    let mut env = BTreeMap::new();
    env.insert("PORT".to_string(), "3000".to_string());
    env.insert("NODE_ENV".to_string(), "development".to_string());
    env.insert("DATABASE_URL".to_string(), "sqlite://dev.db".to_string());
    env.insert("DB_PASSWORD".to_string(), "super_secret_123".to_string());
    env.insert("API_KEY".to_string(), "key-998877".to_string());
    env.insert("AUTH_TOKEN".to_string(), "token-aabbcc".to_string());

    let sanitized = sanitize_env_map(&env);
    assert_eq!(sanitized.get("PORT").unwrap(), "3000");
    assert_eq!(sanitized.get("NODE_ENV").unwrap(), "development");
    assert_eq!(sanitized.get("DATABASE_URL").unwrap(), "sqlite://dev.db");
    assert_eq!(sanitized.get("DB_PASSWORD").unwrap(), "[REDACTED]");
    assert_eq!(sanitized.get("API_KEY").unwrap(), "[REDACTED]");
    assert_eq!(sanitized.get("AUTH_TOKEN").unwrap(), "[REDACTED]");
}

#[test]
fn test_sanitize_text() {
    let log_line = "Connecting to https://user:secretpassword123@api.example.com/v1 with Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDc2yDlsWTO7MZ_DhCc3ERLaAhHG6zh8no023VSnw and token=\"secret_token_val\"";
    let sanitized = sanitize_text(log_line);

    assert!(!sanitized.contains("secretpassword123"));
    assert!(sanitized.contains("https://user:[REDACTED]@api.example.com"));
    assert!(!sanitized.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
    assert!(sanitized.contains("Bearer [REDACTED]"));
    assert!(!sanitized.contains("secret_token_val"));
    assert!(sanitized.contains("token=[REDACTED]"));
}

#[test]
fn test_sanitize_text_covers_header_cli_and_connection_string_secrets() {
    let cases: &[(&str, &str)] = &[
        ("request header x-api-key: sk-abcdef123456 sent", "sk-abcdef123456"),
        ("curl -H x-api-key=sk-live-9f8e7d6c https://api.example.com", "sk-live-9f8e7d6c"),
        ("Authorization: Basic YWRtaW46czNjcjN0", "YWRtaW46czNjcjN0"),
        ("authorization=Basic cGFzc3dvcmQ6aHVudGVyMg==", "cGFzc3dvcmQ6aHVudGVyMg=="),
        ("postgres://app:hunter2@db.internal:5432/main", "hunter2"),
        (
            "postgresql://reader%2Bapi:Pa55-w0rd@10.0.0.5/orders",
            "Pa55-w0rd",
        ),
        ("mysql://root:s3cr3t@127.0.0.1:3306/app", "s3cr3t"),
        ("redis://:r3d1spass@cache.internal:6379/0", "r3d1spass"),
        (
            "mongodb+srv://svc:MongoPass9@cluster0.mongodb.net/test",
            "MongoPass9",
        ),
        ("npm run start --key=abcdef0123456 --port 8080", "abcdef0123456"),
        ("java -jar app.jar --api-key=topsecretvalue --pwd=flagpwd7", "topsecretvalue"),
        ("jdbc:mysql://127.0.0.1:3306/app?user=root&pwd=jdbcsecretx", "jdbcsecretx"),
        ("raw token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFwaSBVc2VyIn0.DpAIngZODxs7h0wvtC3M4BKmHJoK5bLyc2jE3O2p6c8 accepted", "DpAIngZODxs7h0wvtC3M4BKmHJoK5bLyc2jE3O2p6c8"),
    ];

    for (input, secret) in cases {
        let sanitized = sanitize_text(input);
        assert!(
            !sanitized.contains(secret),
            "secret leaked: {input}\n      result: {sanitized}"
        );
        assert!(
            sanitized.contains("[REDACTED]"),
            "nothing redacted: {input}\n      result: {sanitized}"
        );
    }

    // The bare JWT loses both header and payload, not only the signature.
    let jwt_case = "raw token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFwaSBVc2VyIn0.DpAIngZODxs7h0wvtC3M4BKmHJoK5bLyc2jE3O2p6c8 accepted";
    let sanitized = sanitize_text(jwt_case);
    assert!(
        !sanitized.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
        "{sanitized}"
    );
    assert!(!sanitized.contains("IkFwaSBVc2VyIn0"), "{sanitized}");
}

#[test]
fn test_sanitize_text_keeps_ordinary_urls_and_flags() {
    let benign = "GET https://api.example.com/v1/health?user=reader&limit=50 cd /tmp/pwd-demo npm run dev --host 0.0.0.0 --keyid 7";
    let sanitized = sanitize_text(benign);
    assert_eq!(sanitized, benign);
}

#[test]
fn test_sanitize_project_and_dev_profile() {
    let mut env = BTreeMap::new();
    env.insert("PORT".to_string(), "8080".to_string());
    env.insert("DB_PWD".to_string(), "pwd_env_1".to_string());
    env.insert("PRIVATE_KEY".to_string(), "0x12345678".to_string());

    let mut preset_env = BTreeMap::new();
    preset_env.insert("PASSWORD".to_string(), "admin123".to_string());
    preset_env.insert("HOST".to_string(), "127.0.0.1".to_string());

    let mut profiles = BTreeMap::new();
    profiles.insert(
        "prod".to_string(),
        EnvPreset {
            label: "生产预设".to_string(),
            command: Some("npm run start --token=abc".to_string()),
            port: Some(8080),
            health_url: Some("http://user:pass@127.0.0.1:8080/health".to_string()),
            env: preset_env,
            auto_restart: None,
            max_restarts: None,
            restart_interval_secs: None,
        },
    );

    let dev = DevProfile {
        command: "npm run dev --key=secretkey".to_string(),
        port: Some(8080),
        health_url: Some("http://localhost:8080/ready".to_string()),
        kind: "node".to_string(),
        label: "开发服务器".to_string(),
        env,
        profiles,
        ..Default::default()
    };

    let project = Project {
        id: "proj-1".to_string(),
        name: "test-project".to_string(),
        path: "/path/to/test-project".to_string(),
        created_at: "2026-10-30T22:00:00Z".to_string(),
        dev: Some(dev),
    };

    let sanitized = sanitize_project(&project);
    let s_dev = sanitized.dev.unwrap();
    assert_eq!(s_dev.port, Some(8080));
    assert_eq!(s_dev.env.get("PORT").unwrap(), "8080");
    assert_eq!(s_dev.env.get("PRIVATE_KEY").unwrap(), "[REDACTED]");
    assert_eq!(s_dev.env.get("DB_PWD").unwrap(), "[REDACTED]");
    assert_eq!(s_dev.command, "npm run dev --key=[REDACTED]");

    let s_preset = s_dev.profiles.get("prod").unwrap();
    assert_eq!(s_preset.port, Some(8080));
    assert_eq!(s_preset.env.get("HOST").unwrap(), "127.0.0.1");
    assert_eq!(s_preset.env.get("PASSWORD").unwrap(), "[REDACTED]");
    assert_eq!(
        s_preset.command.as_deref().unwrap(),
        "npm run start --token=[REDACTED]"
    );
    assert!(s_preset.health_url.as_ref().unwrap().contains("[REDACTED]"));
}

#[test]
fn test_export_diagnostics_creates_valid_zip_with_metadata_and_logs() {
    let temp_dir = tempfile::tempdir().unwrap();
    let log_dir = temp_dir.path().join("logs");
    std::fs::create_dir_all(&log_dir).unwrap();

    let service_mgr = ServiceManager::with_log_dir(log_dir.clone());

    // Write a mock log file for proj-1
    let proj1_log_file = log_dir.join("proj-1.log");
    std::fs::write(
        &proj1_log_file,
        "2026-10-30 22:00:00 Server listening on port 8080\nAuthorization: Bearer secret_token_xyz\nReady!\n",
    )
    .unwrap();

    let mut env = BTreeMap::new();
    env.insert("PORT".to_string(), "8080".to_string());
    env.insert("SECRET_KEY".to_string(), "my_super_key".to_string());

    let project = Project {
        id: "proj-1".to_string(),
        name: "My App".to_string(),
        path: "/Users/dev/myapp".to_string(),
        created_at: "2026-10-30T10:00:00Z".to_string(),
        dev: Some(DevProfile {
            command: "npm run dev".to_string(),
            port: Some(8080),
            health_url: Some("http://localhost:8080/".to_string()),
            kind: "node".to_string(),
            label: "Node App".to_string(),
            env,
            ..Default::default()
        }),
    };

    let workspace = Workspace {
        version: 1,
        projects: vec![project],
        active_project_id: Some("proj-1".to_string()),
    };

    let zip_path = temp_dir.path().join("diagnostics.zip");
    let report = export_diagnostics_to_file(&workspace, &service_mgr, &zip_path).unwrap();

    assert_eq!(report.project_count, 1);
    assert_eq!(report.log_count, 1);
    assert!(report.file_size > 0);
    assert!(zip_path.is_file());

    // Verify zip archive content
    let file = File::open(&zip_path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();

    // Check metadata.json
    let meta: serde_json::Value = {
        let mut meta_file = archive.by_name("metadata.json").unwrap();
        let mut meta_str = String::new();
        meta_file.read_to_string(&mut meta_str).unwrap();
        serde_json::from_str(&meta_str).unwrap()
    };
    assert_eq!(meta["studioVersion"], "0.1.0");
    assert_eq!(meta["projects"][0]["name"], "My App");
    assert_eq!(meta["projects"][0]["dev"]["port"], 8080);
    assert_eq!(meta["projects"][0]["dev"]["env"]["PORT"], "8080");
    assert_eq!(
        meta["projects"][0]["dev"]["env"]["SECRET_KEY"],
        "[REDACTED]"
    );

    // Check logs/proj-1.log
    let log_str = {
        let mut log_file = archive.by_name("logs/proj-1.log").unwrap();
        let mut log_str = String::new();
        log_file.read_to_string(&mut log_str).unwrap();
        log_str
    };
    assert!(log_str.contains("Server listening on port 8080"));
    assert!(log_str.contains("Bearer [REDACTED]"));
    assert!(!log_str.contains("secret_token_xyz"));

    // Check diagnostics.txt
    let diag_str = {
        let mut diag_file = archive.by_name("diagnostics.txt").unwrap();
        let mut diag_str = String::new();
        diag_file.read_to_string(&mut diag_str).unwrap();
        diag_str
    };
    assert!(diag_str.contains("橦云工作台 (Tongyun Studio) 诊断报告包"));
    assert!(diag_str.contains("项目数量: 1"));
    assert!(diag_str.contains("日志文件数: 1"));
}

#[test]
#[cfg(unix)]
fn test_export_diagnostics_permission_denied_gives_clear_error() {
    let temp_dir = tempfile::tempdir().unwrap();
    let service_mgr = ServiceManager::with_log_dir(temp_dir.path().join("logs"));
    let workspace = Workspace::default();

    // A read-only directory blocks file creation on Unix. Windows ignores the
    // attribute on directories, so that platform has its own equivalent case.
    let read_only_dir = temp_dir.path().join("readonly");
    std::fs::create_dir_all(&read_only_dir).unwrap();
    let mut perms = std::fs::metadata(&read_only_dir).unwrap().permissions();
    perms.set_readonly(true);
    let _ = std::fs::set_permissions(&read_only_dir, perms);

    let target_path = read_only_dir.join("test_diagnostics.zip");
    let result = export_diagnostics_to_file(&workspace, &service_mgr, &target_path);

    // Reset permissions for cleanup
    let mut cleanup_perms = std::fs::metadata(&read_only_dir).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    cleanup_perms.set_readonly(false);
    let _ = std::fs::set_permissions(&read_only_dir, cleanup_perms);

    assert!(result.is_err());
    let err = result.err().unwrap();
    assert!(
        err.contains("Permission denied") || err.contains("权限不足") || err.contains("无法创建"),
        "Unexpected error: {err}"
    );
    assert!(err.contains(target_path.to_str().unwrap()) || err.contains(read_only_dir.to_str().unwrap()));
}

#[test]
#[cfg(windows)]
fn test_export_diagnostics_permission_denied_gives_clear_error() {
    let temp_dir = tempfile::tempdir().unwrap();
    let service_mgr = ServiceManager::with_log_dir(temp_dir.path().join("logs"));
    let workspace = Workspace::default();

    // The writable-directory path must exist so the failure comes from the file
    // itself: Windows rejects opening an existing read-only file for writing.
    let out_dir = temp_dir.path().join("out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let target_path = out_dir.join("test_diagnostics.zip");
    std::fs::write(&target_path, b"placeholder").unwrap();
    let mut perms = std::fs::metadata(&target_path).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&target_path, perms).unwrap();

    let result = export_diagnostics_to_file(&workspace, &service_mgr, &target_path);

    // Reset permissions for cleanup
    let mut cleanup_perms = std::fs::metadata(&target_path).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    cleanup_perms.set_readonly(false);
    let _ = std::fs::set_permissions(&target_path, cleanup_perms);

    assert!(
        result.is_err(),
        "expected permission error, got: {result:?}"
    );
    let err = result.err().unwrap();
    assert!(
        err.contains("Permission denied") || err.contains("权限不足") || err.contains("无法创建"),
        "Unexpected error: {err}"
    );
    assert!(
        err.contains(target_path.to_str().unwrap()),
        "error omits path: {err}"
    );
}

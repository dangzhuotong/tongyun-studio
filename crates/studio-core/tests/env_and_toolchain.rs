use std::collections::BTreeMap;
use std::fs;
use studio_core::{
    dev_runtime::{spring_profile_from_filename, suggest_spring_profiles, DevProfile, EnvPreset},
    toolchain::{toolchain_env, HostOs, ToolchainRoots},
    Project, ServiceManager,
};

#[test]
fn test_spring_profile_filename_detection() {
    assert_eq!(
        spring_profile_from_filename("application-dev.yml").as_deref(),
        Some("dev")
    );
    assert_eq!(
        spring_profile_from_filename("application-test.yaml").as_deref(),
        Some("test")
    );
    assert_eq!(
        spring_profile_from_filename("application-prod.properties").as_deref(),
        Some("prod")
    );
    assert_eq!(
        spring_profile_from_filename("application-local_1.yml").as_deref(),
        Some("local_1")
    );

    // Negative cases
    assert_eq!(spring_profile_from_filename("application.yml"), None);
    assert_eq!(spring_profile_from_filename("application.properties"), None);
    assert_eq!(spring_profile_from_filename("application-.yml"), None);
    assert_eq!(spring_profile_from_filename("other-dev.yml"), None);
}

#[test]
fn test_spring_profile_scanning_from_resources() {
    let tmp = tempfile::tempdir().unwrap();
    let res = tmp.path().join("src/main/resources");
    fs::create_dir_all(&res).unwrap();

    fs::write(
        res.join("application-dev.yml"),
        "server:\n  port: 8081\nlogging:\n  level:\n    root: INFO\n",
    )
    .unwrap();
    fs::write(
        res.join("application-test.properties"),
        "server.port=9091\nspring.application.name=test-app\n",
    )
    .unwrap();
    fs::write(res.join("application.yml"), "server:\n  port: 8080\n").unwrap();

    let profiles = suggest_spring_profiles(tmp.path());
    assert_eq!(profiles.len(), 2);

    let dev = profiles.get("dev").expect("dev profile found");
    assert_eq!(dev.label, "dev");
    assert_eq!(dev.port, Some(8081));
    assert_eq!(
        dev.env.get("SPRING_PROFILES_ACTIVE").map(String::as_str),
        Some("dev")
    );

    let test = profiles.get("test").expect("test profile found");
    assert_eq!(test.label, "test");
    assert_eq!(test.port, Some(9091));
    assert_eq!(
        test.env.get("SPRING_PROFILES_ACTIVE").map(String::as_str),
        Some("test")
    );
}

#[test]
fn test_toolchain_preflight_missing_java_reports_readable_error() {
    let services = ServiceManager::new();
    let project = Project {
        id: "proj-missing-java".into(),
        name: "Missing Java Proj".into(),
        path: "C:/fake/path".into(),
        created_at: "2026-10-29T00:00:00Z".into(),
        dev: Some(DevProfile {
            command: "echo run".into(),
            java: Some("9999".into()), // non-existent Java version
            ..Default::default()
        }),
    };

    let err = services
        .start(&project, "echo run")
        .expect_err("start must fail upfront when java version is missing");
    assert!(
        err.contains("缺 Java 9999"),
        "Expected clear toolchain error, got: {err}"
    );
}

#[test]
fn test_toolchain_preflight_invalid_java_home_reports_readable_error() {
    let services = ServiceManager::new();
    let project = Project {
        id: "proj-invalid-java-home".into(),
        name: "Invalid Java Home Proj".into(),
        path: "C:/fake/path".into(),
        created_at: "2026-10-29T00:00:00Z".into(),
        dev: Some(DevProfile {
            command: "echo run".into(),
            java_home: Some("/non/existent/path/to/jdk".into()),
            ..Default::default()
        }),
    };

    let err = services
        .start(&project, "echo run")
        .expect_err("start must fail upfront when java_home is invalid");
    assert!(
        err.contains("指定的 java_home 无效"),
        "Expected invalid java_home error, got: {err}"
    );
    assert!(
        err.contains("bin/java 未找到"),
        "Expected bin/java reason, got: {err}"
    );
}

#[test]
fn test_toolchain_preflight_missing_node_reports_readable_error() {
    let services = ServiceManager::new();
    let project = Project {
        id: "proj-missing-node".into(),
        name: "Missing Node Proj".into(),
        path: "C:/fake/path".into(),
        created_at: "2026-10-29T00:00:00Z".into(),
        dev: Some(DevProfile {
            command: "echo run".into(),
            node: Some("9999".into()), // non-existent Node version
            ..Default::default()
        }),
    };

    let err = services
        .start(&project, "echo run")
        .expect_err("start must fail upfront when node version is missing");
    assert!(
        err.contains("缺 Node 9999"),
        "Expected clear toolchain error, got: {err}"
    );
}

#[test]
fn test_toolchain_preflight_invalid_node_home_reports_readable_error() {
    let services = ServiceManager::new();
    let project = Project {
        id: "proj-invalid-node-home".into(),
        name: "Invalid Node Home Proj".into(),
        path: "C:/fake/path".into(),
        created_at: "2026-10-29T00:00:00Z".into(),
        dev: Some(DevProfile {
            command: "echo run".into(),
            node_home: Some("/non/existent/path/to/node".into()),
            ..Default::default()
        }),
    };

    let err = services
        .start(&project, "echo run")
        .expect_err("start must fail upfront when node_home is invalid");
    assert!(
        err.contains("指定的 node_home 无效"),
        "Expected invalid node_home error, got: {err}"
    );
}

#[test]
fn test_toolchain_env_injection_with_mock_roots() {
    let tmp = tempfile::tempdir().unwrap();
    let fake_jdk = tmp.path().join("fake_jdk");
    let fake_jdk_bin = fake_jdk.join("bin");
    fs::create_dir_all(&fake_jdk_bin).unwrap();
    fs::write(fake_jdk_bin.join("java"), "").unwrap();

    let fake_node = tmp.path().join("fake_node");
    let fake_node_bin = fake_node.join("bin");
    fs::create_dir_all(&fake_node_bin).unwrap();
    fs::write(fake_node_bin.join("node"), "").unwrap();

    let roots = ToolchainRoots {
        os: HostOs::Linux,
        home: Some(tmp.path().to_path_buf()),
        sdkman_dir: None,
        fnm_dir: None,
        nvm_dir: None,
        program_files: Vec::new(),
        appdata: None,
        nvm_home: None,
        base_path: "/usr/bin:/bin".into(),
        common_dirs: Some(Vec::new()),
        mac_jvm_dir: None,
        catalina_home: None,
    };

    let env = toolchain_env(None, Some(&fake_jdk), None, Some(&fake_node), &roots)
        .expect("toolchain_env should resolve with valid paths");

    let java_home = env
        .iter()
        .find(|(k, _)| k == "JAVA_HOME")
        .map(|(_, v)| v.as_str());
    assert_eq!(java_home, Some(fake_jdk.to_str().unwrap()));

    let path_var = env
        .iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.as_str())
        .unwrap();
    assert!(path_var.contains(fake_jdk_bin.to_str().unwrap()));
    assert!(path_var.contains(fake_node_bin.to_str().unwrap()));
}

#[test]
fn test_env_presets_profile_selection_and_merging() {
    let mut profiles = BTreeMap::new();
    let mut dev_env = BTreeMap::new();
    dev_env.insert("SPRING_PROFILES_ACTIVE".into(), "dev".into());
    dev_env.insert("DB_URL".into(), "jdbc:mysql://localhost/dev".into());

    profiles.insert(
        "dev".into(),
        EnvPreset {
            label: "dev".into(),
            command: Some("mvn spring-boot:run -Dprofiles=dev".into()),
            port: Some(8081),
            health_url: None,
            env: dev_env,
            ..Default::default()
        },
    );

    let mut test_env = BTreeMap::new();
    test_env.insert("SPRING_PROFILES_ACTIVE".into(), "test".into());
    test_env.insert("DB_URL".into(), "jdbc:mysql://localhost/test".into());

    profiles.insert(
        "test".into(),
        EnvPreset {
            label: "test".into(),
            command: Some("mvn spring-boot:run -Dprofiles=test".into()),
            port: Some(9091),
            health_url: None,
            env: test_env,
            ..Default::default()
        },
    );

    let project = Project {
        id: "proj-profiles".into(),
        name: "Profiles Project".into(),
        path: "C:/fake/path".into(),
        created_at: "2026-10-29T00:00:00Z".into(),
        dev: Some(DevProfile {
            command: "mvn spring-boot:run".into(),
            port: Some(8080),
            default_profile: Some("dev".into()),
            profiles,
            ..Default::default()
        }),
    };

    let dev = project.dev.as_ref().unwrap();
    assert_eq!(dev.default_profile.as_deref(), Some("dev"));
    assert_eq!(dev.profiles.len(), 2);
    assert_eq!(dev.profiles["dev"].port, Some(8081));
    assert_eq!(dev.profiles["test"].port, Some(9091));
}

#[test]
fn test_toolchain_preflight_missing_tomcat_reports_readable_error() {
    let temp = tempfile::tempdir().unwrap();
    let services = ServiceManager::new();
    let project = Project {
        id: "legacy-war-proj".into(),
        name: "Legacy WAR Project".into(),
        path: temp.path().to_string_lossy().into(),
        created_at: "2026-10-29T00:00:00Z".into(),
        dev: Some(DevProfile {
            command: "catalina run".into(),
            kind: "tomcat-war".into(),
            ..Default::default()
        }),
    };

    let err = services
        .start(&project, "catalina run")
        .expect_err("start must fail upfront when Tomcat is missing");
    assert!(
        err.contains("缺 Tomcat：未配置 CATALINA_HOME，请指定 Tomcat 安装目录。"),
        "Expected missing Tomcat error, got: {err}"
    );
}

#[test]
fn test_toolchain_preflight_invalid_catalina_home_reports_readable_error() {
    let temp = tempfile::tempdir().unwrap();
    let services = ServiceManager::new();
    let project = Project {
        id: "legacy-war-proj".into(),
        name: "Legacy WAR Project".into(),
        path: temp.path().to_string_lossy().into(),
        created_at: "2026-10-29T00:00:00Z".into(),
        dev: Some(DevProfile {
            command: "catalina run".into(),
            kind: "tomcat-war".into(),
            catalina_home: Some("/non/existent/path/to/tomcat".into()),
            ..Default::default()
        }),
    };

    let err = services
        .start(&project, "catalina run")
        .expect_err("start must fail upfront when catalina_home is invalid");
    assert!(
        err.contains("指定的 CATALINA_HOME 无效"),
        "Expected invalid catalina_home error, got: {err}"
    );
}

#[test]
fn test_toolchain_preflight_valid_catalina_home_passes_and_replaces_templates() {
    let temp = tempfile::tempdir().unwrap();
    let tomcat = temp.path().join("mock-tomcat");
    std::fs::create_dir_all(tomcat.join("bin")).unwrap();
    std::fs::write(tomcat.join("bin/catalina.sh"), "#!/bin/sh\nexit 0\n").unwrap();

    let roots = ToolchainRoots {
        os: HostOs::Linux,
        home: None,
        sdkman_dir: None,
        fnm_dir: None,
        nvm_dir: None,
        program_files: Vec::new(),
        appdata: None,
        nvm_home: None,
        base_path: "/usr/bin".into(),
        common_dirs: None,
        mac_jvm_dir: None,
        catalina_home: None,
    };

    let resolved = studio_core::resolve_catalina_home(Some(&tomcat), &roots).unwrap();
    assert_eq!(resolved, tomcat);
}

//! Generic multi-engine database connection manager (SQLite / MySQL / PostgreSQL / Redis).
//!
//! Saved connections live in the app config directory (`connections.json`) beside
//! `workspace.json`; passwords are sealed with AES-256-GCM under a local key file and are
//! never returned to the UI, written to logs, or embedded in error text.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use crate::{DbColumnInfo, DbTableInfo, Result, SqlQueryResult};

pub const MAX_CONNECTIONS: usize = 100;
const CONN_TIMEOUT: Duration = Duration::from_secs(5);
const GCM_PREFIX: &str = "gcm1:";
const ALLOWED_SQL_HEADS: &[&str] = &[
    "select", "show", "describe", "desc", "explain", "with", "pragma",
];
/// 这些头只是元数据查询，参数里合法包含 DDL 词（`SHOW CREATE TABLE`），不做关键字扫描。
const METADATA_ONLY_HEADS: &[&str] = &["show", "describe", "desc"];
const DENIED_SQL_CLAUSES: &[&str] = &[
    " into outfile",
    " into dumpfile",
    " for update",
    " lock in share mode",
    " for share",
    " for no key update",
    " for key share",
];
/// 写在任意层级都成立的语句级关键字：CTE 里嵌 `DELETE ... RETURNING`、`SELECT ... INTO tbl`
/// 和 `EXPLAIN ANALYZE <DML>` 都会真的改数据，只比对头部与固定子句拦不住。
/// 紧跟 `(` 的同名词是函数调用（`REPLACE(a,'x','y')`），不当作语句关键字。
const DENIED_SQL_KEYWORDS: &[&str] = &[
    "insert", "update", "delete", "merge", "replace", "truncate", "alter", "drop", "create",
    "grant", "revoke", "call", "execute", "prepare", "deallocate", "handler", "lock",
    "returning", "copy", "refresh", "vacuum", "analyze", "into",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbEngine {
    Sqlite,
    Mysql,
    Postgres,
    Redis,
}

impl DbEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::Mysql => "mysql",
            Self::Postgres => "postgres",
            Self::Redis => "redis",
        }
    }

    pub fn default_port(self) -> u16 {
        match self {
            Self::Sqlite => 0,
            Self::Mysql => 3306,
            Self::Postgres => 5432,
            Self::Redis => 6379,
        }
    }

    /// Engines whose bundled driver completes a real TLS handshake today.
    pub fn tls_supported(self) -> bool {
        matches!(self, Self::Mysql)
    }

    fn label(self) -> &'static str {
        match self {
            Self::Sqlite => "SQLite",
            Self::Mysql => "MySQL",
            Self::Postgres => "PostgreSQL",
            Self::Redis => "Redis",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub engine: DbEngine,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    /// Sealed password envelope; `None` means "no password saved".
    #[serde(default)]
    pub password_enc: Option<String>,
    /// Absolute SQLite file path, database name, or Redis index.
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub tls: bool,
    #[serde(default = "default_true")]
    pub read_only: bool,
    #[serde(default)]
    pub revision: u32,
    #[serde(default)]
    pub updated_at: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub id: String,
    pub name: String,
    pub engine: DbEngine,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub tls: bool,
    pub read_only: bool,
    pub revision: u32,
    pub updated_at: String,
    pub has_password: bool,
}

impl From<&SavedConnection> for ConnectionSummary {
    fn from(record: &SavedConnection) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            engine: record.engine,
            host: record.host.clone(),
            port: record.port,
            user: record.user.clone(),
            database: record.database.clone(),
            tls: record.tls,
            read_only: record.read_only,
            revision: record.revision,
            updated_at: record.updated_at.clone(),
            has_password: record.password_enc.is_some(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectionInput {
    pub id: String,
    pub name: String,
    pub engine: Option<DbEngine>,
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    /// `None` keeps the sealed password, `Some("")` clears it.
    pub password: Option<String>,
    pub database: String,
    pub tls: bool,
    pub read_only: bool,
    pub revision: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProbeResult {
    pub ok: bool,
    pub engine: DbEngine,
    pub latency_ms: u64,
    pub detail: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionsFile {
    version: u32,
    #[serde(default)]
    connections: Vec<SavedConnection>,
}

impl ConnectionsFile {
    fn empty() -> Self {
        Self {
            version: 1,
            connections: vec![],
        }
    }
}

pub struct ConnectionStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl ConnectionStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn key_path(&self) -> PathBuf {
        self.path.with_file_name("connections.key")
    }

    fn read(&self) -> Result<ConnectionsFile> {
        let file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ConnectionsFile::empty()),
            Err(e) => return Err(format!("无法读取连接记录：{e}")),
        };
        let value: serde_json::Value =
            serde_json::from_reader(file).map_err(|e| format!("连接记录损坏，已保留原文件：{e}"))?;
        if value.get("version").and_then(|v| v.as_u64()) != Some(1) {
            return Err("连接记录版本不受支持，已保留原文件".into());
        }
        serde_json::from_value(value).map_err(|e| format!("连接记录格式错误，已保留原文件：{e}"))
    }

    fn write(&self, store: &ConnectionsFile) -> Result<()> {
        let parent = self.path.parent().ok_or("连接记录路径无效")?;
        fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录：{e}"))?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(file.as_file_mut(), store).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        restrict_owner_only(file.path());
        file.persist(&self.path)
            .map_err(|e| format!("保存连接记录失败：{e}"))?;
        restrict_owner_only(&self.path);
        Ok(())
    }

    fn key(&self) -> Result<[u8; 32]> {
        let path = self.key_path();
        match fs::read(&path) {
            Ok(bytes) if bytes.len() == 32 => {
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                Ok(key)
            }
            Ok(_) => Err("KEY_CORRUPT：连接密钥文件损坏，请人工处理".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut key = [0u8; 32];
                fill_random(&mut key);
                write_key_file(&path, &key)?;
                Ok(key)
            }
            Err(e) => Err(format!("无法读取连接密钥文件：{e}")),
        }
    }

    pub fn list(&self) -> Result<Vec<ConnectionSummary>> {
        let _guard = self.lock.lock().map_err(|_| "连接记录锁不可用")?;
        Ok(self
            .read()?
            .connections
            .iter()
            .map(ConnectionSummary::from)
            .collect())
    }

    pub fn save(&self, input: &ConnectionInput) -> Result<ConnectionSummary> {
        let _guard = self.lock.lock().map_err(|_| "连接记录锁不可用")?;
        let engine = input.engine.ok_or("VALIDATION：请选择数据库引擎")?;
        validate(engine, input)?;
        let mut store = self.read()?;
        let existing = store.connections.iter().find(|c| c.id == input.id).cloned();
        if existing.is_none() && store.connections.len() >= MAX_CONNECTIONS {
            return Err(format!("VALIDATION：连接数量已达上限 {MAX_CONNECTIONS}，请先删除不用的连接"));
        }
        let name = input.name.trim().to_string();
        if store
            .connections
            .iter()
            .any(|c| c.id != input.id && c.name.eq_ignore_ascii_case(&name))
        {
            return Err("VALIDATION：已存在同名连接，请换一个名称".into());
        }
        if let Some(existing) = &existing {
            if let Some(expected) = input.revision {
                if expected != existing.revision {
                    return Err("REVISION_CONFLICT：该连接已被修改，请刷新后重试".into());
                }
            }
        }
        let password_enc = match &input.password {
            Some(plain) if !plain.is_empty() => Some(encrypt(&self.key()?, plain)?),
            Some(_) => None,
            None => existing.as_ref().and_then(|c| c.password_enc.clone()),
        };
        let record = SavedConnection {
            id: if input.id.is_empty() { new_id() } else { input.id.clone() },
            name,
            engine,
            host: match engine {
                DbEngine::Sqlite => String::new(),
                _ => input.host.trim().to_string(),
            },
            port: match engine {
                DbEngine::Sqlite => 0,
                _ => input.port.unwrap_or_else(|| engine.default_port()),
            },
            user: match engine {
                DbEngine::Sqlite | DbEngine::Redis => String::new(),
                _ => input.user.trim().to_string(),
            },
            password_enc,
            database: input.database.trim().to_string(),
            tls: input.tls,
            read_only: input.read_only,
            revision: existing.as_ref().map(|c| c.revision).unwrap_or(0) + 1,
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        let summary = ConnectionSummary::from(&record);
        if let Some(slot) = store.connections.iter_mut().find(|c| c.id == record.id) {
            *slot = record;
        } else {
            store.connections.push(record);
        }
        self.write(&store)?;
        Ok(summary)
    }

    pub fn remove(&self, id: &str) -> Result<Vec<ConnectionSummary>> {
        let _guard = self.lock.lock().map_err(|_| "连接记录锁不可用")?;
        let mut store = self.read()?;
        let before = store.connections.len();
        store.connections.retain(|c| c.id != id);
        if store.connections.len() == before {
            return Err("未找到要删除的连接".into());
        }
        self.write(&store)?;
        Ok(store
            .connections
            .iter()
            .map(ConnectionSummary::from)
            .collect())
    }

    pub fn get(&self, id: &str) -> Result<SavedConnection> {
        let _guard = self.lock.lock().map_err(|_| "连接记录锁不可用")?;
        self.read()?
            .connections
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("连接不存在：{id}"))
    }

    /// Opens the sealed password. Callers must scrub it from any error text.
    pub fn password_of(&self, record: &SavedConnection) -> Result<String> {
        match &record.password_enc {
            None => Ok(String::new()),
            Some(envelope) => {
                let key = self.key()?;
                decrypt(&key, envelope)
            }
        }
    }
}

#[cfg(unix)]
fn restrict_owner_only(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

/// Windows has no POSIX mode bits; the config dir lives under the user profile.
#[cfg(windows)]
fn restrict_owner_only(_path: &Path) {}

#[cfg(not(any(unix, windows)))]
fn restrict_owner_only(_path: &Path) {}

fn write_key_file(path: &Path, key: &[u8; 32]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录：{e}"))?;
    }
    let mut file = fs::File::create(path).map_err(|e| format!("无法创建连接密钥文件：{e}"))?;
    file.write_all(key).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    restrict_owner_only(path);
    Ok(())
}

fn fill_random(bytes: &mut [u8]) {
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let block = uuid::Uuid::new_v4().as_u128().to_le_bytes();
        let take = (bytes.len() - cursor).min(block.len());
        bytes[cursor..cursor + take].copy_from_slice(&block[..take]);
        cursor += take;
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn encrypt(key: &[u8; 32], plain: &str) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    fill_random(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_bytes())
        .map_err(|_| "密码加密失败".to_string())?;
    Ok(format!(
        "{GCM_PREFIX}{}.{}",
        B64.encode(nonce_bytes),
        B64.encode(ciphertext)
    ))
}

fn decrypt(key: &[u8; 32], envelope: &str) -> Result<String> {
    let body = envelope.strip_prefix(GCM_PREFIX).ok_or("密码记录格式不受支持")?;
    let (nonce_b64, ct_b64) = body.split_once('.').ok_or("密码记录格式不受支持")?;
    let nonce = B64.decode(nonce_b64).map_err(|_| "密码记录损坏".to_string())?;
    let ciphertext = B64.decode(ct_b64).map_err(|_| "密码记录损坏".to_string())?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "DECRYPT_FAILED：连接密钥与密码记录不匹配，请重新录入密码".to_string())?;
    String::from_utf8(plain).map_err(|_| "密码记录损坏".into())
}

pub(crate) fn scrub_password(haystack: &str, password: &str) -> String {
    if password.is_empty() {
        haystack.to_string()
    } else {
        haystack.replace(password, "******")
    }
}

fn validate(engine: DbEngine, input: &ConnectionInput) -> Result<()> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("VALIDATION：连接名称需为 1-64 个字符".into());
    }
    match engine {
        DbEngine::Sqlite => {
            let path = Path::new(input.database.trim());
            if !path.is_absolute() {
                return Err("VALIDATION：SQLite 需要数据库文件的绝对路径".into());
            }
            if !path.is_file() {
                return Err(format!("VALIDATION：SQLite 文件不存在：{}", input.database.trim()));
            }
        }
        other => {
            if input.host.trim().is_empty() {
                return Err("VALIDATION：请填写主机地址".into());
            }
            let host = input.host.trim();
            if host.contains(char::is_whitespace) || host.contains('/') || host.contains(':') {
                return Err("VALIDATION：主机地址格式不正确".into());
            }
            if let Some(port) = input.port {
                if port == 0 {
                    return Err("VALIDATION：端口需在 1-65535 之间".into());
                }
            }
            if other != DbEngine::Redis && input.user.trim().is_empty() {
                return Err("VALIDATION：请填写数据库用户名".into());
            }
            if other == DbEngine::Postgres && input.database.trim().is_empty() {
                return Err("VALIDATION：PostgreSQL 必须指定数据库名".into());
            }
            if other == DbEngine::Redis
                && !input.database.trim().is_empty()
                && input.database.trim().parse::<i64>().is_err()
            {
                return Err("VALIDATION：Redis 数据库索引需为数字，例如 0".into());
            }
            if input.tls && !other.tls_supported() {
                return Err(format!(
                    "TLS_UNSUPPORTED：当前仅 MySQL 支持 SSL 连接，{} 请先关闭 SSL",
                    other.label()
                ));
            }
        }
    }
    Ok(())
}

/// Single-statement, read-only classifier for engines that cannot enforce it in-engine.
/// SQLite keeps using the engine-level authorizer in `crate::query_sqlite_readonly`.
pub fn classify_readonly_sql(sql: &str) -> std::result::Result<(), String> {
    if sql.len() > 64 * 1024 {
        return Err("SQL 超过 64 KiB，请缩小查询".into());
    }
    // MySQL 把 `\` 当字符串转义符，PostgreSQL 的标准字符串不认（只有 E'' 认）。同一条文本
    // 在两种解释下可能一个是串、一个是代码，所以两种都要过闸，任一种判出写操作就拦。
    for backslash_escapes in [true, false] {
        let normalized = strip_sql_noise(sql, backslash_escapes).to_lowercase();
        let statements: Vec<&str> = normalized
            .split(';')
            .map(str::trim)
            .filter(|statement| !statement.is_empty())
            .collect();
        if statements.len() != 1 {
            return Err("GUARD_SINGLE_STATEMENT：每次仅允许一条只读 SQL 查询".into());
        }
        check_readonly_statement(statements[0])?;
    }
    Ok(())
}

fn check_readonly_statement(statement: &str) -> std::result::Result<(), String> {
    let head = statement.split_whitespace().next().unwrap_or_default();
    if !ALLOWED_SQL_HEADS.contains(&head) {
        return Err("GUARD_READONLY：该连接开启了只读保护，仅允许 SELECT / SHOW / EXPLAIN 等查询".into());
    }
    let padded = format!(" {statement} ");
    for clause in DENIED_SQL_CLAUSES {
        if padded.contains(clause) {
            return Err("GUARD_READONLY：查询包含加锁或导出子句，只读连接已拦截".into());
        }
    }
    if METADATA_ONLY_HEADS.contains(&head) {
        return Ok(());
    }
    for token in sql_word_tokens(statement) {
        if DENIED_SQL_KEYWORDS.contains(&token) {
            return Err("GUARD_READONLY：查询内层包含写数据或加锁关键字，只读连接已拦截".into());
        }
    }
    Ok(())
}

/// 拆出语句里的裸词（字母、数字、下划线连成的片段），跳过紧跟 `(` 的函数调用名。
fn sql_word_tokens(statement: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start: Option<usize> = None;
    for (index, c) in statement.char_indices() {
        if c.is_alphanumeric() || c == '_' {
            if start.is_none() {
                start = Some(index);
            }
            continue;
        }
        if let Some(begin) = start.take() {
            if c != '(' {
                tokens.push(&statement[begin..index]);
            }
        }
    }
    if let Some(begin) = start {
        tokens.push(&statement[begin..]);
    }
    tokens
}

/// 去掉字符串、反引号与注释。引号或块注释没有闭合时按最保守口径处理：把原文暴露出来，
/// 让调用方看得见被「半个字符串」藏起来的子句。
fn strip_sql_noise(sql: &str, backslash_escapes: bool) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.char_indices().peekable();
    while let Some((index, c)) = chars.next() {
        match c {
            '\'' | '"' | '`' => {
                let quote = c;
                let mut closed = false;
                while let Some((_, inner)) = chars.next() {
                    if backslash_escapes && inner == '\\' {
                        chars.next();
                        continue;
                    }
                    if inner == quote {
                        if chars.peek().map(|next| next.1) == Some(quote) {
                            chars.next();
                            continue;
                        }
                        closed = true;
                        break;
                    }
                }
                if closed {
                    out.push(' ');
                } else {
                    out.push_str(&sql[index..]);
                    return out;
                }
            }
            '-' if chars.peek().map(|next| next.1) == Some('-') => {
                for (_, inner) in chars.by_ref() {
                    if inner == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek().map(|next| next.1) == Some('*') => {
                chars.next();
                let mut closed = false;
                while let Some((_, inner)) = chars.next() {
                    if inner == '*' && chars.peek().map(|next| next.1) == Some('/') {
                        chars.next();
                        closed = true;
                        break;
                    }
                }
                if closed {
                    out.push(' ');
                } else {
                    out.push_str(&sql[index..]);
                    return out;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

const REDIS_READ_COMMANDS: &[&str] = &[
    "get", "mget", "exists", "type", "ttl", "pttl", "expiretime", "keys", "scan", "dbsize", "info",
    "hget", "hmget", "hgetall", "hkeys", "hlen", "hexists", "hscan", "hstrlen", "lindex", "llen",
    "lrange", "scard", "sismember", "smembers", "sscan", "strlen", "zcard", "zcount", "zrange",
    "zrangebyscore", "zrevrange", "zscore", "zmscore", "getrange", "bitcount", "memory", "config get",
];

pub fn classify_readonly_redis(command: &str) -> std::result::Result<Vec<String>, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("请输入一条 Redis 只读命令".into());
    }
    if trimmed.lines().count() > 1 || trimmed.contains('\r') || trimmed.contains('\n') {
        return Err("GUARD_SINGLE_STATEMENT：每次仅允许一条 Redis 命令".into());
    }
    let mut parts = trimmed.split_whitespace();
    let head = parts.next().unwrap_or_default().to_lowercase();
    let second = parts.next().map(|value| value.to_lowercase());
    let two_word = second.as_ref().map(|value| format!("{head} {value}"));
    let allowed = REDIS_READ_COMMANDS
        .iter()
        .any(|cmd| *cmd == head.as_str() || two_word.as_deref() == Some(*cmd));
    if !allowed {
        return Err("GUARD_READONLY：Redis 连接仅允许读命令（GET / HGETALL / SCAN 等）".into());
    }
    let mut tokens = vec![head];
    if let Some(value) = second {
        tokens.push(value);
    }
    for value in parts {
        tokens.push(value.to_string());
    }
    Ok(tokens)
}

pub fn test_connection(store: &ConnectionStore, id: &str) -> Result<ConnectionProbeResult> {
    let record = store.get(id)?;
    let password = store.password_of(&record)?;
    let started = Instant::now();
    let outcome = match record.engine {
        DbEngine::Sqlite => probe_sqlite(&record),
        DbEngine::Mysql => probe_mysql(&record, &password),
        DbEngine::Postgres => probe_postgres(&record, &password),
        DbEngine::Redis => probe_redis(&record, &password),
    };
    let latency_ms = started.elapsed().as_millis() as u64;
    Ok(match outcome {
        Ok(detail) => ConnectionProbeResult {
            ok: true,
            engine: record.engine,
            latency_ms,
            detail,
            error_code: None,
        },
        Err((error_code, detail)) => ConnectionProbeResult {
            ok: false,
            engine: record.engine,
            latency_ms,
            detail: scrub_password(&detail, &password),
            error_code: Some(error_code),
        },
    })
}

fn probe_sqlite(record: &SavedConnection) -> std::result::Result<String, (String, String)> {
    let (columns, rows) = crate::query_sqlite_readonly(Path::new(&record.database), "SELECT sqlite_version();")
        .map_err(|e| ("OPEN_FAILED".into(), e))?;
    let _ = columns;
    let version = rows
        .first()
        .and_then(|row| row.first())
        .cloned()
        .unwrap_or_else(|| "未知".into());
    Ok(format!("SQLite 可只读打开，版本 {version}"))
}

fn tcp_preflight(host: &str, port: u16) -> std::result::Result<(), (String, String)> {
    let addr = format!("{host}:{port}");
    let target: SocketAddr = addr
        .parse()
        .or_else(|_| {
            ToSocketAddrs::to_socket_addrs(addr.as_str())
                .map_err(|e| e.to_string())?
                .next()
                .ok_or_else(|| "未解析到主机地址".to_string())
        })
        .map_err(|e| ("HOST_UNRESOLVED".into(), format!("无法解析主机 {addr}：{e}")))?;
    TcpStream::connect_timeout(&target, CONN_TIMEOUT).map_err(|e| {
        let text = e.to_string();
        (
            "PORT_UNREACHABLE".into(),
            format!("无法连通 {addr}：{text}，请检查主机、端口与防火墙"),
        )
    })?;
    Ok(())
}

fn mysql_opts(record: &SavedConnection, password: &str) -> mysql::OptsBuilder {
    let ssl = if record.tls {
        Some(mysql::SslOpts::default().with_danger_accept_invalid_certs(true))
    } else {
        None
    };
    let mut builder = mysql::OptsBuilder::new()
        .ip_or_hostname(Some(record.host.clone()))
        .tcp_port(record.port)
        .user(Some(record.user.clone()))
        .pass(Some(password.to_string()))
        .read_timeout(Some(CONN_TIMEOUT))
        .write_timeout(Some(CONN_TIMEOUT))
        .ssl_opts(ssl);
    if !record.database.is_empty() {
        builder = builder.db_name(Some(record.database.clone()));
    }
    builder
}

fn map_mysql_error(error: &mysql::Error) -> (String, String) {
    let text = error.to_string();
    if text.contains("Access denied") || text.contains("1045") {
        return (
            "AUTH_FAILED".into(),
            format!("MySQL 鉴权失败（用户名或密码错误）：{text}"),
        );
    }
    if text.contains("database") && text.contains("Unknown") {
        return ("DB_NOT_FOUND".into(), format!("MySQL 数据库不存在：{text}"));
    }
    ("CONNECT_FAILED".into(), format!("MySQL 连接失败：{text}"))
}

fn probe_mysql(record: &SavedConnection, password: &str) -> std::result::Result<String, (String, String)> {
    tcp_preflight(&record.host, record.port)?;
    use mysql::prelude::Queryable;
    let mut conn = mysql::Conn::new(mysql_opts(record, password)).map_err(|e| map_mysql_error(&e))?;
    let version: Option<String> = conn
        .query_first("SELECT VERSION()")
        .map_err(|e| map_mysql_error(&e))?;
    Ok(format!(
        "MySQL 握手与鉴权成功，版本 {}",
        version.unwrap_or_else(|| "未知".into())
    ))
}

fn pg_config(record: &SavedConnection, password: &str) -> tokio_postgres::Config {
    let mut config = tokio_postgres::Config::new();
    config
        .host(&record.host)
        .port(record.port)
        .user(&record.user)
        .dbname(if record.database.is_empty() {
            &record.user
        } else {
            &record.database
        })
        .connect_timeout(CONN_TIMEOUT);
    if !password.is_empty() {
        config.password(password.as_bytes());
    }
    config
}

fn map_pg_error(error: tokio_postgres::Error, password: &str) -> (String, String) {
    let text = scrub_password(&error.to_string(), password);
    if text.contains("authentication failed") || text.contains("28P01") || text.contains("28000") {
        return (
            "AUTH_FAILED".into(),
            format!("PostgreSQL 鉴权失败（用户名或密码错误）：{text}"),
        );
    }
    ("CONNECT_FAILED".into(), format!("PostgreSQL 连接失败：{text}"))
}

/// Runs one PostgreSQL statement on a private current-thread runtime and returns fully
/// owned string rows, so no borrowed client or driver task outlives the runtime.
fn pg_query(
    record: &SavedConnection,
    password: &str,
    sql: &str,
    params: &[&str],
) -> std::result::Result<(Vec<String>, Vec<Vec<String>>), (String, String)> {
    tcp_preflight(&record.host, record.port)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| ("RUNTIME_FAILED".into(), format!("无法启动连接运行器：{e}")))?;
    runtime
        .block_on(async {
            let config = pg_config(record, password);
            let (client, connection) = tokio::time::timeout(
                CONN_TIMEOUT,
                config.connect(tokio_postgres::NoTls),
            )
            .await
            .map_err(|_| {
                (
                    "PORT_UNREACHABLE".into(),
                    format!("PostgreSQL 握手超时：{}:{}", record.host, record.port),
                )
            })?
            .map_err(|e| map_pg_error(e, password))?;
            let driver = tokio::spawn(connection);
            let outcome = async {
                let statement = client
                    .prepare(sql)
                    .await
                    .map_err(|e| map_pg_error(e, password))?;
                let columns: Vec<String> = statement
                    .columns()
                    .iter()
                    .map(|column| column.name().to_string())
                    .collect();
                let bindings: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
                    .iter()
                    .map(|value| value as &(dyn tokio_postgres::types::ToSql + Sync))
                    .collect();
                let rows = tokio::time::timeout(CONN_TIMEOUT, client.query(&statement, bindings.as_slice()))
                    .await
                    .map_err(|_| {
                        map_query_error("查询超过 5 秒，请缩小查询范围", password)
                    })?
                    .map_err(|e| map_pg_error(e, password))?;
                let mut rendered = Vec::with_capacity(rows.len());
                for row in &rows {
                    if rendered.len() >= crate::SQL_MAX_ROWS {
                        return Err(map_query_error("查询超过 1000 行，请使用 LIMIT 或分页", password));
                    }
                    rendered.push(
                        (0..columns.len())
                            .map(|index| pg_cell(row, index))
                            .collect::<Vec<String>>(),
                    );
                }
                Ok((columns, rendered))
            }
            .await;
            driver.abort();
            outcome
        })
}

fn map_query_error(detail: &str, password: &str) -> (String, String) {
    ("QUERY_FAILED".into(), scrub_password(&detail, password))
}

fn pg_cell(row: &tokio_postgres::Row, index: usize) -> String {
    if let Ok(value) = row.try_get::<_, Option<String>>(index) {
        return value.unwrap_or_else(|| "NULL".into());
    }
    if let Ok(value) = row.try_get::<_, Option<i64>>(index) {
        return value.map(|v| v.to_string()).unwrap_or_else(|| "NULL".into());
    }
    if let Ok(value) = row.try_get::<_, Option<i32>>(index) {
        return value.map(|v| v.to_string()).unwrap_or_else(|| "NULL".into());
    }
    if let Ok(value) = row.try_get::<_, Option<i16>>(index) {
        return value.map(|v| v.to_string()).unwrap_or_else(|| "NULL".into());
    }
    if let Ok(value) = row.try_get::<_, Option<f64>>(index) {
        return value.map(|v| v.to_string()).unwrap_or_else(|| "NULL".into());
    }
    if let Ok(value) = row.try_get::<_, Option<bool>>(index) {
        return value.map(|v| v.to_string()).unwrap_or_else(|| "NULL".into());
    }
    if let Ok(value) = row.try_get::<_, Option<Vec<u8>>>(index) {
        return value
            .map(|bytes| format!("X'{}'", bytes.iter().map(|b| format!("{b:02X}")).collect::<String>()))
            .unwrap_or_else(|| "NULL".into());
    }
    "«不支持的值类型»".into()
}

fn probe_postgres(record: &SavedConnection, password: &str) -> std::result::Result<String, (String, String)> {
    let (columns, rows) = pg_query(record, password, "SELECT VERSION()", &[])?;
    let _ = columns;
    let version = rows
        .first()
        .and_then(|row| row.first())
        .cloned()
        .unwrap_or_else(|| "未知".into());
    Ok(format!("PostgreSQL 握手与鉴权成功，版本 {version}"))
}

fn redis_addr(record: &SavedConnection, password: &str) -> redis::ConnectionInfo {
    let db = record
        .database
        .trim()
        .parse::<i64>()
        .unwrap_or(0);
    redis::ConnectionInfo {
        addr: redis::ConnectionAddr::Tcp(record.host.clone(), record.port),
        redis: redis::RedisConnectionInfo {
            db,
            username: None,
            password: if password.is_empty() {
                None
            } else {
                Some(password.to_string())
            },
            protocol: redis::ProtocolVersion::RESP2,
        },
    }
}

fn redis_connect(record: &SavedConnection, password: &str) -> std::result::Result<redis::Connection, (String, String)> {
    tcp_preflight(&record.host, record.port)?;
    let client = redis::Client::open(redis_addr(record, password))
        .map_err(|e| ("CONNECT_FAILED".into(), format!("无法创建 Redis 客户端：{e}")))?;
    client
        .get_connection_with_timeout(CONN_TIMEOUT)
        .map_err(|e| map_redis_error(&e, password))
}

fn map_redis_error(error: &redis::RedisError, password: &str) -> (String, String) {
    let text = scrub_password(&error.to_string(), password);
    if text.contains("NOAUTH") || text.contains("invalid password") || text.contains("wrong password") {
        return (
            "AUTH_FAILED".into(),
            format!("Redis 鉴权失败（密码不正确或未配置）：{text}"),
        );
    }
    ("CONNECT_FAILED".into(), format!("Redis 连接失败：{text}"))
}

fn probe_redis(record: &SavedConnection, password: &str) -> std::result::Result<String, (String, String)> {
    let mut conn = redis_connect(record, password)?;
    let pong: String = redis::cmd("PING")
        .query(&mut conn)
        .map_err(|e| map_redis_error(&e, password))?;
    Ok(format!("Redis PING 成功：{pong}"))
}

fn redis_value_text(value: &redis::Value) -> String {
    match value {
        redis::Value::Nil => "NULL".into(),
        redis::Value::Int(number) => number.to_string(),
        redis::Value::Double(number) => number.to_string(),
        redis::Value::Boolean(flag) => flag.to_string(),
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        redis::Value::SimpleString(text) => text.clone(),
        redis::Value::VerbatimString { text, .. } => text.clone(),
        redis::Value::Okay => "OK".into(),
        redis::Value::Attribute { data, .. } => redis_value_text(data),
        redis::Value::Array(items) | redis::Value::Set(items) => {
            let rendered: Vec<String> = items
                .iter()
                .take(50)
                .map(redis_value_text)
                .collect();
            if items.len() > 50 {
                format!("{} …共 {} 项", rendered.join(", "), items.len())
            } else {
                rendered.join(", ")
            }
        }
        redis::Value::Map(pairs) => {
            let rendered: Vec<String> = pairs
                .iter()
                .take(50)
                .map(|(key, value)| format!("{}: {}", redis_value_text(key), redis_value_text(value)))
                .collect();
            rendered.join(", ")
        }
        _ => "«不支持的回复类型»".into(),
    }
}

pub fn list_tables(store: &ConnectionStore, id: &str) -> Result<Vec<DbTableInfo>> {
    let record = store.get(id)?;
    let password = store.password_of(&record)?;
    match record.engine {
        DbEngine::Sqlite => {
            let sql = "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name;";
            let (_, rows) = crate::query_sqlite_readonly(Path::new(&record.database), sql)?;
            Ok(rows
                .into_iter()
                .filter(|row| row.len() >= 2)
                .map(|row| DbTableInfo {
                    name: row[0].clone(),
                    kind: row[1].clone(),
                })
                .collect())
        }
        DbEngine::Mysql => {
            use mysql::prelude::Queryable;
            tcp_preflight(&record.host, record.port).map_err(|(_, e)| e)?;
            let mut conn = mysql::Conn::new(mysql_opts(&record, &password))
                .map_err(|e| map_mysql_error(&e).1)?;
            let rows: Vec<(String, String)> = conn
                .query(
                    "SELECT table_name, table_type FROM information_schema.tables \
                     WHERE table_schema = DATABASE() ORDER BY table_name",
                )
                .map_err(|e| scrub_password(&map_mysql_error(&e).1, &password))?;
            Ok(rows
                .into_iter()
                .map(|(name, kind)| DbTableInfo { name, kind })
                .collect())
        }
        DbEngine::Postgres => {
            let sql = "SELECT c.relname, CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END \
                       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                       WHERE n.nspname = current_schema() AND c.relkind IN ('r','m','v','f') ORDER BY c.relname";
            let (_, rows) = pg_query(&record, &password, sql, &[])
                .map_err(|(_, detail)| scrub_password(&detail, &password))?;
            Ok(rows
                .into_iter()
                .filter(|row| row.len() >= 2)
                .map(|row| DbTableInfo {
                    name: row[0].clone(),
                    kind: row[1].clone(),
                })
                .collect())
        }
        DbEngine::Redis => {
            let mut conn = redis_connect(&record, &password).map_err(|(_, e)| e)?;
            let size: i64 = redis::cmd("DBSIZE")
                .query(&mut conn)
                .map_err(|e| map_redis_error(&e, &password).1)?;
            Ok(vec![DbTableInfo {
                name: "键空间".into(),
                kind: format!("keys {size}"),
            }])
        }
    }
}

fn is_safe_identifier(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}

pub fn table_columns(store: &ConnectionStore, id: &str, table: &str) -> Result<Vec<DbColumnInfo>> {
    if !is_safe_identifier(table) {
        return Err("表名包含非法字符".into());
    }
    let record = store.get(id)?;
    let password = store.password_of(&record)?;
    match record.engine {
        DbEngine::Sqlite => {
            let sql = format!("PRAGMA table_info(\"{table}\");");
            let (_, rows) = crate::query_sqlite_readonly(Path::new(&record.database), &sql)?;
            Ok(rows
                .into_iter()
                .filter(|row| row.len() >= 6)
                .map(|row| DbColumnInfo {
                    cid: row[0].parse().unwrap_or(0),
                    name: row[1].clone(),
                    data_type: row[2].clone(),
                    not_null: row[3] == "1",
                    dflt_value: if row[4] == "NULL" { None } else { Some(row[4].clone()) },
                    pk: row[5] == "1",
                    pk_position: if row[5] == "1" { row[0].parse().unwrap_or(0) } else { 0 },
                })
                .collect())
        }
        DbEngine::Mysql => {
            use mysql::prelude::Queryable;
            tcp_preflight(&record.host, record.port).map_err(|(_, e)| e)?;
            let mut conn = mysql::Conn::new(mysql_opts(&record, &password))
                .map_err(|e| map_mysql_error(&e).1)?;
            let rows: Vec<(i64, String, String, String, Option<String>, Option<String>)> = conn
                .exec(
                    "SELECT ordinal_position, column_name, data_type, is_nullable, column_default, column_key \
                     FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? \
                     ORDER BY ordinal_position",
                    (table,),
                )
                .map_err(|e| scrub_password(&map_mysql_error(&e).1, &password))?;
            Ok(rows
                .into_iter()
                .map(|(cid, name, data_type, nullable, dflt, key)| DbColumnInfo {
                    cid,
                    name,
                    data_type,
                    not_null: !nullable.eq("YES"),
                    dflt_value: dflt,
                    pk: key.as_deref().unwrap_or_default().eq_ignore_ascii_case("PRI"),
                    pk_position: if key.as_deref().unwrap_or_default().eq_ignore_ascii_case("PRI") { cid } else { 0 },
                })
                .collect())
        }
        DbEngine::Postgres => {
            let sql = "SELECT ordinal_position, column_name, data_type, is_nullable, column_default \
                       FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema() \
                       ORDER BY ordinal_position";
            let (_, rows) = pg_query(&record, &password, sql, &[table])
                .map_err(|(_, detail)| scrub_password(&detail, &password))?;
            let primary = pg_primary_columns(&record, &password, table)
                .map_err(|(_, detail)| scrub_password(&detail, &password))?;
            Ok(rows
                .into_iter()
                .filter(|row| row.len() >= 4)
                .enumerate()
                .map(|(index, row)| DbColumnInfo {
                    cid: row[0].parse().unwrap_or(index as i64 + 1),
                    name: row[1].clone(),
                    data_type: row[2].clone(),
                    not_null: row[3] == "NO",
                    dflt_value: if row[4] == "NULL" { None } else { Some(row[4].clone()) },
                    pk: primary.contains(&row[1]),
                    pk_position: if primary.contains(&row[1]) { row[0].parse().unwrap_or(index as i64 + 1) } else { 0 },
                })
                .collect())
        }
        DbEngine::Redis => Err("Redis 没有表结构，请展开「键空间」查看键".into()),
    }
}

fn pg_primary_columns(
    record: &SavedConnection,
    password: &str,
    table: &str,
) -> std::result::Result<std::collections::HashSet<String>, (String, String)> {
    let sql = "SELECT a.attname FROM pg_index i \
               JOIN pg_class c ON c.oid = i.indrelid \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey) \
               WHERE i.indisprimary AND c.relname = $1 AND n.nspname = current_schema()";
    let (_, rows) = pg_query(record, password, sql, &[table])?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.first().cloned())
        .collect())
}

pub fn redis_keys(store: &ConnectionStore, id: &str, pattern: Option<&str>) -> Result<Vec<DbTableInfo>> {
    let record = store.get(id)?;
    let password = store.password_of(&record)?;
    let mut conn = redis_connect(&record, &password).map_err(|(_, e)| e)?;
    let match_pattern = pattern.filter(|value| !value.trim().is_empty()).unwrap_or("*");
    let mut cursor = "0".to_string();
    let mut keys = Vec::new();
    for _ in 0..20 {
        let reply: redis::Value = redis::cmd("SCAN")
            .arg(&cursor)
            .arg("MATCH")
            .arg(match_pattern)
            .arg("COUNT")
            .arg(200)
            .query(&mut conn)
            .map_err(|e| map_redis_error(&e, &password).1)?;
        let redis::Value::Array(items) = &reply else {
            return Err("Redis SCAN 返回结构异常".into());
        };
        let next = items
            .first()
            .map(redis_value_text)
            .unwrap_or_else(|| "0".into());
        if let Some(batch) = items.get(1).and_then(|value| match value {
            redis::Value::Array(items) => Some(items),
            _ => None,
        }) {
            for key in batch {
                let name = redis_value_text(key);
                let kind: String = redis::cmd("TYPE")
                    .arg(&name)
                    .query(&mut conn)
                    .unwrap_or_else(|_| "unknown".into());
                keys.push(DbTableInfo { name, kind });
                if keys.len() >= 200 {
                    return Ok(keys);
                }
            }
        }
        cursor = next;
        if cursor == "0" {
            break;
        }
    }
    Ok(keys)
}

pub fn run_query(store: &ConnectionStore, id: &str, query: &str) -> Result<SqlQueryResult> {
    let record = store.get(id)?;
    let password = store.password_of(&record)?;
    let guard = if record.read_only {
        match record.engine {
            DbEngine::Redis => classify_readonly_redis(query).map(|_| ()),
            // SQLite 仍由引擎级 authorizer 兜底，这里先把拦截原因说清楚。
            _ => classify_readonly_sql(query),
        }
    } else {
        Ok(())
    };
    if let Err(denied) = guard {
        return Ok(SqlQueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            duration_ms: 0,
            error: Some(denied),
        });
    }
    let started = Instant::now();
    let outcome: std::result::Result<(Vec<String>, Vec<Vec<String>>), String> = match record.engine {
        DbEngine::Sqlite => crate::query_sqlite_readonly(Path::new(&record.database), query),
        DbEngine::Mysql => {
            use mysql::prelude::Queryable;
            tcp_preflight(&record.host, record.port).map_err(|(_, e)| e)?;
            let mut conn =
                mysql::Conn::new(mysql_opts(&record, &password)).map_err(|e| map_mysql_error(&e).1)?;
            let result = conn
                .query_iter(query)
                .map_err(|e| scrub_password(&map_mysql_error(&e).1, &password))?;
            let columns: Vec<String> = result
                .columns()
                .as_ref()
                .iter()
                .map(|column| column.name_str().into_owned())
                .collect();
            let mut rows = Vec::new();
            for row in result
                .map(|row| row.map_err(|e| e.to_string()))
                .collect::<std::result::Result<Vec<_>, _>>()?
            {
                let values = (0..row.len())
                    .map(|index| match row.get::<mysql::Value, usize>(index) {
                        None | Some(mysql::Value::NULL) => "NULL".into(),
                        Some(mysql::Value::Bytes(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
                        Some(mysql::Value::Int(number)) => number.to_string(),
                        Some(mysql::Value::UInt(number)) => number.to_string(),
                        Some(mysql::Value::Float(number)) => number.to_string(),
                        Some(mysql::Value::Double(number)) => number.to_string(),
                        Some(_) => "«不支持的值类型»".into(),
                    })
                    .collect();
                rows.push(values);
                if rows.len() > crate::SQL_MAX_ROWS {
                    return Err("查询超过 1000 行，请使用 LIMIT 或分页".into());
                }
            }
            Ok((columns, rows))
        }
        DbEngine::Postgres => pg_query(&record, &password, query, &[])
            .map_err(|(_, detail)| scrub_password(&detail, &password)),
        DbEngine::Redis => {
            let tokens = classify_readonly_redis(query)?;
            let mut command = redis::Cmd::new();
            for token in &tokens {
                command.arg(token);
            }
            let head = tokens[0].clone();
            let mut conn = redis_connect(&record, &password).map_err(|(_, e)| e)?;
            let reply: redis::Value = command
                .query(&mut conn)
                .map_err(|e| map_redis_error(&e, &password).1)?;
            Ok((
                vec!["命令".into(), "回复".into()],
                vec![vec![head, redis_value_text(&reply)]],
            ))
        }
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok((columns, rows)) => {
            let row_count = rows.len();
            Ok(SqlQueryResult {
                columns,
                rows,
                row_count,
                duration_ms,
                error: None,
            })
        }
        Err(error) => Ok(SqlQueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            duration_ms,
            error: Some(error),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(dir: &Path) -> ConnectionStore {
        ConnectionStore::new(dir.join("connections.json"))
    }

    fn input(engine: DbEngine, name: &str) -> ConnectionInput {
        ConnectionInput {
            id: String::new(),
            name: name.to_string(),
            engine: Some(engine),
            host: "127.0.0.1".into(),
            port: Some(engine.default_port().max(1)),
            user: "app".into(),
            password: None,
            database: "demo".into(),
            tls: false,
            read_only: true,
            revision: None,
        }
    }

    fn sqlite_db(dir: &Path) -> String {
        let path = dir.join("demo.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL);
                 INSERT INTO users (name, score) VALUES ('阿橦', 12.5), ('阿党', NULL);",
            )
            .unwrap();
        }
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn seals_password_and_never_exposes_it_in_summaries() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path().as_ref());
        let mut item = input(DbEngine::Mysql, "订单库");
        item.password = Some("S3cr3t-口令".into());
        let saved = store.save(&item).unwrap();

        assert!(saved.has_password);
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.engine, DbEngine::Mysql);
        let raw = fs::read_to_string(&store.path).unwrap();
        assert!(!raw.contains("S3cr3t"), "明文泄漏到连接文件");
        assert!(raw.contains(GCM_PREFIX));
        assert_eq!(fs::read(store.key_path()).unwrap().len(), 32);

        let record = store.get(&saved.id).unwrap();
        assert_eq!(store.password_of(&record).unwrap(), "S3cr3t-口令");
        assert!(store.list().unwrap()[0].has_password);
    }

    #[test]
    fn keeps_or_clears_the_sealed_password_on_edit() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path().as_ref());
        let mut item = input(DbEngine::Postgres, "报表库");
        item.database = "analytics".into();
        item.password = Some("first".into());
        let saved = store.save(&item).unwrap();

        item.id = saved.id.clone();
        item.revision = Some(saved.revision);
        item.password = None;
        let kept = store.save(&item).unwrap();
        assert!(kept.has_password);
        assert_eq!(kept.revision, 2);
        assert_eq!(
            store.password_of(&store.get(&kept.id).unwrap()).unwrap(),
            "first"
        );

        item.password = Some(String::new());
        item.revision = Some(kept.revision);
        let cleared = store.save(&item).unwrap();
        assert!(!cleared.has_password);
        assert_eq!(
            store.password_of(&store.get(&cleared.id).unwrap()).unwrap(),
            ""
        );
    }

    #[test]
    fn rejects_conflicting_revision_duplicate_name_and_foreign_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path().as_ref());
        let mut item = input(DbEngine::Mysql, "主库");
        item.password = Some("pw".into());
        let saved = store.save(&item).unwrap();

        item.id = saved.id.clone();
        item.revision = Some(saved.revision + 7);
        assert!(store.save(&item).unwrap_err().starts_with("REVISION_CONFLICT"));

        let other = input(DbEngine::Mysql, "主库");
        assert!(store.save(&other).unwrap_err().contains("同名连接"));

        let record = store.get(&saved.id).unwrap();
        fs::write(store.key_path(), [7u8; 32]).unwrap();
        assert!(store
            .password_of(&record)
            .unwrap_err()
            .starts_with("DECRYPT_FAILED"));
    }

    #[test]
    fn enforces_per_engine_validation_rules() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path().as_ref());
        let db = sqlite_db(dir.path().as_ref());

        let mut rel = input(DbEngine::Sqlite, "相对路径");
        rel.database = "local.db".into();
        assert!(store.save(&rel).unwrap_err().contains("绝对路径"));

        let mut missing = input(DbEngine::Sqlite, "缺失文件");
        missing.database = dir.path().join("nope.db").to_string_lossy().into_owned();
        assert!(store.save(&missing).unwrap_err().contains("文件不存在"));

        let mut ok = input(DbEngine::Sqlite, "本地库");
        ok.database = db.clone();
        ok.host = String::new();
        ok.user = String::new();
        assert!(store.save(&ok).is_ok());

        let mut bad_host = input(DbEngine::Mysql, "坏主机");
        bad_host.host = "127.0.0.1:3306".into();
        assert!(store.save(&bad_host).unwrap_err().contains("主机地址格式"));

        let mut zero_port = input(DbEngine::Mysql, "零端口");
        zero_port.port = Some(0);
        assert!(store.save(&zero_port).unwrap_err().contains("端口"));

        let mut no_user = input(DbEngine::Mysql, "缺用户名");
        no_user.user = String::new();
        assert!(store.save(&no_user).unwrap_err().contains("用户名"));

        let mut no_db = input(DbEngine::Postgres, "缺库名");
        no_db.database = String::new();
        assert!(store.save(&no_db).unwrap_err().contains("数据库名"));

        let mut bad_redis_db = input(DbEngine::Redis, "坏索引");
        bad_redis_db.database = "cache".into();
        assert!(store.save(&bad_redis_db).unwrap_err().contains("数字"));

        let mut pg_tls = input(DbEngine::Postgres, "PG 开 SSL");
        pg_tls.tls = true;
        let error = store.save(&pg_tls).unwrap_err();
        assert!(error.starts_with("TLS_UNSUPPORTED"), "{error}");

        let mut redis_tls = input(DbEngine::Redis, "Redis 开 SSL");
        redis_tls.tls = true;
        assert!(store.save(&redis_tls).unwrap_err().contains("Redis"));

        let name_too_long = input(DbEngine::Mysql, &"长".repeat(65));
        assert!(store.save(&name_too_long).unwrap_err().contains("1-64"));
    }

    #[test]
    fn reads_a_real_sqlite_connection_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path().as_ref());
        let mut item = input(DbEngine::Sqlite, "演示库");
        item.database = sqlite_db(dir.path().as_ref());
        let saved = store.save(&item).unwrap();

        let probe = test_connection(&store, &saved.id).unwrap();
        assert!(probe.ok, "{}", probe.detail);
        assert!(probe.detail.contains("SQLite 可只读打开"));

        let tables = list_tables(&store, &saved.id).unwrap();
        assert_eq!(tables[0].name, "users");
        assert_eq!(tables[0].kind, "table");

        let columns = table_columns(&store, &saved.id, "users").unwrap();
        assert_eq!(columns.len(), 3);
        assert!(columns[0].pk);
        assert!(columns[1].not_null);

        let result = run_query(
            &store,
            &saved.id,
            "SELECT name, score FROM users ORDER BY id;",
        )
        .unwrap();
        assert_eq!(result.row_count, 2);
        assert_eq!(result.columns, vec!["name".to_string(), "score".to_string()]);
        assert_eq!(result.rows[1][1], "NULL");

        let pragma = run_query(&store, &saved.id, "PRAGMA table_info(users);").unwrap();
        assert!(pragma.error.is_none(), "{:?}", pragma.error);
        assert_eq!(pragma.row_count, 3);

        for blocked in [
            "UPDATE users SET score = 1 WHERE id = 1;",
            "SELECT 1; DROP TABLE users;",
            "ATTACH DATABASE 'x.db' AS other;",
        ] {
            let outcome = run_query(&store, &saved.id, blocked).unwrap();
            let error = outcome.error.unwrap_or_default();
            assert!(error.contains("只读"), "{blocked} 未被拦截：{error}");
        }
        assert_eq!(list_tables(&store, &saved.id).unwrap()[0].name, "users");
    }

    #[test]
    fn classifies_readonly_sql() {
        for allowed in [
            "SELECT * FROM users WHERE name = 'a;b'",
            "  with cte as (select 1) select * from cte",
            "SHOW TABLES",
            "EXPLAIN SELECT 1",
            "/* 注释 */ SELECT 1",
            "SELECT 1 -- 尾注释",
            // 元数据头的参数里合法带 DDL 词，不参与关键字扫描
            "SHOW CREATE TABLE users",
            "DESCRIBE users",
            // 与关键字同名的函数调用不是语句
            "SELECT REPLACE(name, 'a', 'b') FROM users",
            "SELECT * FROM t WHERE updated_at > '2026-01-01'",
            "SELECT * FROM logs WHERE note = 'don''t delete'",
            // MySQL 的 \\' 转义只在「暴露出来的片段含写关键字」时才拦，普通英文撇号不误伤
            "SELECT 'Bob\\'s' AS name",
        ] {
            assert!(classify_readonly_sql(allowed).is_ok(), "{allowed}");
        }
        for denied in [
            "UPDATE users SET a = 1",
            "DELETE FROM users",
            "INSERT INTO users VALUES (1)",
            "CREATE TABLE t (a INT)",
            "DROP TABLE users",
            "SELECT * FROM users FOR UPDATE",
            "SELECT * FROM users LOCK IN SHARE MODE",
            "SELECT * FROM t INTO OUTFILE '/tmp/x'",
            "SELECT 1; SELECT 2",
            "CALL sp_x()",
            "",
            "SElecT 1; DELETE FROM t",
            // EXPLAIN ANALYZE 会真跑一遍语句，只读连接一律不放行
            "EXPLAIN ANALYZE SELECT * FROM users",
            "EXPLAIN ANALYZE DELETE FROM users",
            "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM users",
            // PostgreSQL 数据修改 CTE：关键字藏在括号里也要扫到
            "WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d",
            "WITH i AS (INSERT INTO audit(msg) VALUES ('x') RETURNING id) SELECT * FROM i",
            "WITH u AS (UPDATE users SET name = 'x' RETURNING id) SELECT * FROM u",
            // PostgreSQL 标准字符串里 \\ 不是转义符，别让它把 FOR UPDATE 藏进串里
            "SELECT 'a\\' FOR UPDATE",
            "SELECT 'a\\' OR 1=1; DELETE FROM t",
            // SELECT ... INTO 在 PostgreSQL 里是建表
            "SELECT * INTO users_backup FROM users",
        ] {
            assert!(classify_readonly_sql(denied).is_err(), "{denied} 应被拦截");
        }
    }

    #[test]
    fn denied_bypasses_report_which_guard_fired() {
        assert!(classify_readonly_sql("EXPLAIN ANALYZE DELETE FROM users")
            .unwrap_err()
            .starts_with("GUARD_READONLY"));
        assert!(classify_readonly_sql("WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d")
            .unwrap_err()
            .contains("只读"));
        // 反斜杠歧义暴露出分号时按多语句拦截，两种解释都过闸
        assert!(classify_readonly_sql("SELECT 'a\\' AS x; DELETE FROM t")
            .unwrap_err()
            .starts_with("GUARD_SINGLE_STATEMENT"));
    }

    #[test]
    fn classifies_readonly_redis_commands() {
        assert_eq!(
            classify_readonly_redis("GET user:1").unwrap(),
            vec!["get", "user:1"]
        );
        assert_eq!(
            classify_readonly_redis("config get maxmemory").unwrap(),
            vec!["config", "get", "maxmemory"]
        );
        assert!(classify_readonly_redis("PRAGMA table_info(users)").is_err());
        assert!(classify_readonly_redis("HGETALL h").is_ok());
        for denied in ["SET k v", "DEL k", "FLUSHALL", "GET a\nDEL b", "EVAL \"return 1\" 0", ""] {
            assert!(classify_readonly_redis(denied).is_err(), "{denied} 应被拦截");
        }
        assert!(classify_readonly_redis("GET a\nDEL b")
            .unwrap_err()
            .starts_with("GUARD_SINGLE_STATEMENT"));
    }

    #[test]
    fn unreachable_engines_report_codes_without_leaking_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path().as_ref());
        let secret = "Sup3r-Secret-Pass";
        for engine in [DbEngine::Mysql, DbEngine::Postgres, DbEngine::Redis] {
            let mut item = input(engine, &format!("失联 {:?}", engine));
            item.host = "127.0.0.1".into();
            item.port = Some(1);
            item.database = match engine {
                DbEngine::Postgres => "analytics".into(),
                DbEngine::Redis => "0".into(),
                _ => "demo".into(),
            };
            item.password = Some(secret.into());
            let saved = store.save(&item).unwrap();
            let probe = test_connection(&store, &saved.id).unwrap();
            assert!(!probe.ok, "{engine:?} 不该连上 127.0.0.1:1");
            let code = probe.error_code.clone().unwrap();
            assert!(
                [
                    "HOST_UNRESOLVED",
                    "PORT_UNREACHABLE",
                    "CONNECT_FAILED",
                    "AUTH_FAILED",
                    "DB_NOT_FOUND"
                ]
                .contains(&code.as_str()),
                "{engine:?} 返回了未预期错误码 {code}: {}",
                probe.detail
            );
            assert!(!probe.detail.contains(secret), "{engine:?} 错误文本泄漏口令");
        }
    }

    #[test]
    fn remove_drops_the_record_and_rejects_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path().as_ref());
        let saved = store.save(&input(DbEngine::Mysql, "待删")).unwrap();
        assert_eq!(store.remove(&saved.id).unwrap().len(), 0);
        assert!(store.remove(&saved.id).unwrap_err().contains("未找到"));
    }

    #[test]
    fn refuses_a_foreign_connection_file_version() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(dir.path().as_ref());
        store.save(&input(DbEngine::Mysql, "先存")).unwrap();
        fs::write(&store.path, r#"{"version":2,"connections":[]}"#).unwrap();
        assert!(store.list().unwrap_err().contains("版本不受支持"));
    }
}

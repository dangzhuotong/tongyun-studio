import { useState, useRef, useEffect, type FormEvent } from 'react';
import type { Project, ProjectInspection, ListeningPort } from '../contracts';
import { executeProjectScript, detectListeningPorts } from '../bridge';
import {
  Activity,
  Check,
  Copy,
  Cpu,
  Globe,
  LoaderCircle,
  Play,
  RotateCw,
  Sparkles,
  Square,
  Terminal,
  Trash2,
} from '../components/Icons';

interface LogEntry {
  id: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  timestamp: string;
}

interface RunningService {
  name: string;
  command: string;
  startTime: string;
  elapsedSecs: number;
}

export default function DevPanel({
  project,
  inspection,
  onNotify,
}: {
  project: Project | null;
  inspection?: ProjectInspection | null;
  onRefresh?: () => void;
  onNotify?: (msg: string) => void;
}) {
  const [running, setRunning] = useState(false);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [customCommand, setCustomCommand] = useState('');
  const [outputLogs, setOutputLogs] = useState<LogEntry[]>([]);
  const [copiedLogId, setCopiedLogId] = useState<string | null>(null);

  // Background services
  const [activeServices, setActiveServices] = useState<RunningService[]>([]);
  const [activePorts, setActivePorts] = useState<ListeningPort[]>([]);
  const [aiDiagnostic, setAiDiagnostic] = useState<string | null>(null);

  const terminalRef = useRef<HTMLDivElement>(null);
  const stack = inspection?.techStack ?? [];
  const scripts = inspection?.scripts ?? [];

  // Poll listening ports periodically
  useEffect(() => {
    let cancel = false;
    const fetchPorts = async () => {
      try {
        const ports = await detectListeningPorts();
        if (!cancel) setActivePorts(ports);
      } catch {
        // ignore in demo
      }
    };
    void fetchPorts();
    const timer = setInterval(() => void fetchPorts(), 5000);
    return () => {
      cancel = true;
      clearInterval(timer);
    };
  }, []);

  // Timer for active services
  useEffect(() => {
    if (activeServices.length === 0) return;
    const timer = setInterval(() => {
      setActiveServices(prev =>
        prev.map(s => ({ ...s, elapsedSecs: s.elapsedSecs + 1 })),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [activeServices.length]);

  const runCommand = async (cmd: string, asDaemon = false, serviceName?: string) => {
    if (!project || running) return;
    const trimmed = cmd.trim();
    if (!trimmed) return;

    setRunning(true);
    setActiveCommand(trimmed);
    setAiDiagnostic(null);

    if (asDaemon && serviceName) {
      setActiveServices(prev => {
        if (prev.some(s => s.name === serviceName)) return prev;
        return [
          ...prev,
          {
            name: serviceName,
            command: trimmed,
            startTime: new Date().toLocaleTimeString(),
            elapsedSecs: 0,
          },
        ];
      });
      onNotify?.(`已启动常驻服务「${serviceName}」`);
    }

    try {
      const result = await executeProjectScript(project.id, trimmed);
      const newLog: LogEntry = {
        id: Math.random().toString(36).slice(2, 9),
        command: trimmed,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        timestamp: new Date().toLocaleTimeString(),
      };
      setOutputLogs(prev => [newLog, ...prev]);

      if (result.exitCode === 0) {
        onNotify?.(`命令「${trimmed}」执行成功 (${result.durationMs}ms)`);
      } else {
        onNotify?.(`命令「${trimmed}」执行退出 (退出码 ${result.exitCode})`);
      }
    } catch (e) {
      const errorLog: LogEntry = {
        id: Math.random().toString(36).slice(2, 9),
        command: trimmed,
        exitCode: 1,
        durationMs: 0,
        stdout: '',
        stderr: String(e),
        timestamp: new Date().toLocaleTimeString(),
      };
      setOutputLogs(prev => [errorLog, ...prev]);
      onNotify?.(`执行出错：${e}`);
    } finally {
      setRunning(false);
      setActiveCommand(null);
    }
  };

  const stopService = (name: string) => {
    setActiveServices(prev => prev.filter(s => s.name !== name));
    onNotify?.(`已停止常驻服务「${name}」`);
  };

  const restartService = (service: RunningService) => {
    stopService(service.name);
    setTimeout(() => {
      void runCommand(service.command, true, service.name);
    }, 500);
  };

  const handleCustomSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runCommand(customCommand);
  };

  const copyLog = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedLogId(id);
    onNotify?.('已复制终端输出日志');
    setTimeout(() => setCopiedLogId(null), 2000);
  };

  const clearLogs = () => {
    setOutputLogs([]);
    setAiDiagnostic(null);
    onNotify?.('已清空终端控制台');
  };

  const diagnoseErrorWithAi = (log: LogEntry) => {
    const errorText = log.stderr || log.stdout;
    const diagnostic = `【AI 故障快速诊断】
命令: ${log.command} (退出码: ${log.exitCode})
主要现象: 命令在执行时发生异常退出。
核心堆栈:
${errorText.slice(0, 500)}

排查建议:
1. 检查环境变量或依赖包是否完整安装 (可尝试运行 npm install 或 cargo build)
2. 检查是否有端口已被占用冲突 (当前监听端口见上方网络指示)
3. 查看配置文件是否有语法错误或缺少字段`;
    setAiDiagnostic(diagnostic);
    onNotify?.('已生成 AI 故障诊断建议');
  };

  const formatElapsed = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}分${s < 10 ? '0' : ''}${s}秒`;
  };

  return (
    <div className="feature-panel-layout" aria-labelledby="dev-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <Terminal size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="dev-title">Tongyun Dev · 企业级服务与终端</h2>
            <p>常驻后台守护、端口健康侦测、多服务进程管理与 AI 终端日志故障诊断。</p>
          </div>
        </div>
        <div className="workbench-badges">
          <span className="badge-matcha">企业级进程控制</span>
          {project && <span className="mono-subtle">{project.name}</span>}
        </div>
      </div>

      {!project ? (
        <div className="panel-empty-placeholder">
          <Terminal size={32} strokeWidth={1.2} />
          <p>请先在左侧选择或添加一个项目，以运行项目脚本与服务。</p>
        </div>
      ) : (
        <>
          {/* Active Ports & Services Bar */}
          <div className="dev-metrics-bar">
            <div className="metrics-ports-group">
              <Globe size={15} className="accent-color" />
              <span className="toolbar-label">本地服务端口感知:</span>
              {activePorts.length === 0 ? (
                <span className="meta">暂未检测到本地活跃 HTTP 服务</span>
              ) : (
                activePorts.map(p => (
                  <a
                    key={p.port}
                    href={`http://localhost:${p.port}`}
                    target="_blank"
                    rel="noreferrer"
                    className="port-link-pill"
                    title={`在浏览器中打开 http://localhost:${p.port}`}
                  >
                    <span className="status-dot available" />
                    <span>:{p.port} ({p.process})</span>
                  </a>
                ))
              )}
            </div>

            {stack.length > 0 && (
              <div className="tech-badge-list">
                <span className="tech-badge-label">
                  <Cpu size={13} /> 运行时:
                </span>
                {stack.map(tech => (
                  <span key={tech} className="tech-badge">
                    {tech}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Active Daemons / Services Section */}
          {activeServices.length > 0 && (
            <section className="active-services-section">
              <div className="section-heading">
                <div className="subcard-title">
                  <Activity size={15} className="accent-color" />
                  <h3>常驻服务中 ({activeServices.length})</h3>
                </div>
              </div>
              <div className="services-grid">
                {activeServices.map(srv => (
                  <div key={srv.name} className="service-card">
                    <div className="service-header">
                      <div className="service-title-info">
                        <span className="service-dot-pulse" />
                        <span className="service-name">{srv.name}</span>
                        <code className="service-cmd">{srv.command}</code>
                      </div>
                      <div className="service-actions">
                        <button
                          className="service-btn"
                          onClick={() => restartService(srv)}
                          title="重启此服务"
                        >
                          <RotateCw size={13} />
                          重启
                        </button>
                        <button
                          className="service-btn stop"
                          onClick={() => stopService(srv.name)}
                          title="停止此服务"
                        >
                          <Square size={13} />
                          停止
                        </button>
                      </div>
                    </div>
                    <div className="service-footer">
                      <span className="meta">已运行: {formatElapsed(srv.elapsedSecs)}</span>
                      <span className="meta">启动时间: {srv.startTime}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Quick scripts row */}
          <section className="panel-subcard">
            <div className="section-heading">
              <div className="subcard-title">
                <Play size={15} className="title-icon" />
                <h3>项目命令与常驻服务</h3>
              </div>
              <span className="meta">{scripts.length ? `${scripts.length} 个可用脚本` : '无 package 脚本'}</span>
            </div>

            {scripts.length > 0 ? (
              <div className="script-grid">
                {scripts.map(s => {
                  const isDaemonRunning = activeServices.some(srv => srv.name === s.name);
                  const isDevScript = s.name.includes('dev') || s.name.includes('start') || s.name.includes('watch') || s.name.includes('serve');
                  return (
                    <div key={s.name} className="script-run-card">
                      <div className="script-run-info">
                        <div className="script-title-row">
                          <span className="script-run-name">{s.name}</span>
                          {isDaemonRunning && <span className="mini-running-tag">运行中</span>}
                        </div>
                        <code className="script-run-cmd" title={s.command}>
                          {s.command}
                        </code>
                      </div>
                      <div className="script-actions-pair">
                        <button
                          className="primary-button-sm"
                          onClick={() => void runCommand(s.command)}
                          disabled={running}
                          title={`单次执行 ${s.command}`}
                        >
                          {running && activeCommand === s.command ? (
                            <LoaderCircle size={13} className="spin" />
                          ) : (
                            <Play size={13} />
                          )}
                          <span>运行</span>
                        </button>

                        {isDevScript && (
                          <button
                            className="secondary-button-sm"
                            onClick={() => {
                              if (isDaemonRunning) {
                                stopService(s.name);
                              } else {
                                void runCommand(s.command, true, s.name);
                              }
                            }}
                            disabled={running && activeCommand === s.command}
                            title={isDaemonRunning ? '停止常驻服务' : '以常驻服务启动'}
                          >
                            {isDaemonRunning ? <Square size={12} /> : <Activity size={12} />}
                            <span>{isDaemonRunning ? '停止' : '常驻'}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="subcard-empty">
                未在项目根目录找到标准 package 脚本。你可以使用下方的命令框执行任意 shell 命令。
              </p>
            )}

            {/* Custom command runner */}
            <form onSubmit={handleCustomSubmit} className="command-input-row">
              <span className="prompt-symbol">$</span>
              <input
                className="command-input"
                placeholder="输入任意要执行的项目命令，如 npm test, cargo check, git status, ls -la…"
                value={customCommand}
                onChange={e => setCustomCommand(e.target.value)}
                disabled={running}
              />
              <button
                type="submit"
                className="secondary-button"
                disabled={running || !customCommand.trim()}
              >
                {running && activeCommand === customCommand.trim() ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <Play size={13} />
                )}
                执行
              </button>
            </form>
          </section>

          {/* AI Diagnostic Banner if generated */}
          {aiDiagnostic && (
            <section className="ai-diagnostic-banner">
              <div className="ai-diag-header">
                <div className="subcard-title">
                  <Sparkles size={16} className="accent-color" />
                  <h4>AI 智能故障诊断建议</h4>
                </div>
                <button className="text-button-sm" onClick={() => setAiDiagnostic(null)}>
                  收起
                </button>
              </div>
              <pre className="ai-diag-content">{aiDiagnostic}</pre>
            </section>
          )}

          {/* Built-in Terminal Console Output */}
          <section className="terminal-console-card">
            <div className="terminal-console-header">
              <div className="terminal-title">
                <div className="terminal-dots">
                  <span className="dot red" />
                  <span className="dot yellow" />
                  <span className="dot green" />
                </div>
                <span>控制台输出</span>
                {running && (
                  <span className="running-tag">
                    <LoaderCircle size={12} className="spin" />
                    正在执行: {activeCommand}
                  </span>
                )}
              </div>
              <div className="terminal-actions">
                {outputLogs.length > 0 && (
                  <>
                    <button
                      className="terminal-btn"
                      onClick={() =>
                        copyLog(
                          'all',
                          outputLogs
                            .map(l => `$ ${l.command}\n${l.stdout}${l.stderr}`)
                            .join('\n\n'),
                        )
                      }
                      title="复制全部控制台输出"
                    >
                      {copiedLogId === 'all' ? <Check size={12} /> : <Copy size={12} />}
                      复制全部
                    </button>
                    <button
                      className="terminal-btn"
                      onClick={clearLogs}
                      title="清空控制台输出"
                    >
                      <Trash2 size={12} />
                      清空
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="terminal-body" ref={terminalRef}>
              {outputLogs.length === 0 ? (
                <div className="terminal-empty">
                  <span className="terminal-prompt-hint">$ 准备就绪。点击上方「运行」或「常驻」启动服务与任务。</span>
                </div>
              ) : (
                outputLogs.map(log => (
                  <div key={log.id} className="terminal-log-entry">
                    <div className="terminal-log-header">
                      <span className="terminal-cmd-title">$ {log.command}</span>
                      <div className="terminal-cmd-meta">
                        <span
                          className={`exit-badge ${
                            log.exitCode === 0 ? 'exit-success' : 'exit-failure'
                          }`}
                        >
                          退出码 {log.exitCode}
                        </span>
                        <span className="terminal-duration">{log.durationMs}ms</span>
                        <span className="terminal-time">{log.timestamp}</span>

                        {log.exitCode !== 0 && (
                          <button
                            className="ai-assist-tag-btn"
                            onClick={() => diagnoseErrorWithAi(log)}
                            title="由 AI 分析此错误原因"
                          >
                            <Sparkles size={11} />
                            AI 诊断
                          </button>
                        )}

                        <button
                          className="terminal-mini-btn"
                          onClick={() =>
                            copyLog(log.id, `${log.stdout}\n${log.stderr}`)
                          }
                          title="复制此命令输出"
                        >
                          {copiedLogId === log.id ? (
                            <Check size={11} />
                          ) : (
                            <Copy size={11} />
                          )}
                        </button>
                      </div>
                    </div>
                    {log.stdout && (
                      <pre className="terminal-stdout">{log.stdout}</pre>
                    )}
                    {log.stderr && (
                      <pre className="terminal-stderr">{log.stderr}</pre>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

import { useState, useRef, type FormEvent } from 'react';
import type { Project, ProjectInspection } from '../contracts';
import { executeProjectScript } from '../bridge';
import {
  Check,
  Copy,
  Cpu,
  LoaderCircle,
  Play,
  Terminal,
  Trash2,
} from '../components/Icons';

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
  const [customCommand, setCustomCommand] = useState('');
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [outputLogs, setOutputLogs] = useState<
    Array<{
      id: string;
      command: string;
      exitCode: number;
      durationMs: number;
      stdout: string;
      stderr: string;
      timestamp: string;
    }>
  >([]);
  const [copiedLogId, setCopiedLogId] = useState<string | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  const stack = inspection?.techStack ?? [];
  const scripts = inspection?.scripts ?? [];

  const runCommand = async (cmd: string) => {
    if (!project || running) return;
    const trimmed = cmd.trim();
    if (!trimmed) return;

    setRunning(true);
    setActiveCommand(trimmed);
    try {
      const result = await executeProjectScript(project.id, trimmed);
      const newLog = {
        id: Math.random().toString(36).slice(2, 9),
        command: trimmed,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        timestamp: new Date().toLocaleTimeString(),
      };
      setOutputLogs(prev => [newLog, ...prev]);
      onNotify?.(
        result.exitCode === 0
          ? `命令「${trimmed}」执行成功 (${result.durationMs}ms)`
          : `命令「${trimmed}」执行退出 (退出码 ${result.exitCode})`,
      );
    } catch (e) {
      const errorLog = {
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
    onNotify?.('已清空终端控制台');
  };

  return (
    <div className="feature-panel-layout" aria-labelledby="dev-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <Terminal size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="dev-title">Tongyun Dev · 服务与终端</h2>
            <p>在当前项目工作区内原生执行脚本、构建命令与服务进程，实时查看控制台输出。</p>
          </div>
        </div>
        <div className="workbench-badges">
          <span className="badge-matcha">原生内嵌控制台</span>
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
          {/* Tech stack tags */}
          {stack.length > 0 && (
            <div className="tech-badge-list">
              <span className="tech-badge-label">
                <Cpu size={13} /> 技术栈：
              </span>
              {stack.map(tech => (
                <span key={tech} className="tech-badge">
                  {tech}
                </span>
              ))}
            </div>
          )}

          {/* Quick scripts row */}
          <section className="panel-subcard">
            <div className="section-heading">
              <div className="subcard-title">
                <Play size={15} className="title-icon" />
                <h3>项目快捷命令</h3>
              </div>
              <span className="meta">{scripts.length ? `${scripts.length} 个可用脚本` : '未检测到 package 脚本'}</span>
            </div>

            {scripts.length > 0 ? (
              <div className="script-grid">
                {scripts.map(s => (
                  <div key={s.name} className="script-run-card">
                    <div className="script-run-info">
                      <span className="script-run-name">{s.name}</span>
                      <code className="script-run-cmd" title={s.command}>
                        {s.command}
                      </code>
                    </div>
                    <button
                      className="primary-button-sm"
                      onClick={() => void runCommand(s.command)}
                      disabled={running}
                      title={`运行 ${s.command}`}
                    >
                      {running && activeCommand === s.command ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : (
                        <Play size={13} />
                      )}
                      <span>{running && activeCommand === s.command ? '执行中…' : '运行'}</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="subcard-empty">
                未在项目根目录找到标准 package.json scripts。你可以使用下方的自定义命令输入框执行任意 shell 命令。
              </p>
            )}

            {/* Custom command runner */}
            <form onSubmit={handleCustomSubmit} className="command-input-row">
              <span className="prompt-symbol">$</span>
              <input
                className="command-input"
                placeholder="输入任意要执行的项目命令，如 npm test, cargo check, ls -la…"
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
                  <span className="terminal-prompt-hint">$ 准备就绪。点击上方「运行」或输入自定义命令启动服务与任务。</span>
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

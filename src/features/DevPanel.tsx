import { useState } from 'react';
import type { Project, ProjectInspection, ToolStatus } from '../contracts';
import ToolPanel from './ToolPanel';
import { Check, Copy, Cpu, Layers, Terminal } from '../components/Icons';

export default function DevPanel({
  project,
  inspection,
  status,
  loading,
  error,
  onRefresh,
  onNotify,
}: {
  project: Project | null;
  inspection?: ProjectInspection | null;
  status?: ToolStatus;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onNotify?: (msg: string) => void;
}) {
  const [copiedScript, setCopiedScript] = useState<string | null>(null);

  const copyCommand = (cmd: string, name: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedScript(name);
    onNotify?.(`已复制命令：${cmd}`);
    setTimeout(() => setCopiedScript(null), 2000);
  };

  const stack = inspection?.techStack ?? [];
  const scripts = inspection?.scripts ?? [];

  return (
    <div className="feature-panel-layout">
      {project && (
        <section className="panel-subcard">
          <div className="section-heading">
            <div className="subcard-title">
              <Layers size={16} className="title-icon" />
              <h3>技术栈与运行时</h3>
            </div>
            <span className="meta">{stack.length ? `已识别 ${stack.length} 项` : '分析中'}</span>
          </div>
          {stack.length ? (
            <div className="tech-badge-list">
              {stack.map(tech => (
                <span key={tech} className="tech-badge">
                  <Cpu size={13} />
                  {tech}
                </span>
              ))}
            </div>
          ) : (
            <p className="subcard-empty">未在根目录检测到标准技术栈标记文件（package.json / Cargo.toml 等）。</p>
          )}
        </section>
      )}

      {project && (
        <section className="panel-subcard">
          <div className="section-heading">
            <div className="subcard-title">
              <Terminal size={16} className="title-icon" />
              <h3>项目脚本与命令</h3>
            </div>
            <span className="meta">{scripts.length ? `${scripts.length} 个快捷命令` : '无脚本'}</span>
          </div>
          {scripts.length ? (
            <div className="script-list">
              {scripts.map(s => (
                <div key={s.name} className="script-item">
                  <div className="script-meta">
                    <span className="script-name">{s.name}</span>
                    <code className="script-cmd" title={s.command}>{s.command}</code>
                  </div>
                  <button
                    className="icon-button"
                    title="复制运行命令"
                    onClick={() => copyCommand(s.command, s.name)}
                    aria-label={`复制 ${s.name} 命令`}
                  >
                    {copiedScript === s.name ? <Check size={14} className="accent-color" /> : <Copy size={14} />}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="subcard-empty">该项目未配置快捷启动脚本。</p>
          )}
        </section>
      )}

      <ToolPanel
        toolId="dev"
        project={project}
        status={status}
        loading={loading}
        error={error}
        onRefresh={onRefresh}
      />
    </div>
  );
}

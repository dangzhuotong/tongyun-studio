import { useState } from 'react';
import type { AiProjectContext } from '../contracts';
import { Bot, Check, Copy, Sparkles, X } from './Icons';

export default function AiContextModal({
  context,
  onClose,
  onNotify,
}: {
  context: AiProjectContext;
  onClose: () => void;
  onNotify?: (msg: string) => void;
}) {
  const [copiedType, setCopiedType] = useState<string | null>(null);

  const copyText = (type: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedType(type);
    onNotify?.('已复制 AI 上下文报告');
    setTimeout(() => setCopiedType(null), 2000);
  };

  const generateAgentPrompt = () => {
    return `你是一位资深架构师和全栈专家，现在正协助我开发项目 ${context.projectName}。\n以下是当前工作区的最新状态与运行时上下文：\n\n${context.markdown}\n\n请先理解上述项目上下文。接下来我将向你提供具体的开发或调试任务，请给出严谨、生产级的代码实现方案。`;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-dialog ai-context-dialog"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-labelledby="ai-modal-title"
      >
        <div className="modal-header">
          <div className="ai-modal-title-group">
            <div className="ai-emblem">
              <Sparkles size={16} />
            </div>
            <div>
              <h2 id="ai-modal-title">AI 上下文报告与 Agent 协同</h2>
              <span className="meta">企业级项目全景画像 · 专为大模型与 AI Agent 注入结构化现场</span>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body ai-context-body">
          <div className="ai-prompt-shortcuts">
            <button
              className="ai-shortcut-card"
              onClick={() => copyText('context', context.markdown)}
            >
              <div className="ai-card-top">
                <Copy size={14} className="accent-color" />
                <span>复制全景上下文</span>
              </div>
              <p>提炼包含分支、差异、端口、数据表与脚本的完整 Markdown 现场。</p>
            </button>

            <button
              className="ai-shortcut-card"
              onClick={() => copyText('prompt', generateAgentPrompt())}
            >
              <div className="ai-card-top">
                <Bot size={14} className="accent-color" />
                <span>生成 Agent 初始化 Prompt</span>
              </div>
              <p>注入预设角色和项目现场，一键发给 Claude/Cursor/DeepSeek。</p>
            </button>
          </div>

          <div className="ai-preview-header">
            <span>实时上下文预览：</span>
            <button
              className="terminal-btn"
              onClick={() => copyText('preview', context.markdown)}
            >
              {copiedType ? <Check size={12} /> : <Copy size={12} />}
              {copiedType ? '已复制到剪贴板' : '复制全文'}
            </button>
          </div>

          <div className="ai-markdown-preview">
            <pre className="ai-code-view">
              <code>{context.markdown}</code>
            </pre>
          </div>
        </div>

        <div className="modal-actions ai-modal-actions">
          <button className="secondary-button" onClick={onClose}>
            关闭
          </button>
          <button
            className="primary-button"
            onClick={() => copyText('all', generateAgentPrompt())}
          >
            <Sparkles size={14} />
            复制并协同 AI
          </button>
        </div>
      </div>
    </div>
  );
}

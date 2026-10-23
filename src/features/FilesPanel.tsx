import { useEffect, useState } from 'react';
import type { Project, FileEntry } from '../contracts';
import { readProjectTree, readProjectFileContent, openProjectFile, isDesktop } from '../bridge';
import {
  Check,
  Copy,
  ExternalLink,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
} from '../components/Icons';

export default function FilesPanel({
  project,
  onNotify,
}: {
  project: Project | null;
  onRefresh?: () => void;
  onNotify?: (msg: string) => void;
}) {
  const [currentDir, setCurrentDir] = useState<string>('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [copiedFile, setCopiedFile] = useState(false);

  const loadTree = async (dir?: string) => {
    if (!project) return;
    setLoadingTree(true);
    try {
      const list = await readProjectTree(project.id, dir || undefined);
      setEntries(list);
      setCurrentDir(dir || '');
    } catch (e) {
      onNotify?.(`读取目录树失败：${e}`);
    } finally {
      setLoadingTree(false);
    }
  };

  useEffect(() => {
    if (project) {
      setSelectedFile(null);
      setFileContent('');
      void loadTree('');
    }
  }, [project?.id]);

  const handleEntryClick = (entry: FileEntry) => {
    if (entry.isDir) {
      void loadTree(entry.path);
    } else {
      setSelectedFile(entry);
      void loadContent(entry.path);
    }
  };

  const loadContent = async (filePath: string) => {
    if (!project) return;
    setLoadingContent(true);
    try {
      const text = await readProjectFileContent(project.id, filePath);
      setFileContent(text);
    } catch (e) {
      setFileContent(`无法预览文件内容：${e}`);
    } finally {
      setLoadingContent(false);
    }
  };

  const copyContent = () => {
    navigator.clipboard.writeText(fileContent);
    setCopiedFile(true);
    onNotify?.('已复制文件内容');
    setTimeout(() => setCopiedFile(false), 2000);
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="feature-panel-layout" aria-labelledby="files-title">
      <div className="workbench-header">
        <div className="workbench-title-group">
          <div className="large-tool-icon">
            <FolderOpen size={22} strokeWidth={1.5} />
          </div>
          <div>
            <h2 id="files-title">Tongyun Files · 项目文件与源码</h2>
            <p>浏览项目目录结构，快速预览配置文件、源代码与文本文件内容。</p>
          </div>
        </div>
        <div className="workbench-badges">
          <span className="badge-matcha">原生文件浏览</span>
          {project && <span className="mono-subtle">{project.name}</span>}
        </div>
      </div>

      {!project ? (
        <div className="panel-empty-placeholder">
          <Folder size={32} strokeWidth={1.2} />
          <p>请先在左侧选择或添加一个项目，以浏览其内部文件。</p>
        </div>
      ) : (
        <div className="files-workbench-split">
          {/* Left Column: Directory Explorer */}
          <div className="files-tree-pane">
            <div className="pane-header">
              <div className="tree-nav-bar">
                {currentDir ? (
                  <button
                    className="text-button-xs"
                    onClick={() => {
                      const parent = currentDir.includes('/')
                        ? currentDir.slice(0, currentDir.lastIndexOf('/'))
                        : '';
                      void loadTree(parent);
                    }}
                  >
                    ← 返回上一级
                  </button>
                ) : (
                  <span>根目录</span>
                )}
                {currentDir && <span className="current-dir-label">/{currentDir}</span>}
              </div>
              <button
                className="icon-button-sm"
                onClick={() => void loadTree(currentDir)}
                title="刷新目录"
              >
                <RefreshCw size={12} className={loadingTree ? 'spin' : ''} />
              </button>
            </div>

            <div className="files-tree-list">
              {loadingTree ? (
                <div className="tree-loading">
                  <LoaderCircle size={14} className="spin" />
                  <span>读取中…</span>
                </div>
              ) : entries.length === 0 ? (
                <div className="tree-empty">
                  <span>(空目录)</span>
                </div>
              ) : (
                entries.map(item => (
                  <div
                    key={item.path}
                    className={`file-tree-row ${selectedFile?.path === item.path ? 'selected' : ''}`}
                    onClick={() => handleEntryClick(item)}
                  >
                    {item.isDir ? (
                      <Folder size={15} className="folder-icon" />
                    ) : (
                      <FileText size={15} className="file-icon" />
                    )}
                    <span className="file-entry-name">{item.name}</span>
                    {!item.isDir && (
                      <span className="file-entry-size">{formatSize(item.sizeBytes)}</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right Column: File Content Previewer */}
          <div className="files-content-pane">
            {selectedFile ? (
              <div className="file-preview-card">
                <div className="file-preview-header">
                  <div className="file-header-info">
                    <FileCode size={15} />
                    <span className="file-header-path">{selectedFile.path}</span>
                    <span className="meta">{formatSize(selectedFile.sizeBytes)}</span>
                  </div>
                  <div className="file-header-actions">
                    <button
                      className="terminal-btn"
                      onClick={copyContent}
                      title="复制文件内容"
                    >
                      {copiedFile ? <Check size={12} /> : <Copy size={12} />}
                      复制
                    </button>
                    {isDesktop && (
                      <button
                        className="terminal-btn"
                        onClick={() => void openProjectFile(project.id, selectedFile.path)}
                        title="在系统默认编辑器中打开"
                      >
                        <ExternalLink size={12} />
                        打开
                      </button>
                    )}
                  </div>
                </div>

                <div className="file-code-container">
                  {loadingContent ? (
                    <div className="content-loading">
                      <LoaderCircle size={16} className="spin" />
                      <span>正在加载文件内容…</span>
                    </div>
                  ) : (
                    <pre className="file-code-block">
                      <code>{fileContent}</code>
                    </pre>
                  )}
                </div>
              </div>
            ) : (
              <div className="files-empty-preview">
                <FileCode size={32} strokeWidth={1.2} />
                <p>在左侧选择一个文件以预览其内容</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

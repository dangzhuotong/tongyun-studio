import { useEffect, useRef, useState } from 'react';
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
  const [treeError, setTreeError] = useState<{ message: string; dir?: string } | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const treeRequest = useRef(0);
  const contentRequest = useRef(0);

  const loadTree = async (dir?: string) => {
    if (!project) return;
    const request = ++treeRequest.current;
    setTreeError(null);
    setLoadingTree(true);
    try {
      const list = await readProjectTree(project.id, dir || undefined);
      if (request !== treeRequest.current) return;
      setEntries(list);
      setCurrentDir(dir || '');
    } catch (e) {
      if (request === treeRequest.current) setTreeError({ message: String(e), dir });
    } finally {
      if (request === treeRequest.current) setLoadingTree(false);
    }
  };

  useEffect(() => {
    if (project) {
      setSelectedFile(null);
      setFileContent('');
      void loadTree('');
    }
    return () => { treeRequest.current++; contentRequest.current++; };
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
    const request = ++contentRequest.current;
    setContentError(null);
    setCopiedFile(false);
    setLoadingContent(true);
    try {
      const text = await readProjectFileContent(project.id, filePath);
      if (request === contentRequest.current) setFileContent(text);
    } catch (e) {
      if (request === contentRequest.current) setContentError(String(e));
    } finally {
      if (request === contentRequest.current) setLoadingContent(false);
    }
  };

  const copyContent = async () => {
    const request = contentRequest.current;
    try {
      await navigator.clipboard.writeText(fileContent);
      if (request !== contentRequest.current) return;
      setCopiedFile(true);
      onNotify?.('已复制文件内容');
      setTimeout(() => {
        if (request === contentRequest.current) setCopiedFile(false);
      }, 2000);
    } catch (error) {
      onNotify?.(`复制失败：${error}`);
    }
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
          <h2 id="files-title">文件</h2>
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

            {treeError && <div className="files-tree-error" role="alert">
              <span>读取目录失败：{treeError.message}</span>
              <button className="text-button" onClick={() => void loadTree(treeError.dir)}>重试</button>
            </div>}
            <div className="files-tree-list">
              {loadingTree ? (
                <div className="tree-loading">
                  <LoaderCircle size={14} className="spin" />
                  <span>读取中…</span>
                </div>
              ) : entries.length === 0 && !treeError ? (
                <div className="tree-empty">
                  <span>(空目录)</span>
                </div>
              ) : (
                entries.map(item => (
                  <button
                    type="button"
                    key={item.path}
                    className={`file-tree-row ${selectedFile?.path === item.path ? 'selected' : ''}`}
                    onClick={() => handleEntryClick(item)}
                    title={item.path}
                    aria-pressed={item.isDir ? undefined : selectedFile?.path === item.path}
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
                  </button>
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
                    <span className="file-header-path" title={selectedFile.path}>{selectedFile.path}</span>
                    <span className="meta">{formatSize(selectedFile.sizeBytes)}</span>
                  </div>
                  <div className="file-header-actions">
                    <button
                      className="terminal-btn"
                      onClick={() => void copyContent()}
                      disabled={loadingContent || !!contentError}
                      title="复制文件内容"
                    >
                      {copiedFile ? <Check size={12} /> : <Copy size={12} />}
                      {copiedFile ? '已复制' : '复制'}
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
                  ) : contentError ? (
                    <div className="files-tree-error" role="alert">
                      <span>读取文件失败：{contentError}</span>
                      <button className="text-button" onClick={() => void loadContent(selectedFile.path)}>重试</button>
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

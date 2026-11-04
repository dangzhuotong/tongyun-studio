import React, { useState, useEffect, useCallback } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';
import {
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  isDesktopEnvironment,
  type UpdateProgress,
} from '../utils/updater';
import {
  RefreshCw,
  DownloadCloud,
  CheckCircle2,
  AlertCircle,
  X,
  LoaderCircle,
} from './Icons';

export interface UpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentVersion: string;
  // Optional mock injection for unit testing
  mockCheck?: () => Promise<Update | null>;
  mockInstall?: (update: Update, onProgress?: (p: UpdateProgress) => void) => Promise<void>;
}

type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'restarting' | 'error';

export const UpdateModal: React.FC<UpdateModalProps> = ({
  isOpen,
  onClose,
  currentVersion,
  mockCheck,
  mockInstall,
}) => {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const startCheck = useCallback(async () => {
    setStatus('checking');
    setErrorMessage(null);
    setUpdate(null);
    setProgress(null);

    try {
      const checkFn = mockCheck || checkForAppUpdate;
      const result = await checkFn();

      if (!result) {
        setStatus('up-to-date');
      } else {
        setUpdate(result);
        setStatus('available');
      }
    } catch (err: unknown) {
      console.error('[UpdateModal] Check failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg || '无法连接到更新服务器，请检查网络连接');
      setStatus('error');
    }
  }, [mockCheck]);

  useEffect(() => {
    if (isOpen) {
      startCheck();
    } else {
      setStatus('idle');
      setUpdate(null);
      setProgress(null);
      setErrorMessage(null);
    }
  }, [isOpen, startCheck]);

  const handleStartUpdate = async () => {
    if (!update) return;

    setStatus('downloading');
    setErrorMessage(null);

    try {
      const installFn = mockInstall || downloadAndInstallAppUpdate;
      await installFn(update, (p) => {
        setProgress(p);
        if (p.event === 'Finished') {
          setStatus('restarting');
        }
      });
    } catch (err: unknown) {
      console.error('[UpdateModal] Download & Install failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg || '下载或应用更新失败');
      setStatus('error');
    }
  };

  if (!isOpen) return null;

  const isDesktop = isDesktopEnvironment();

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="update-modal-title">
      <div className="modal-dialog update-modal-dialog">
        <div className="modal-header">
          <div className="modal-title-with-icon">
            <RefreshCw size={16} className={status === 'checking' ? 'icon-spin' : ''} />
            <h2 id="update-modal-title">检查应用更新</h2>
          </div>
          <button
            type="button"
            className="icon-btn close-btn"
            onClick={onClose}
            aria-label="关闭"
            disabled={status === 'downloading' || status === 'restarting'}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body update-modal-body">
          <div className="update-version-summary">
            <span className="current-version-label">当前版本：</span>
            <span className="current-version-value">v{currentVersion}</span>
            {!isDesktop && (
              <span className="update-env-tag">演示环境（仅桌面版支持真实热更）</span>
            )}
          </div>

          {status === 'checking' && (
            <div className="update-state-box update-state-checking">
              <LoaderCircle size={28} className="icon-spin text-primary" />
              <p>正在检查最新版本元数据与更新签名...</p>
              <span className="update-hint">正在请求 GitHub Releases latest.json</span>
            </div>
          )}

          {status === 'up-to-date' && (
            <div className="update-state-box update-state-success">
              <CheckCircle2 size={32} className="text-success" />
              <p className="update-title">当前已是最新版本</p>
              <span className="update-hint">工作台已处于最新发布版本 (v{currentVersion})，无需更新。</span>
            </div>
          )}

          {status === 'available' && update && (
            <div className="update-state-box update-state-available">
              <div className="available-header">
                <DownloadCloud size={28} className="text-accent" />
                <div>
                  <p className="available-title">发现新版本 v{update.version}</p>
                  {update.date && <span className="available-date">发布时间：{update.date}</span>}
                </div>
              </div>

              {update.body && (
                <div className="release-notes-container">
                  <div className="release-notes-label">更新日志：</div>
                  <pre className="release-notes-body">{update.body}</pre>
                </div>
              )}
            </div>
          )}

          {status === 'downloading' && (
            <div className="update-state-box update-state-downloading">
              <LoaderCircle size={28} className="icon-spin text-primary" />
              <p className="update-title">正在下载更新安装包...</p>
              <div className="update-progress-bar-container">
                <div
                  className="update-progress-bar"
                  style={{ width: `${progress?.percent ?? 0}%` }}
                />
              </div>
              <div className="update-progress-meta">
                <span>{progress?.percent != null ? `${progress.percent}%` : '下载中...'}</span>
                {progress?.contentLength && (
                  <span>
                    已传输 {Math.round(((progress.chunkLength || 0) / 1024 / 1024) * 10) / 10} MB /{' '}
                    {Math.round((progress.contentLength / 1024 / 1024) * 10) / 10} MB
                  </span>
                )}
              </div>
            </div>
          )}

          {status === 'restarting' && (
            <div className="update-state-box update-state-restarting">
              <CheckCircle2 size={32} className="text-success" />
              <p className="update-title">更新已就绪</p>
              <span className="update-hint">正在重启应用以生效新版本，请稍候...</span>
            </div>
          )}

          {status === 'error' && (
            <div className="update-state-box update-state-error">
              <AlertCircle size={32} className="text-danger" />
              <p className="update-title">检查或更新失败</p>
              <span className="form-error update-error-text">{errorMessage}</span>
            </div>
          )}
        </div>

        <div className="modal-actions">
          {status === 'available' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleStartUpdate}
            >
              <DownloadCloud size={14} />
              立即下载并更新
            </button>
          )}

          {status === 'error' && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={startCheck}
            >
              <RefreshCw size={14} />
              重试检查
            </button>
          )}

          {status === 'up-to-date' && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={startCheck}
            >
              <RefreshCw size={14} />
              再次检查
            </button>
          )}

          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={status === 'downloading' || status === 'restarting'}
          >
            {status === 'available' ? '稍后提醒' : '关闭'}
          </button>
        </div>
      </div>
    </div>
  );
};

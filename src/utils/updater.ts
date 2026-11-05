import { isTauri } from '@tauri-apps/api/core';
import type { Update } from '@tauri-apps/plugin-updater';

export const isDesktopEnvironment = () => isTauri();

export interface UpdateProgress {
  event: 'Started' | 'Progress' | 'Finished';
  chunkLength?: number;
  contentLength?: number;
  percent?: number;
}

/**
 * Checks for application updates via Tauri 2 updater plugin.
 * Returns the Update object if a new version is available, or null if up-to-date or not in Tauri.
 */
export async function checkForAppUpdate(): Promise<Update | null> {
  if (!isDesktopEnvironment()) {
    return null;
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    return update;
  } catch (err) {
    console.error('[Updater] Check error:', err);
    throw err;
  }
}

/**
 * Downloads and installs the given Update, emitting progress events.
 * Automatically attempts to relaunch the application on completion.
 */
export async function downloadAndInstallAppUpdate(
  update: Update,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  let downloadedBytes = 0;
  let totalBytes = 0;

  await update.downloadAndInstall((event) => {
    if (!onProgress) return;

    if (event.event === 'Started') {
      totalBytes = event.data.contentLength || 0;
      onProgress({
        event: 'Started',
        contentLength: totalBytes,
        percent: 0,
      });
    } else if (event.event === 'Progress') {
      downloadedBytes += event.data.chunkLength || 0;
      const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : undefined;
      onProgress({
        event: 'Progress',
        chunkLength: event.data.chunkLength,
        contentLength: totalBytes,
        percent,
      });
    } else if (event.event === 'Finished') {
      onProgress({
        event: 'Finished',
        percent: 100,
      });
    }
  });

  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (err) {
    console.warn('[Updater] Relaunch notice (app may exit automatically):', err);
  }
}

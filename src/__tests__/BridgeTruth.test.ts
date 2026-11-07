import { describe, it, expect } from 'vitest';
import * as bridge from '../bridge';
describe('browser preview never invents local results', () => {
  it('has an empty workspace and refuses every local action', async () => {
    expect(bridge.isDesktop).toBe(false);
    expect((await bridge.loadWorkspace()).projects).toEqual([]);
    const calls = [
      () => bridge.inspectProject('p'), () => bridge.readProjectTree('p'),
      () => bridge.readProjectFileContent('p', 'file'), () => bridge.getGitChangedFiles('p'),
      () => bridge.getGitDiff('p'), () => bridge.createGitCommit('p', 'message'),
      () => bridge.getGitHistory('p', 0, 50, false), () => bridge.getGitCommitDetails('p', 'abcdef0123'),
      () => bridge.getGitCommitFileDiff('p', 'abcdef0123', 'file.ts'),
      () => bridge.gitCommitAmend('p'), () => bridge.gitStageFile('p', 'file'),
      () => bridge.gitUnstageFile('p', 'file'), () => bridge.gitStageAll('p'),
      () => bridge.gitUnstageAll('p'), () => bridge.gitDiscardFile('p', 'file'),
      () => bridge.gitCreateBranch('p', 'new'), () => bridge.gitRemoteSync('p', 'push'),
      () => bridge.getGitBranches('p'), () => bridge.switchGitBranch('p', 'main'),
      () => bridge.gitStashList('p'), () => bridge.gitStashPush('p', 'note', true),
      () => bridge.gitStashApply('p', 0), () => bridge.gitStashPop('p', 0), () => bridge.gitStashDrop('p', 0),
      () => bridge.executeProjectScript('p', 'command'),
      () => bridge.sendHttpRequest('GET', 'https://example.invalid', []),
      () => bridge.executeSqlQuery('p', 'db', 'SELECT 1'), () => bridge.getDbTables('p', 'db'),
      () => bridge.getTableColumns('p', 'db', 'table'), () => bridge.getTableData('p', 'db', 'table', 1, 10),
      () => bridge.detectListeningPorts(), () => bridge.generateAiProjectContext('p'),
      () => bridge.writeProjectFile('p', 'file', 'content'), () => bridge.appendProjectFile('p', 'file', 'content'),
      () => bridge.startProjectService('p', 'command'), () => bridge.listProjectServices('p'),
      () => bridge.stopProjectService('p', 's'), () => bridge.restartProjectService('p', 's'),
      () => bridge.scanDevDirectory('/tmp/synthetic', 2), () => bridge.importDevCandidates([]),
      () => bridge.readTongyunDevRegistry(),
      () => bridge.startDevGroup('demo'), () => bridge.stopDevGroup('demo'),
      () => bridge.devServiceLogTail('p', 's', 20),
      () => bridge.devProjectLogTail('p', 20),
      () => bridge.openUrl('http://localhost:1234'),
      () => bridge.listDbConnections(), () => bridge.deleteDbConnection('c'),
      () => bridge.testDbConnection('c'), () => bridge.connectionTables('c'),
      () => bridge.connectionColumns('c', 'table'), () => bridge.connectionRedisKeys('c', 'user*'),
      () => bridge.runConnectionQuery('c', 'SELECT 1'),
      () => bridge.saveDbConnection({
        id: '', name: 'synthetic', engine: null, host: '', port: null, user: '',
        password: null, database: '', tls: false, readOnly: true, revision: null,
      }),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow('桌面版');
  });
});

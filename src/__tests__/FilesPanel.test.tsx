import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { readProjectFileContent } from '../bridge';
import FilesPanel from '../features/FilesPanel';

vi.mock('../bridge', () => ({
  isDesktop: true,
  openProjectFile: vi.fn(),
  readProjectTree: vi.fn(async () => ['one.txt', 'two.txt'].map(name => ({
    name, path: name, isDir: false, sizeBytes: 10, modified: '',
  }))),
  readProjectFileContent: vi.fn(),
}));

it('keeps the newest file selected when an older read finishes later', async () => {
  let finishOldRead!: (content: string) => void;
  vi.mocked(readProjectFileContent)
    .mockImplementationOnce(() => new Promise(resolve => { finishOldRead = resolve; }))
    .mockResolvedValueOnce('Current file content');

  render(<FilesPanel project={{ id: 'files', name: 'Files', path: '/fixture/files', createdAt: '' }} />);
  fireEvent.click(await screen.findByRole('button', { name: /one\.txt/ }));
  expect(screen.getByRole('button', { name: '复制' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: /two\.txt/ }));
  expect(await screen.findByText('Current file content')).toBeInTheDocument();
  await act(async () => finishOldRead('Outdated file content'));
  expect(screen.queryByText('Outdated file content')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /two\.txt/ })).toHaveAttribute('aria-pressed', 'true');
});

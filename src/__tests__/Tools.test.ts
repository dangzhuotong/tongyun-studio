import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import type { ToolId } from '../contracts';
import { getTool, toolDefinitions } from '../features/tools';

const nativeToolIds = ['dev', 'api', 'database', 'git'] as const;

describe('toolDefinitions', () => {
  it('describes exactly the native tool cards, in navigation order', () => {
    expect(toolDefinitions.map(tool => tool.id)).toEqual([...nativeToolIds]);
  });

  it('carries non-empty copy for every card', () => {
    for (const tool of toolDefinitions) {
      for (const field of ['label', 'name', 'short', 'description', 'hint'] as const) {
        expect(tool[field].trim(), `${tool.id}.${field}`).not.toBe('');
      }
      expect(tool.details.length, tool.id).toBeGreaterThan(0);
      for (const detail of tool.details) expect(detail.trim(), tool.id).not.toBe('');
    }
  });

  it('keeps labels and product names unambiguous', () => {
    expect(new Set(toolDefinitions.map(tool => tool.label)).size).toBe(toolDefinitions.length);
    expect(new Set(toolDefinitions.map(tool => tool.name)).size).toBe(toolDefinitions.length);
  });

  it('renders an icon for every card', () => {
    for (const tool of toolDefinitions) {
      const { container } = render(createElement(tool.Icon));
      expect(container.querySelector('svg'), tool.id).not.toBeNull();
    }
  });
});

describe('getTool', () => {
  it.each(nativeToolIds)('resolves %s to its own definition', id => {
    expect(getTool(id).id).toBe(id);
  });

  it('returns the shared definition object instead of a copy', () => {
    expect(getTool('dev')).toBe(toolDefinitions.find(tool => tool.id === 'dev'));
  });

  it('resolves to undefined for the files tab, which is no native tool card', () => {
    expect(getTool('files' as ToolId)).toBeUndefined();
  });

  it('resolves to undefined for an id outside the union', () => {
    expect(getTool('nope' as unknown as ToolId)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import * as icons from '../components/Icons';
import { toolDefinitions } from '../features/tools';

const sharedIcons = Object.entries(icons);

describe('the shared icon re-exports', () => {
  it.each(sharedIcons)('%s stays a real icon component', (_name, icon) => {
    expect(icon).toBeDefined();
    expect(['function', 'object']).toContain(typeof icon);
  });

  it('renders every re-exported icon instead of leaving a hole in the toolbar', () => {
    for (const [name, icon] of sharedIcons) {
      const { container } = render(createElement(icon as never));
      expect(container.querySelector('svg'), name).not.toBeNull();
    }
  });

  it('covers the icons the native tool cards ask for', () => {
    const exported = new Set(sharedIcons.map(([, icon]) => icon));
    for (const tool of toolDefinitions) {
      expect(exported.has(tool.Icon), tool.id).toBe(true);
    }
  });

  it('keeps the sidebar toggle pair visually distinct', () => {
    expect(icons.PanelLeftOpen).not.toBe(icons.PanelLeftClose);
    expect(icons.PanelRightOpen).not.toBe(icons.PanelRightClose);
  });

  it('maps the Open aliases onto the plain panel glyphs', () => {
    // The module exports `PanelLeft as PanelLeftOpen`, so the sidebar expand button
    // shows the un-arrowed panel icon rather than lucide's own PanelLeftOpen.
    expect(icons.PanelLeftOpen).toBe(icons.PanelLeft);
    expect(icons.PanelRightOpen).toBe(icons.PanelRight);
  });
});

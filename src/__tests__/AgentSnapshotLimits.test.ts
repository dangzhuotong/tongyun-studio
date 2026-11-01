import { describe, expect, it } from 'vitest';
import { parseAgentSnapshot } from '../agent-session';

const action = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  kind: 'terminal',
  title: 'npm run check',
  detail: 'all suites passed',
  status: 'done',
  timestamp: '2026-11-01T09:00:00Z',
  ...overrides,
});

const plan = (overrides: Record<string, unknown> = {}) => ({
  id: 'plan-1',
  goal: 'backfill vitest coverage',
  status: 'executing',
  steps: [{ id: 's1', text: 'write tests', status: 'done' }],
  ...overrides,
});

const snapshotOf = (value: unknown) => parseAgentSnapshot(JSON.stringify(value), 'p');

const rejected: [string, Record<string, unknown>][] = [
  ['a fractional token count', { tokensConsumed: 1.5 }],
  ['a count above Number.MAX_SAFE_INTEGER', { filesTouched: 2 ** 53 }],
  ['an unknown operating mode', { mode: 'supervised' }],
  ['a numeric operating mode', { mode: 1 }],
  ['an action without a kind', { actions: [action({ kind: undefined })] }],
  ['an action with a non-text detail', { actions: [action({ detail: 7 })] }],
  ['an action with an unknown status', { actions: [action({ status: 'cancelled' })] }],
  ['a plan without a goal', { plan: plan({ goal: undefined }) }],
  ['a plan without steps', { plan: plan({ steps: undefined }) }],
  ['a plan with an unknown status', { plan: plan({ status: 'aborted' }) }],
  ['a plan step with an unknown status', { plan: plan({ steps: [{ id: 's1', text: 'x', status: 'archived' }] }) }],
  ['a plan progress above 100', { plan: plan({ progressPercent: 100.1 }) }],
  ['a plan progress below zero', { plan: plan({ progressPercent: -0.5 }) }],
];

describe('agent snapshot validation limits', () => {
  it.each(rejected)('rejects %s', (_label, value) => {
    expect(() => snapshotOf(value)).toThrow();
  });

  it('accepts zero counters instead of erasing them', () => {
    const session = snapshotOf({ tokensConsumed: 0, filesTouched: 0 });
    expect(session.tokensConsumed).toBe(0);
    expect(session.filesTouched).toBe(0);
  });

  it('accepts the ends of the progress range and an omitted progress', () => {
    expect(snapshotOf({ plan: plan({ progressPercent: 0 }) }).plan?.progressPercent).toBe(0);
    expect(snapshotOf({ plan: plan({ progressPercent: 100 }) }).plan?.progressPercent).toBe(100);
    expect(snapshotOf({ plan: plan({ progressPercent: undefined }) }).plan?.progressPercent).toBeUndefined();
    expect(snapshotOf({ plan: plan({ progressPercent: null }) }).plan?.progressPercent).toBeNull();
  });

  it('caps recorded actions and plan steps at 1000 entries', () => {
    const actions = Array.from({ length: 1000 }, (_, index) => action({ id: `a${index}` }));
    expect(snapshotOf({ actions }).actions).toHaveLength(1000);
    expect(() => snapshotOf({ actions: [...actions, action({ id: 'a1001' })] })).toThrow();

    const steps = Array.from({ length: 1000 }, (_, index) => ({ id: `s${index}`, text: `step ${index}`, status: 'todo' }));
    expect(snapshotOf({ plan: plan({ steps }) }).plan?.steps).toHaveLength(1000);
    expect(() => snapshotOf({ plan: plan({ steps: [...steps, { id: 's1001', text: 'overflow', status: 'todo' }] }) })).toThrow();
  });

  it('passes through the optional action fields the cockpit reads', () => {
    const [step] = snapshotOf({ actions: [action({ target: 'src/App.tsx', exitCode: 0, durationMs: 12, outputPreview: 'ok' })] }).actions;
    expect(step).toMatchObject({ target: 'src/App.tsx', exitCode: 0, durationMs: 12, outputPreview: 'ok' });
  });

  it('prefers agentName over the legacy agent field', () => {
    expect(snapshotOf({ agentName: 'Qoder', agent: 'Cursor' }).agentName).toBe('Qoder');
    expect(snapshotOf({ agent: 'Cursor' }).agentName).toBe('Cursor');
  });

  it('falls back to the plan goal only when no active goal is recorded', () => {
    expect(snapshotOf({ plan: plan() }).activeGoal).toBe('backfill vitest coverage');
    expect(snapshotOf({ activeGoal: 'review PR 12', plan: plan() }).activeGoal).toBe('review PR 12');
  });

  it('treats a missing or null snapshot projectId as project-agnostic', () => {
    expect(snapshotOf({ agentName: 'Qoder' }).agentName).toBe('Qoder');
    expect(snapshotOf({ projectId: null, agentName: 'Qoder' }).agentName).toBe('Qoder');
  });

  it('binds a matching snapshot to the selected project', () => {
    const session = snapshotOf({ projectId: 'p', mode: 'observer' });
    expect(session.projectId).toBe('p');
    expect(session.mode).toBe('observer');
    expect(session.connectionStatus).toBe('connected');
  });
});

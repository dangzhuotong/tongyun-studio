import { describe, it, expect } from 'vitest';
import { parseAgentSnapshot } from '../agent-session';
describe('untrusted local Agent snapshots', () => {
  it('does not invent identity, heartbeat or activity for an empty snapshot', () => {
    const session = parseAgentSnapshot('{}', 'p');
    expect(session.agentName).toBeNull();
    expect(session.model).toBeNull();
    expect(session.lastHeartbeat).toBeNull();
    expect(session.tokensConsumed).toBeNull();
    expect(session.plan).toBeNull();
    expect(session.actions).toEqual([]);
  });
  it.each([
    '[]', 'null', '{', '{"projectId":"another"}', '{"plan":{}}',
    '{"plan":{"id":"x","goal":"g","status":"executing","steps":{},"progressPercent":50}}',
    '{"actions":[{}]}', '{"model":{}}', '{"tokensConsumed":-1}', '{"lastHeartbeat":12}',
  ])('rejects malformed or mismatched snapshots: %s', content => {
    expect(() => parseAgentSnapshot(content, 'p')).toThrow();
  });
});

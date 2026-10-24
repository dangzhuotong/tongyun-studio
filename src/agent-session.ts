import type { AgentSessionState, AgentActionStep, AgentTaskPlan } from './contracts';
import { getInitialAgentSession } from './bridge';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown) => value == null || text(value);
const count = (value: unknown) => value == null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

// A local file is an observation, never proof of a connected or controllable worker.
export function parseAgentSnapshot(content: string, projectId: string): AgentSessionState {
  const value: unknown = JSON.parse(content);
  if (!object(value) || (value.projectId != null && value.projectId !== projectId)) throw new Error('Agent 记录不属于当前项目或格式无效');
  for (const field of ['agentName', 'agent', 'model', 'activeGoal', 'lastHeartbeat']) {
    if (!optionalText(value[field])) throw new Error(`Agent 字段格式无效：${field}`);
  }
  if (!count(value.tokensConsumed) || !count(value.filesTouched)) throw new Error('Agent 用量格式无效');
  if (value.mode != null && !['autonomous', 'collaborative', 'observer'].includes(String(value.mode))) throw new Error('Agent 模式无效');
  const actions = value.actions ?? [];
  if (!Array.isArray(actions) || actions.length > 1000 || !actions.every(action => object(action) &&
    ['id', 'title', 'detail', 'timestamp'].every(key => text(action[key])) &&
    ['terminal', 'edit', 'git', 'sql', 'http', 'inspect', 'plan'].includes(String(action.kind)) &&
    ['running', 'done', 'error', 'pending'].includes(String(action.status)))) throw new Error('Agent 操作记录格式无效');
  const plan = value.plan ?? null;
  if (plan != null && (!object(plan) || !text(plan.id) || !text(plan.goal) ||
    !['planning', 'executing', 'completed', 'paused'].includes(String(plan.status)) ||
    !(plan.progressPercent == null || (typeof plan.progressPercent === 'number' && Number.isFinite(plan.progressPercent) && plan.progressPercent >= 0 && plan.progressPercent <= 100)) ||
    !Array.isArray(plan.steps) || plan.steps.length > 1000 || !plan.steps.every(step => object(step) && text(step.id) && text(step.text) && ['done', 'active', 'todo'].includes(String(step.status))))) throw new Error('Agent 计划格式无效');
  return {
    ...getInitialAgentSession(projectId), connectionStatus: 'connected',
    agentName: (value.agentName ?? value.agent ?? null) as string | null,
    model: (value.model ?? null) as string | null,
    mode: (value.mode ?? null) as AgentSessionState['mode'],
    activeGoal: (value.activeGoal ?? (object(plan) ? plan.goal : null) ?? null) as string | null,
    plan: plan as AgentTaskPlan | null, actions: actions as AgentActionStep[],
    tokensConsumed: (value.tokensConsumed ?? null) as number | null,
    filesTouched: (value.filesTouched ?? null) as number | null,
    lastHeartbeat: (value.lastHeartbeat ?? null) as string | null,
  };
}

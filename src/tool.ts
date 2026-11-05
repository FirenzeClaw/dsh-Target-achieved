/**
 * `target_status` 工具：模型声明本轮目标状态的唯一通道。
 *
 * 声明是插件判定"任务是否完成"的唯一依据；我们不解析自然语言（FR-014）。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { declare, type TargetState } from './state.ts'

const DESCRIPTION = [
  "Declare this turn's target state before you close it.",
  'Use "done" only when the task is complete and you are about to report it.',
  'Use "awaiting_user" when you need a user decision or more information.',
  'Closing without declaring makes the harness assume the task is unfinished and ask you to continue.',
].join(' ')

const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      turn: { type: 'number' },
      state: { type: 'string' },
    },
    additionalProperties: false,
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

function isDeclarable(state: unknown): state is Exclude<TargetState, 'working'> {
  return state === 'done' || state === 'awaiting_user'
}

/**
 * 注册 `target_status` 工具。
 * @param ctx - 插件上下文
 * @param turnOf - 读取该 agent 当前轮次号
 */
export function registerTargetStatus(
  ctx: Context,
  turnOf: (agent: Agent) => number,
  isEnabled: () => boolean,
): void {
  ctx.tools.register(defineTool({
    name: 'target_status',
    description: DESCRIPTION,
    parameters: {
      state: {
        type: 'string',
        required: true,
        enum: ['done', 'awaiting_user'],
        description: 'Either "done" (complete, about to report) or "awaiting_user" (need user input).',
      },
      summary: {
        type: 'string',
        description: 'Optional one-line note for audit and presentation.',
      },
    },
    output: OUTPUT,
    execute(args, exec) {
      if (!isEnabled()) {
        throw new Error('TARGET_STATUS_DISABLED: target monitor is disabled in settings.')
      }
      const agent = exec.agent
      // exec.agent 是可选字段：没有 agent 的调用（例如直接 tools.execute）无处声明。
      if (agent === undefined) {
        throw new Error('TARGET_STATUS_NOT_ROOT: target_status is only meaningful inside an agent turn.')
      }
      if (!ctx.agents.roots().includes(agent)) {
        throw new Error('TARGET_STATUS_NOT_ROOT: target_status is only meaningful on the top-level agent.')
      }
      if (!isDeclarable(args.state)) {
        throw new Error('TARGET_STATUS_INVALID_STATE: state must be "done" or "awaiting_user".')
      }

      const turn = turnOf(agent)
      declare(agent, turn, args.state)
      return Promise.resolve({ ok: true, turn, state: args.state })
    },
  }))
}

/**
 * 收尾判定的留痕。
 *
 * 存在的理由：插件以前是黑盒——"这一轮到底有没有判定"只能靠翻会话日志猜，
 * 曾据此误判出并不存在的"首轮不触发"缺陷。现在每次判定留一条记录，
 * 查不到记录才等于"该轮未被判定"。
 *
 * 硬约束（FR-003）：记录**绝不能**进入模型可见面。因此不提供查询工具、
 * 不往消息里回显——工具结果必然进模型上下文。检索靠文件本身：
 *
 * ```bash
 * jq -c 'select(.turn == 7)' ~/.dsh/logs/target-monitor/gate-trace.jsonl
 * ```
 *
 * 次约束（FR-007）：留痕失败绝不能影响判定。所有 I/O 异常就地吞掉，
 * 只置一次失败标记，避免磁盘满时刷屏。
 * @module
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 判定结果。 */
export type GateOutcome = 'injected' | 'released'

/** 判定原因；与 outcome 一一约束（见 contracts/trace-record.md）。 */
export type GateReason = 'undeclared' | 'declared' | 'disabled' | 'not-root' | 'aborted' | 'error'

/** 一条判定记录。 */
export interface GateTraceEntry {
  /** 判定时刻（epoch ms）。 */
  readonly at: number
  /** agent 标识的 8 位十六进制短哈希；不落原值。 */
  readonly session: string
  /** 轮次号；未知时为 -1。 */
  readonly turn: number
  readonly outcome: GateOutcome
  readonly reason: GateReason
  /** 本轮第几次注入；`released` 时为 0。 */
  readonly attempt: number
}

/** 调用方要提供的部分：时间、会话、部分由本模块补齐。 */
export type TraceInput = Omit<GateTraceEntry, 'at' | 'session'>

/** 默认保留：单文件 2 MiB、缓冲 200 条。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_CAPACITY = 200

/** 文件名。 */
const FILE_NAME = 'gate-trace.jsonl'

interface SinkConfig {
  /** 落盘目录；`undefined` 表示只进内存缓冲（测试用）。 */
  dir: string | undefined
  maxBytes: number
  capacity: number
}

let sink: SinkConfig = { dir: undefined, maxBytes: DEFAULT_MAX_BYTES, capacity: DEFAULT_CAPACITY }

/** 环形缓冲：新→旧。 */
let buffer: GateTraceEntry[] = []

/** 写入是否已失败；只告警一次。 */
let sinkFailed = false

/** agent → 会话短哈希。 */
const sessions = new WeakMap<Agent, string>()

/** 无 id 的 agent 用递增序号兜底。 */
let anonymousCount = 0

/**
 * 解析默认落盘目录。
 *
 * 与宿主一致：`$DSH_HOME` → `~/.dsh` → 临时目录（`dsh-home-paths/lib/index.js:15`）。
 * @returns 目录路径
 */
function defaultDir(): string {
  const home = process.env['DSH_HOME']
  if (home !== undefined && home !== '') return join(home, 'logs', 'target-monitor')
  return join(homedir() || tmpdir(), '.dsh', 'logs', 'target-monitor')
}

/**
 * 默认落盘目录；测试进程内不落盘。
 *
 * 为什么要在 `node --test` 里关掉：集成测试会驱动真实 `apply`，而 `apply` 会按默认
 * 路径配置留痕。若不隔离，跑一次测试就会把几十条假记录写进用户真实的
 * `~/.dsh/logs/target-monitor/`，污染排查现场（本项目实测踩过一次）。
 * 显式传入 `dir` 的调用不受影响——`tests/unit/trace.test.ts` 正是靠这一点验证落盘。
 * @returns 目录；测试进程返回 undefined 表示只进内存
 */
function defaultDirForEnv(): string | undefined {
  if (process.env['NODE_TEST_CONTEXT'] !== undefined) return undefined
  return defaultDir()
}

/**
 * 配置落盘位置与上限。
 * @param options - 目录与上限；未给出的项沿用默认
 */
export function configureTrace(options: { dir?: string; maxBytes?: number; capacity?: number }): void {
  sink = {
    dir: 'dir' in options ? options.dir : defaultDirForEnv(),
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    capacity: options.capacity ?? DEFAULT_CAPACITY,
  }
  buffer = []
  sinkFailed = false
}

/**
 * 清空缓冲与失败标记（测试用）。
 */
export function resetTraceState(): void {
  buffer = []
  sinkFailed = false
  sink = { dir: undefined, maxBytes: DEFAULT_MAX_BYTES, capacity: DEFAULT_CAPACITY }
}

/**
 * 取（必要时计算）该 agent 的会话短哈希。
 * @param agent - 目标 agent
 */
function sessionOf(agent: Agent): string {
  const existing = sessions.get(agent)
  if (existing !== undefined) return existing

  const rawId = (agent as { id?: unknown }).id
  const seed = typeof rawId === 'string' && rawId !== '' ? rawId : `anonymous-${(anonymousCount += 1)}`
  const hashed = createHash('sha256').update(seed).digest('hex').slice(0, 8)
  sessions.set(agent, hashed)
  return hashed
}

/**
 * 追加一行 JSONL。
 *
 * 先判大小再写：一次 `statSync` 比"写完再回读整文件数行"便宜得多。
 * @param dir - 目录
 * @param line - 已序列化的一行
 * @param maxBytes - 单文件上限
 */
function appendLine(dir: string, line: string, maxBytes: number): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, FILE_NAME)

  let size = 0
  try {
    size = statSync(file).size
  } catch {
    // 文件还不存在：首次写入，无需轮转。
    size = 0
  }
  if (size > 0 && size + line.length > maxBytes) {
    // 覆盖式轮转：只保留一代历史，磁盘占用恒定为 2 × maxBytes。
    renameSync(file, join(dir, `${FILE_NAME}.1`))
  }

  appendFileSync(file, line)
}

/**
 * 记录一次判定。
 *
 * @param agent - 被判定 agent
 * @param input - 判定的轮次、结果、原因与次数
 */
export function recordTrace(agent: Agent, input: TraceInput): void {
  const entry: GateTraceEntry = {
    at: Date.now(),
    session: sessionOf(agent),
    turn: input.turn,
    outcome: input.outcome,
    reason: input.reason,
    attempt: input.attempt,
  }

  buffer.push(entry)
  if (buffer.length > sink.capacity) buffer = buffer.slice(buffer.length - sink.capacity)

  if (sinkFailed || sink.dir === undefined) return
  const dir = sink.dir

  try {
    appendLine(dir, `${JSON.stringify(entry)}\n`, sink.maxBytes)
  } catch (error: unknown) {
    // 留痕是旁路：写不进去也绝不能打断轮次收尾（FR-007）。
    sinkFailed = true
    console.warn('target-monitor: 判定留痕写入失败，本次会话后续不再尝试', error)
  }
}

/**
 * 取最近的记录快照。
 * @returns 新→旧、只读副本
 */
export function recentTraces(): readonly GateTraceEntry[] {
  return Object.freeze([...buffer].reverse())
}

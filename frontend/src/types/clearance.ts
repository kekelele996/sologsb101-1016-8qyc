/**
 * 串级放行核定（ReleaseClearance）
 * 台账侧对每条走水计划按串级顺序核出的放行结论，是一条只读的核定记录：
 * - 放行 / 排队只描述结论，不改计划量（schedule.volumeM3）也不改池里水位（observation.levelCm）；
 * - 化验室换新许可后，按旧许可得出的核定作废，按新许可重新判定；
 * - 同一「计划 + 许可版本」只有一条有效核定（active 唯一），重送 / 重算不多出放行。
 */

/** 放行结论 */
export type ClearanceDecision =
  | '放行' // 许可有效且下游受纳容量足够
  | '排队' // 串级容量不足，按顺序排队，写明差多少
  | '无有效许可' // 池号 + 取样日期对不上批准现行许可
  | '许可撤回' // 原许可已被化验室撤回
  | '已作废' // 化验室换发新许可，本核定基于旧许可，仅留痕

/** 参与串级核放的计划状态：已出卤不重判 */
export const CLEARANCE_ACTIVE_STATES = ['待排', '已排', '走水中'] as const

export interface ClearanceAllocation {
  /** 下游池号（无下游时为空串，表示末端锂盐池直放） */
  pondCode: string
  /** 该下游初始受纳容量（m³） */
  capacityM3: number
  /** 核到本条时该下游剩余余量（m³，含本计划占用后会再扣减） */
  remainingM3: number
  /** 本计划分到该下游的水量（m³） */
  allocatedM3: number
  /** 该下游缺口（m³），无缺口为 0 */
  shortfallM3: number
}

export interface ReleaseClearance {
  /** 核定记录 id：计划 id + 许可版本派生，保证同版本重算幂等 */
  id: string
  /** 走水计划 id */
  scheduleId: string
  /** 池号（核定当时快照，便于留痕） */
  pondCode: string
  /** 计划走水日期快照 */
  planDate: string
  /** 取样日期快照 */
  sampledAt: string
  /** 计划量快照（m³）—— 只快照，绝不回写计划 */
  plannedVolumeM3: number
  /** 依据的许可 id；无许可时为空串 */
  permitId: string
  /** 依据的许可号快照 */
  permitNo: string
  /** 依据的许可版本；无许可为 0 */
  permitVersion: number
  /** 放行结论 */
  decision: ClearanceDecision
  /** 排队顺位（结论为排队时，从 1 起；其他为 0） */
  queueRank: number
  /** 总缺口（m³），排队时 > 0 */
  shortfallM3: number
  /** 逐下游分配与余量明细 */
  allocations: ClearanceAllocation[]
  /** 结论文案（写明差多少 / 依据哪张许可） */
  reason: string
  /** 是否为当前有效核定；旧许可版本的核定置为 false */
  active: boolean
  /** 本次核定时间 ISO */
  decidedAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

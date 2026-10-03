/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/**
 * 串级放行判定：
 * - 已放行：许可有效且下游受纳容量足够
 * - 排队中：下游容量不足，按走水顺序排队（不改计划量、不动池水位）
 * - 未达标：化验室许可缺失 / 不予放行 / 已换发，需重新判定
 */
export type ClearanceStatus = '已放行' | '排队中' | '未达标'

export const CLEARANCE_STATUS_OPTIONS: ClearanceStatus[] = ['已放行', '排队中', '未达标']

export interface Schedule {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 计划走水日期 YYYY-MM-DD */
  planDate: string
  /** 目标密度（g/cm³）——调度员自定，只用于走水编排，不参与放行核算 */
  targetDensity: number
  /** 计划量（m³）——容量不足排队时保持不变，系统不改 */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水；串级放行也按此顺序逐条核 */
  orderIndex: number
  /** 最近一次串级放行判定结果 */
  clearance: ClearanceStatus
  /** 判定所依据的化验室许可编号（无许可时为空） */
  permitId: string
  /** 判定时许可的版本号（许可换发后用于识别过期判定） */
  permitVersion: number
  /** 排队原因 / 容量缺口说明，例如「下游 北-02 受纳余量不足，差 120 m³」 */
  clearanceNote: string
  /** 排队等待的下游受纳池 id（容量不足时） */
  waitingForPondId: string
  /** 容量缺口（m³，排队中时 > 0） */
  shortfallM3: number
  /** 最近一次放行判定时间 */
  clearanceCheckedAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}

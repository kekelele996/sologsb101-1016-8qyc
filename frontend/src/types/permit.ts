/**
 * 出卤许可（DischargePermit）
 * 化验室是另一套系统，晒程台账对许可「只读不改」：
 * 本类型既是化验室侧的许可原件结构，也是台账库里的同步镜像结构。
 * 两边按「池号 pondCode + 取样日期 sampledAt」对齐，不按池主键。
 *
 * 化验室换新许可后，旧许可不会被删除，而是由新版本（version 更大、
 * supersedesId 指向旧许可）取代；台账侧据此把按旧许可放行的串级重新判定。
 */

/** 化验室许可状态：批准 / 撤回（化验室侧作废） */
export type PermitStatus = '批准' | '撤回'

/** 同步状态（台账镜像相对化验室原件的状态） */
export type PermitSyncState = '待同步' | '已同步' | '同步失败'

export const PERMIT_STATUS_OPTIONS: PermitStatus[] = ['批准', '撤回']
export const PERMIT_SYNC_STATE_OPTIONS: PermitSyncState[] = ['待同步', '已同步', '同步失败']

export interface DischargePermit {
  /** 化验室侧许可号（主键；同步镜像沿用同一 id，保证重送幂等） */
  id: string
  /** 许可编号（化验室业务编号，可展示） */
  permitNo: string
  /** 池号 —— 与晒程台账对齐用，不是池主键 */
  pondCode: string
  /** 取样日期 YYYY-MM-DD —— 与台账对齐用 */
  sampledAt: string
  /** 化验室名称 */
  labName: string
  /** 许可状态 */
  status: PermitStatus
  /** 版本号，从 1 起；换新许可时 +1 */
  version: number
  /** 新版本取代的旧许可 id；首版为空字符串 */
  supersedesId: string
  /** 许可放行的出卤量上限（m³） */
  approvedVolumeM3: number
  /** 化验室签发时间 ISO */
  issuedAt: string
  /* ------------------------------ 以下为台账镜像同步字段 ------------------------------ */
  /** 镜像同步状态；化验室原件库中恒为「待同步」 */
  syncState: PermitSyncState
  /** 最近一次同步尝试时间 ISO（未同步为空字符串） */
  syncedAt: string
  /** 同步失败原因（成功时为空字符串） */
  syncError: string
  /** 同步尝试次数（用于排查重试） */
  syncAttempts: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 化验室侧新签发许可的入参（同步字段由化验室侧补齐） */
export interface PermitIssueInput {
  pondCode: string
  sampledAt: string
  labName: string
  approvedVolumeM3: number
  /** 换新许可时传被取代的现行许可 id，版本号自动 +1 */
  supersedesId?: string
}

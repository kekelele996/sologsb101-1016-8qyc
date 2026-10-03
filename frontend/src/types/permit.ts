/**
 * 出卤许可（LabPermit）
 * 化验室的出卤许可是**另一套系统**签发的：晒程台账只读不改，
 * 同步时按「池号 + 取样日期」与台账对上。同一池号 + 取样日期换出新许可后，
 * 旧许可标记为已换发，按旧许可放行的走水计划要重新判定。
 */

/** 许可结论：准予放行 / 不予放行 */
export type PermitVerdict = '准予放行' | '不予放行'

export const PERMIT_VERDICT_OPTIONS: PermitVerdict[] = ['准予放行', '不予放行']

/** 本地镜像的许可状态：现行有效 / 已换发（被新版本顶替） */
export type PermitStatus = '现行有效' | '已换发'

export const PERMIT_STATUS_OPTIONS: PermitStatus[] = ['现行有效', '已换发']

export interface LabPermit {
  /** 许可编号（化验室系统主键，重发同一批次幂等） */
  id: string
  /** 池号（对应 Pond.code，按此与台账对上） */
  pondCode: string
  /** 取样日期 YYYY-MM-DD（与池号共同构成业务键） */
  sampleDate: string
  /** 签发日期 YYYY-MM-DD */
  issuedDate: string
  /** 许可结论 */
  verdict: PermitVerdict
  /** 不予放行的原因（准予放行时为空） */
  reason: string
  /** 出卤批次号（化验室侧批次） */
  batchNo: string
  /** 许可版本号：同一池号 + 取样日期换发后 +1 */
  version: number
  /** 本地镜像状态 */
  status: PermitStatus
  /** 化验室名称 */
  labName: string
  /** 最近一次同步批次（本地 SyncBatch.id） */
  lastSyncBatchId: string
  createdAt: string
  updatedAt: string
  revision: number
}

/**
 * 同步批次（SyncBatch）
 * 记录每一次向化验室系统取数的结果；同步失败按化验室侧重试，
 * 成功的批次重发不重复落库、不多出放行。
 */
export type SyncState = '同步成功' | '同步失败'

export const SYNC_STATE_OPTIONS: SyncState[] = ['同步成功', '同步失败']

export interface SyncBatch {
  /** 本地批次主键 */
  id: string
  /** 化验室侧批次序号 */
  remoteBatchNo: number
  /** 同步动作：初次拉取 / 失败重试 / 换发新许可 */
  action: string
  /** 同步结果 */
  state: SyncState
  /** 本批许可条数（成功时） */
  permitCount: number
  /** 已在台账对上池号的许可条数 */
  matchedCount: number
  /** 失败原因（state = 同步失败 时） */
  errorMessage: string
  syncedAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

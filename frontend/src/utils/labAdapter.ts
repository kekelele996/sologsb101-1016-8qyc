/**
 * 化验室出卤许可系统对接层（模拟）
 *
 * 真实部署中这里会换成对化验室系统的 HTTP 拉取；本项目是纯前端无后端 SPA，
 * 用「远端快照 + 内存换发」模拟那套外部系统。**晒程台账只读不改**：
 * 台账侧从不回写化验室，只按「池号 + 取样日期」拉取并镜像许可。
 *
 * 同步失败按化验室侧重试：fetchLabBatch 可被 setLabOffline 置成失败，
 * 同一 remoteBatchNo 重发返回完全一致的许可（幂等），台账侧不会多出放行。
 */
import type { LabPermit } from '../types/permit';
import { nowIso } from './id';

/** 化验室侧首批许可批次号（之后换发逐批 +1） */
export const LAB_INITIAL_BATCH_NO = 101;

/** 台账首次拉取的镜像批次（sync-${批次号}，与后续同步批次主键规则一致） */
export const LAB_INITIAL_SYNC_BATCH_ID = `sync-${LAB_INITIAL_BATCH_NO}`;

const stamp = '2026-09-30T01:00:00.000Z';

/**
 * 化验室系统里现行的许可快照（远端权威数据）。
 * permit-north-03-2026-09-18 为后续换发演示预留。
 */
const INITIAL_LAB_PERMITS: LabPermit[] = [
  {
    id: 'permit-north-01-2026-09-22',
    pondCode: '北-01',
    sampleDate: '2026-09-22',
    issuedDate: '2026-09-25',
    verdict: '准予放行',
    reason: '',
    batchNo: 'LAB-101',
    version: 1,
    status: '现行有效',
    labName: '盐湖中心化验室',
    lastSyncBatchId: LAB_INITIAL_SYNC_BATCH_ID,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  },
  {
    id: 'permit-north-02-2026-09-14',
    pondCode: '北-02',
    sampleDate: '2026-09-14',
    issuedDate: '2026-09-16',
    verdict: '准予放行',
    reason: '',
    batchNo: 'LAB-101',
    version: 1,
    status: '现行有效',
    labName: '盐湖中心化验室',
    lastSyncBatchId: LAB_INITIAL_SYNC_BATCH_ID,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  },
  {
    id: 'permit-north-03-2026-09-18',
    pondCode: '北-03',
    sampleDate: '2026-09-18',
    issuedDate: '2026-09-20',
    verdict: '准予放行',
    reason: '',
    batchNo: 'LAB-101',
    version: 1,
    status: '现行有效',
    labName: '盐湖中心化验室',
    lastSyncBatchId: LAB_INITIAL_SYNC_BATCH_ID,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  },
  {
    id: 'permit-south-04-2026-09-24',
    pondCode: '南-04',
    sampleDate: '2026-09-24',
    issuedDate: '2026-09-27',
    verdict: '不予放行',
    reason: 'Mg²⁺ 含量 48.9 g/L 超串级上限，需继续晒制',
    batchNo: 'LAB-101',
    version: 1,
    status: '现行有效',
    labName: '南部化验站',
    lastSyncBatchId: LAB_INITIAL_SYNC_BATCH_ID,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  },
];

/** 化验室系统当前状态（模拟内存态，刷新页面后回到初始快照） */
interface LabState {
  offline: boolean;
  /** 当前已发布批次号：普通拉取返回它，只有换发才 +1 生成新批次 */
  currentBatchNo: number;
  permits: LabPermit[];
}

const labState: LabState = {
  offline: false,
  currentBatchNo: LAB_INITIAL_BATCH_NO,
  permits: INITIAL_LAB_PERMITS.map((item) => ({ ...item })),
};

/** 模拟化验室系统离线 / 恢复（用于演示「同步失败 → 按化验室重试」） */
export function setLabOffline(offline: boolean): void {
  labState.offline = offline;
}

export function isLabOffline(): boolean {
  return labState.offline;
}

/** 台账初始化播种时直接读取的首批许可镜像（不落同步日志也能对齐初始数据） */
export function initialLabPermits(): LabPermit[] {
  return INITIAL_LAB_PERMITS.map((item) => ({ ...item }));
}

export interface LabBatchResult {
  remoteBatchNo: number
  permits: LabPermit[]
}

/**
 * 向化验室系统拉取当前批次的许可快照。
 * 离线时抛错，台账侧应记录「同步失败」并由用户重试。
 */
export async function fetchLabBatch(): Promise<LabBatchResult> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (labState.offline) {
    throw new Error('化验室许可系统连接超时（HTTP 504）');
  }
  return {
    remoteBatchNo: labState.currentBatchNo,
    permits: labState.permits.map((item) => ({ ...item })),
  };
}

export interface ReissueInput {
  pondCode: string
  sampleDate: string
  verdict: LabPermit['verdict']
  reason?: string
  labName?: string
}

/**
 * 化验室侧换发新许可：同一「池号 + 取样日期」生成 version+1 的新许可，
 * 旧许可在化验室侧标记为「已换发」。下一次台账同步时即按新许可重新判定。
 */
export async function reissueLabPermit(input: ReissueInput): Promise<{ remoteBatchNo: number; permits: LabPermit[] }> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (labState.offline) {
    throw new Error('化验室许可系统连接超时（HTTP 504）');
  }
  const index = labState.permits.findIndex(
    (item) => item.pondCode === input.pondCode && item.sampleDate === input.sampleDate,
  );
  if (index < 0) throw new Error(`化验室未找到 ${input.pondCode} 于 ${input.sampleDate} 的许可，无法换发`);
  const previous = labState.permits[index];
  const now = nowIso();
  const batchNo = labState.currentBatchNo + 1;
  labState.currentBatchNo = batchNo;
  labState.permits[index] = {
    ...previous,
    // 换发是化验室新签发的一份许可：新主键、版本 +1；旧主键保留在历史里转「已换发」
    id: `permit-${input.pondCode}-${input.sampleDate}-v${previous.version + 1}`,
    verdict: input.verdict,
    reason: input.reason ?? (input.verdict === '不予放行' ? '复检指标异常' : ''),
    labName: input.labName ?? previous.labName,
    version: previous.version + 1,
    status: '现行有效',
    batchNo: `LAB-${batchNo}`,
    createdAt: now,
    updatedAt: now,
    lastSyncBatchId: '',
  };
  const superseded: LabPermit = {
    ...previous,
    status: '已换发',
    updatedAt: now,
  };
  // 化验室侧保留历史版本，快照里同时下发新旧两条（台账按 id 覆盖识别换发）
  labState.permits.push(superseded);
  return { remoteBatchNo: batchNo, permits: labState.permits.map((item) => ({ ...item })) };
}

/** 重置化验室模拟状态（仅测试 / 演示用） */
export function resetLabState(): void {
  labState.offline = false;
  labState.currentBatchNo = LAB_INITIAL_BATCH_NO;
  labState.permits = INITIAL_LAB_PERMITS.map((item) => ({ ...item }));
}

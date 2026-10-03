/**
 * 化验室系统客户端（外部系统，台账只读不改）
 *
 * 现实里化验室是另一套系统；本应用无后端，这里用**另一个 Dexie 数据库**
 * （gbbrinepond-lab）模拟化验室系统：
 * - 许可的签发、换新、撤回只发生在化验室库里，晒程台账不能改许可；
 * - 台账通过 pullPermits() 拉取许可镜像，同步失败后由台账侧重试，
 *   重试从化验室这边按游标继续取，已取到的不会重复落库（按 permitNo+version 幂等）；
 * - 同一张许可无论重送多少次，台账镜像与放行核定都只有一条。
 */
import Dexie, { type Table } from 'dexie';
import type { DischargePermit, PermitIssueInput, PermitStatus } from '../types/permit';
import { nowIso } from './id';

/** 化验室系统数据库名（与晒程台账库 gbbrinepond 物理隔离） */
export const LAB_DB_NAME = 'gbbrinepond-lab';
export const LAB_DB_VERSION = 1;

class LabDatabase extends Dexie {
  permits!: Table<DischargePermit, string>;

  constructor() {
    super(LAB_DB_NAME);
    this.version(LAB_DB_VERSION).stores({
      permits: 'id, permitNo, pondCode, sampledAt, status, version, supersedesId, issuedAt',
    });
  }
}

export const labDb = new LabDatabase();

/* --------------------------- 故障注入（仅演示用） --------------------------- */

/**
 * 模拟化验室接口故障的开关：打开后下一次拉取会失败一次，随后自动恢复。
 * 纯内存状态，不持久化 —— 演示「同步失败后重试」用。
 */
let nextPullFails = false;

export function armLabPullFailure(): void {
  nextPullFails = true;
}

export function isLabPullFailureArmed(): boolean {
  return nextPullFails;
}

/* ------------------------------- 化验室侧写操作 ------------------------------- */

/** 化验室签发 / 换发许可。换新时 version 在被取代许可上 +1，并把旧许可状态保留留痕。 */
export async function issuePermit(input: PermitIssueInput): Promise<DischargePermit> {
  const stamp = nowIso();
  let supersedesId = input.supersedesId?.trim() ?? '';
  let version = 1;
  if (supersedesId !== '') {
    const previous = await labDb.permits.get(supersedesId);
    if (previous !== undefined) {
      // 同池号同取样日期才允许换发，避免错串
      if (previous.pondCode !== input.pondCode || previous.sampledAt !== input.sampledAt) {
        throw new Error('换发许可与旧许可的池号或取样日期不一致，化验室已拒绝');
      }
      version = previous.version + 1;
    } else {
      supersedesId = '';
    }
  }
  const seq = Date.now().toString(36);
  const permit: DischargePermit = {
    id: `lab-${seq}`,
    permitNo: `CK-${input.pondCode}-${input.sampledAt.replace(/-/g, '')}-v${version}`,
    pondCode: input.pondCode,
    sampledAt: input.sampledAt,
    labName: input.labName.trim() || '盐湖中心化验室',
    status: '批准',
    version,
    supersedesId,
    approvedVolumeM3: input.approvedVolumeM3,
    issuedAt: stamp,
    syncState: '待同步',
    syncedAt: '',
    syncError: '',
    syncAttempts: 0,
    createdAt: stamp,
    updatedAt: stamp,
    revision: 1,
  };
  await labDb.permits.put(permit);
  return permit;
}

/** 化验室撤回许可（原件状态置为撤回，台账下次同步后按撤回重判） */
export async function revokePermit(permitId: string): Promise<void> {
  await labDb.permits.update(permitId, { status: '撤回' satisfies PermitStatus, updatedAt: nowIso() });
}

export async function listLabPermits(): Promise<DischargePermit[]> {
  const rows = await labDb.permits.toArray();
  return rows.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
}

/* ------------------------------- 台账侧拉取（只读） ------------------------------- */

export interface PullPermitsResult {
  /** 本次从化验室取到的许可（含历次已同步的，按 issuedAt 增量游标） */
  permits: DischargePermit[];
  /** 本次新取到（游标之后）的条数 */
  fetched: number;
  /** 拉取尝试是否失败（失败时 permits 为空，调用方应重试） */
  failed: boolean;
  error: string;
}

/**
 * 从化验室系统拉取许可。
 * @param sinceIssuedAt 增量游标：只取 issuedAt 严格晚于该时间的许可；首传空串全量拉
 *
 * 失败语义：故障时抛错由调用方捕获。游标只在调用方成功落库后才前移，
 * 因此失败重试不会漏单；已落库许可按业务键幂等，重送不会多出放行。
 */
export async function pullPermitsSince(sinceIssuedAt: string): Promise<Omit<PullPermitsResult, 'failed' | 'error'>> {
  if (nextPullFails) {
    nextPullFails = false;
    throw new Error('化验室系统暂时不可达（模拟故障），请稍后重试');
  }
  const all = await listLabPermits();
  const fresh = sinceIssuedAt === '' ? all : all.filter((permit) => permit.issuedAt > sinceIssuedAt);
  return { permits: fresh, fetched: fresh.length };
}

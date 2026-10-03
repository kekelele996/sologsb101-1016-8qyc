/**
 * 出卤许可与串级核放状态管理（Solid 原生能力）
 * - 许可来自化验室另一套系统：本 store 只读镜像，所有许可写操作走化验室侧；
 * - 同步失败后从化验室侧重试（游标不前移），同一批重送幂等、不多出放行；
 * - 台账数据（池 / 闸 / 观测 / 化验 / 计划）或许可变动后，自动按串级重新核一遍；
 * - 核放结论只落 clearances 表，绝不回写计划量与池水位。
 */
import { createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { DischargePermit, PermitIssueInput } from '../types/permit';
import type { ReleaseClearance } from '../types/clearance';
import {
  db,
  initDatabase,
  listPermits,
  reAdjudicateClearances,
  syncPermitsFromLab,
  type SyncPermitsResult,
} from '../utils/db';
import { armLabPullFailure, issuePermit, listLabPermits, revokePermit } from '../utils/labClient';

interface ClearanceState_ {
  permits: DischargePermit[];
  clearances: ReleaseClearance[];
  loading: boolean;
  syncing: boolean;
  lastMessage: string;
  lastSyncFailed: boolean;
}

function signature(rows: ReadonlyArray<{ updatedAt: string }>): string {
  return rows
    .map((row) => row.updatedAt)
    .sort()
    .join('|');
}

function createClearanceStore() {
  const [state, setState] = createStore<ClearanceState_>({
    permits: [],
    clearances: [],
    loading: true,
    syncing: false,
    lastMessage: '',
    lastSyncFailed: false,
  });

  // 上一次参与核算的数据指纹：输入没变就不重写核定表，避免 liveQuery 自激循环
  let lastInputSignature = '';
  let recomputeTimer: ReturnType<typeof setTimeout> | null = null;
  let labSeeded = false;

  void initDatabase();

  /** 台账输入变动后防抖重算；许可镜像变化也会触发（换新许可 → 旧许可放行重判） */
  function scheduleRecompute(reason: string): void {
    if (recomputeTimer !== null) clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => {
      void recompute(reason);
    }, 120);
  }

  async function recompute(reason: string): Promise<void> {
    void reason;
    const [ponds, gates, observations, assays, schedules, permits] = await Promise.all([
      db.ponds.toArray(),
      db.gates.toArray(),
      db.observations.toArray(),
      db.assays.toArray(),
      db.schedules.toArray(),
      listPermits(),
    ]);
    const finger = [ponds, gates, observations, assays, schedules, permits].map(signature).join('||');
    if (finger === lastInputSignature) return;
    lastInputSignature = finger;
    const rows = await reAdjudicateClearances();
    setState('clearances', [...rows].sort((a, b) => a.queueRank - b.queueRank));
  }

  // 台账五张表任一变动（改计划量、调闸、录观测、改化验）→ 串级余量重算
  liveQuery(() =>
    Promise.all([
      db.ponds.toArray(),
      db.gates.toArray(),
      db.observations.toArray(),
      db.assays.toArray(),
      db.schedules.toArray(),
    ]),
  ).subscribe({
    next: () => scheduleRecompute('台账数据变动'),
    error: () => undefined,
  });

  // 许可镜像变动（同步落库 / 撤回同步）→ 按新许可重判
  liveQuery(() => db.permits.toArray()).subscribe({
    next: (rows) => {
      setState('permits', [...rows].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)));
      scheduleRecompute('化验室许可变动');
    },
    error: () => undefined,
  });

  // 核定表变动（兜底订阅：重算写入后刷新顺序）
  liveQuery(() => db.clearances.toArray()).subscribe({
    next: (rows) => {
      setState(
        'clearances',
        [...rows].filter((row) => row.active).sort((a, b) => a.queueRank - b.queueRank),
      );
      setState('loading', false);
    },
    error: () => undefined,
  });

  /** 从化验室系统同步许可；失败后可反复重试，游标只在成功后前移 */
  async function syncFromLab(): Promise<SyncPermitsResult> {
    setState('syncing', true);
    try {
      const result = await syncPermitsFromLab();
      setState('lastSyncFailed', result.failed);
      setState('lastMessage', result.failed ? `同步失败：${result.message}（化验室侧未确认，可重试，不会重复放行）` : result.message);
      return result;
    } finally {
      setState('syncing', false);
    }
  }

  /** 手动触发串级重核（计划拖拽改顺序 / 调闸后想立即重算） */
  async function recheckNow(): Promise<void> {
    lastInputSignature = '';
    await recompute('手动重核');
    setState('lastMessage', '已按当前串级顺序与化验室许可重新核放');
  }

  /* ------------------------- 化验室侧操作（外部系统演示） ------------------------- */

  async function ensureLabSeeded(): Promise<void> {
    if (labSeeded) return;
    await initDatabase();
    labSeeded = true;
  }

  /** 化验室签发 / 换发许可，随后台账同步并自动重判 */
  async function labIssue(input: PermitIssueInput): Promise<DischargePermit> {
    await ensureLabSeeded();
    const permit = await issuePermit(input);
    const result = await syncFromLab();
    if (result.failed) {
      setState('lastMessage', `化验室已签发 ${permit.permitNo}，但台账同步失败：${result.message}，请重试同步`);
    }
    return permit;
  }

  /** 化验室撤回许可，随后台账同步，按撤回重新判定 */
  async function labRevoke(permitId: string): Promise<void> {
    await revokePermit(permitId);
    await syncFromLab();
  }

  /** 打开「下一次拉取失败一次」的故障注入，用于演示失败重试 */
  function armNextSyncFailure(): void {
    armLabPullFailure();
    setState('lastMessage', '已模拟化验室接口故障：下一次同步会失败，再点一次即按化验室侧重试成功，且不会重复放行');
  }

  async function labPermits(): Promise<DischargePermit[]> {
    return listLabPermits();
  }

  /** 计划 id → 当前有效核定 */
  function clearanceOf(scheduleId: string): ReleaseClearance | null {
    return state.clearances.find((row) => row.scheduleId === scheduleId && row.active) ?? null;
  }

  return {
    state,
    syncFromLab,
    recheckNow,
    labIssue,
    labRevoke,
    labPermits,
    armNextSyncFailure,
    clearanceOf,
  };
}

const store = createRoot(createClearanceStore);

export function useClearanceStore() {
  return store;
}

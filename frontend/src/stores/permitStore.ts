/**
 * 化验室出卤许可状态管理（Solid 原生能力）
 *
 * 职责：
 * - 镜像只读：许可来自化验室那套系统，台账侧只展示 / 订阅，不提供编辑入口；
 * - 同步与重试：向化验室取数，失败按化验室批次登记并重试，
 *   同一批次重发幂等（不重复镜像、不多出放行）；
 * - 换发联动：化验室换发新许可后同步，旧许可转「已换发」，串级放行全量重判。
 */
import { createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { LabPermit, SyncBatch } from '../types/permit';
import {
  applyLabSync,
  initDatabase,
  listLabPermits,
  listSyncBatches,
  recordSyncFailure,
} from '../utils/db';
import { fetchLabBatch, isLabOffline, reissueLabPermit, setLabOffline } from '../utils/labAdapter';

interface PermitState {
  permits: LabPermit[];
  batches: SyncBatch[];
  loading: boolean;
  syncing: boolean;
  error: string;
  lastMessage: string;
}

function createPermitStore() {
  const [state, setState] = createStore<PermitState>({
    permits: [],
    batches: [],
    loading: true,
    syncing: false,
    error: '',
    lastMessage: '',
  });

  void initDatabase();

  liveQuery(async () => ({
    permits: await listLabPermits(),
    batches: await listSyncBatches(),
  })).subscribe({
    next: ({ permits, batches }) => {
      setState({ permits, batches, loading: false, error: '' });
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取化验室许可失败' });
    },
  });

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  /** 最近一次同步批次（无论成功失败） */
  function latestBatch(): SyncBatch | null {
    return state.batches[0] ?? null;
  }

  /**
   * 向化验室同步许可。
   * 失败时登记「同步失败」并保留错误信息，由 syncWithLab 重试；
   * 成功但批次已同步过 → changed=false，不重复放行。
   */
  async function syncWithLab(action: string): Promise<boolean> {
    setState('syncing', true);
    setState('error', '');
    try {
      const { remoteBatchNo, permits } = await fetchLabBatch();
      const result = await applyLabSync(remoteBatchNo, permits, action);
      if (!result.changed) {
        setState(
          'lastMessage',
          `化验室批次 LAB-${remoteBatchNo} 此前已成功同步，同一批重送不重复落库、不多出放行`,
        );
      } else {
        const released = result.results.filter((item) => item.clearance === '已放行').length;
        const queued = result.results.filter((item) => item.clearance === '排队中').length;
        setState(
          'lastMessage',
          `化验室批次 LAB-${remoteBatchNo} 同步成功：镜像 ${result.batch.permitCount} 条许可（对上池号 ${result.batch.matchedCount} 条），放行重算完成——已放行 ${released} 条、排队 ${queued} 条`,
        );
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : '化验室许可系统不可用';
      // 失败时化验室批次尚未取回：沿用已有失败批次号，首次失败取下一个待同步批次
      const failedBatch = state.batches.find((batch) => batch.state === '同步失败');
      const lastSuccess = state.batches.find((batch) => batch.state === '同步成功');
      const remoteBatchNo = failedBatch?.remoteBatchNo ?? (lastSuccess?.remoteBatchNo ?? 0) + 1;
      await recordSyncFailure(remoteBatchNo, action, message);
      setState('error', message);
      setState('lastMessage', `同步失败：${message}。许可与放行维持原状，可按化验室批次重试。`);
      return false;
    } finally {
      setState('syncing', false);
    }
  }

  /** 化验室侧换发新许可后立即同步，旧许可放行的计划会按新许可重新判定 */
  async function reissueAndSync(input: Parameters<typeof reissueLabPermit>[0]): Promise<boolean> {
    setState('syncing', true);
    setState('error', '');
    try {
      const { remoteBatchNo, permits } = await reissueLabPermit(input);
      const result = await applyLabSync(remoteBatchNo, permits, `换发新许可·${input.pondCode}·${input.sampleDate}`);
      const released = result.results.filter((item) => item.clearance === '已放行').length;
      const queued = result.results.filter((item) => item.clearance === '排队中').length;
      setState(
        'lastMessage',
        `化验室已换发 ${input.pondCode}（取样 ${input.sampleDate}）的新许可（LAB-${remoteBatchNo}）：旧许可转「已换发」，按旧许可放行的计划已全部重新判定，当前已放行 ${released} 条、排队 ${queued} 条`,
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : '换发同步失败';
      setState('error', message);
      setState('lastMessage', `换发同步失败：${message}`);
      return false;
    } finally {
      setState('syncing', false);
    }
  }

  /** 切换化验室系统离线 / 恢复（演示同步失败与重试） */
  function toggleLabOffline(): boolean {
    const next = !isLabOffline();
    setLabOffline(next);
    setState('lastMessage', next ? '已模拟化验室许可系统离线，下一次同步将失败' : '化验室许可系统已恢复在线，可重试同步');
    return next;
  }

  return {
    state,
    setMessage,
    latestBatch,
    syncWithLab,
    reissueAndSync,
    toggleLabOffline,
    isLabOffline,
  };
}

const store = createRoot(createPermitStore);

export function usePermitStore() {
  return store;
}

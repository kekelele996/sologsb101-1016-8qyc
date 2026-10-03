/**
 * /permits 化验室出卤许可（只读镜像）与同步批次
 * - 许可是化验室另一套系统签发的，本台账只读不改，按「池号 + 取样日期」对上；
 * - 同步失败按化验室批次重试，同一批重送幂等（不多出放行）；
 * - 化验室换发新许可后同步，旧许可转「已换发」，走水编排按新许可重新判定。
 * 消费模型：LabPermit、SyncBatch（只读）；复用组件：<StatBadge>、<EmptyPanel>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { usePondStore } from '../stores/pondStore';
import { usePermitStore } from '../stores/permitStore';
import type { PermitVerdict, SyncBatch } from '../types/permit';

const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-50';
const BTN_WARN =
  'rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-700 transition hover:bg-amber-100 disabled:opacity-50';

const VERDICT_STYLE: Record<PermitVerdict, string> = {
  准予放行: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  不予放行: 'border-rose-300 bg-rose-50 text-rose-700',
};

export default function PermitBoard() {
  const pondStore = usePondStore();
  const permitStore = usePermitStore();
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondCodeOf = (code: string): string => {
    const pond = pondStore.state.ponds.find((item) => item.code === code);
    return pond === undefined ? '未对上池号' : `${pond.code} · ${pond.seriesName} · ${pond.stage}`;
  };

  const stats = createMemo(() => {
    const permits = permitStore.state.permits.filter((item) => item.status === '现行有效');
    const batches = permitStore.state.batches;
    return {
      current: permits.length,
      pass: permits.filter((item) => item.verdict === '准予放行').length,
      reject: permits.filter((item) => item.verdict === '不予放行').length,
      superseded: permitStore.state.permits.filter((item) => item.status === '已换发').length,
      failed: batches.filter((item) => item.state === '同步失败').length,
      lastBatch: batches[0] ?? null,
    };
  });

  const run = async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  };

  const latestFailure = createMemo<SyncBatch | null>(
    () => permitStore.state.batches.find((item) => item.state === '同步失败') ?? null,
  );

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="现行许可" value={stats().current} suffix="份" tone="primary" />
        <StatBadge label="准予放行" value={stats().pass} suffix="份" tone="success" />
        <StatBadge label="不予放行" value={stats().reject} suffix="份" tone="warning" />
        <StatBadge label="已换发旧许可" value={stats().superseded} suffix="份" tone="default" />
        <StatBadge label="失败批次" value={stats().failed} suffix="个" tone={stats().failed > 0 ? 'warning' : 'default'} />
        <StatBadge
          label="化验室系统"
          value={permitStore.isLabOffline() ? '离线（模拟）' : '在线'}
          tone={permitStore.isLabOffline() ? 'warning' : 'success'}
          hint="纯前端演示：可模拟化验室系统离线，观察同步失败与重试"
        />
      </div>

      <Show when={permitStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {permitStore.state.lastMessage}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-[15px] font-semibold text-slate-800">化验室出卤许可（只读镜像）</h2>
            <p class="mt-0.5 text-xs text-slate-500">
              许可由化验室系统签发，台账只读不改，按池号与取样日期对上；许可换发后走水放行自动重新判定。
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              class={BTN_PRIMARY}
              disabled={busy() || permitStore.state.syncing}
              onClick={() => void run(() => permitStore.syncWithLab('手动同步'))}
            >
              {permitStore.state.syncing ? '同步中…' : '向化验室同步许可'}
            </button>
            <button
              class={BTN_GHOST}
              disabled={busy()}
              onClick={() => {
                permitStore.toggleLabOffline();
              }}
              title="模拟化验室系统离线 / 恢复，用于验证失败重试"
            >
              {permitStore.isLabOffline() ? '恢复化验室在线' : '模拟化验室离线'}
            </button>
          </div>
        </header>

        <Show when={latestFailure() !== null}>
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <span>
              批次 LAB-{latestFailure()?.remoteBatchNo} 同步失败：{latestFailure()?.errorMessage}
              （许可与放行未改动）
            </span>
            <button
              class="rounded-md border border-rose-300 bg-white px-3 py-1 text-xs text-rose-700 hover:bg-rose-100 disabled:opacity-50"
              disabled={busy() || permitStore.state.syncing || permitStore.isLabOffline()}
              onClick={() => void run(() => permitStore.syncWithLab('失败重试'))}
            >
              按化验室批次重试
            </button>
          </div>
        </Show>

        <Show
          when={permitStore.state.permits.length > 0}
          fallback={
            <EmptyPanel
              title="还没有化验室许可镜像"
              description="点击「向化验室同步许可」拉取最新出卤许可。同步成功后，走水编排会按池号与取样日期对上许可并做串级放行核算。"
              actionText="向化验室同步许可"
              onAction={() => void run(() => permitStore.syncWithLab('手动同步'))}
            />
          }
        >
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1080px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">池号（对上台账）</th>
                  <th class="px-3 py-2">取样日期</th>
                  <th class="px-3 py-2">签发日期</th>
                  <th class="px-3 py-2">许可编号 / 版本</th>
                  <th class="px-3 py-2">化验室</th>
                  <th class="px-3 py-2">结论</th>
                  <th class="px-3 py-2">镜像状态</th>
                  <th class="px-3 py-2">不予放行原因</th>
                </tr>
              </thead>
              <tbody>
                <For each={permitStore.state.permits}>
                  {(permit) => (
                    <tr
                      class={`border-b border-slate-100 ${
                        permit.status === '已换发' ? 'bg-slate-50/70 text-slate-400 line-through decoration-slate-300' : 'hover:bg-slate-50/60'
                      }`}
                    >
                      <td class="px-3 py-2.5">{pondCodeOf(permit.pondCode)}</td>
                      <td class="px-3 py-2.5 tabular-nums">{permit.sampleDate}</td>
                      <td class="px-3 py-2.5 tabular-nums">{permit.issuedDate}</td>
                      <td class="px-3 py-2.5 text-xs">
                        {permit.id}
                        <span class="ml-1 rounded bg-slate-100 px-1 py-0.5 text-[11px] text-slate-500">v{permit.version}</span>
                      </td>
                      <td class="px-3 py-2.5 text-xs text-slate-500">{permit.labName}</td>
                      <td class="px-3 py-2.5">
                        <span class={`rounded border px-1.5 py-0.5 text-[11px] ${VERDICT_STYLE[permit.verdict]}`}>
                          {permit.verdict}
                        </span>
                      </td>
                      <td class="px-3 py-2.5 text-xs">
                        {permit.status === '现行有效' ? (
                          <span class="text-emerald-700">现行有效</span>
                        ) : (
                          <span class="text-slate-400">已换发（旧许可，按其放行的需重判）</span>
                        )}
                      </td>
                      <td class="px-3 py-2.5 text-xs text-rose-600">{permit.verdict === '不予放行' ? permit.reason : '—'}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3">
          <h2 class="text-[15px] font-semibold text-slate-800">同步批次</h2>
          <p class="mt-0.5 text-xs text-slate-500">
            每次向化验室取数登记一个批次；同一批次重发不重复落库、不多出放行。
          </p>
        </header>
        <Show when={permitStore.state.batches.length > 0} fallback={<p class="text-sm text-slate-400">暂无同步批次</p>}>
          <ul class="space-y-1.5">
            <For each={permitStore.state.batches}>
              {(batch) => (
                <li class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-xs">
                  <span
                    class={`rounded border px-1.5 py-0.5 ${
                      batch.state === '同步成功'
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : 'border-rose-300 bg-rose-50 text-rose-700'
                    }`}
                  >
                    {batch.state}
                  </span>
                  <span class="font-medium text-slate-700">LAB-{batch.remoteBatchNo}</span>
                  <span class="text-slate-500">{batch.action}</span>
                  <span class="text-slate-500">
                    镜像 {batch.permitCount} 份 · 对上池号 {batch.matchedCount} 份
                  </span>
                  <Show when={batch.state === '同步失败'}>
            <span class="text-rose-600">失败原因：{batch.errorMessage}</span>
          </Show>
                  <span class="ml-auto text-slate-400">{new Date(batch.syncedAt).toLocaleString('zh-CN')}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-4">
        <header class="mb-2">
          <h2 class="text-[15px] font-semibold text-amber-800">化验室侧操作演示</h2>
          <p class="mt-0.5 text-xs text-amber-700">
            纯前端无化验室后端，以下按钮模拟化验室系统换发新许可；同步后晒程台账按新许可重判，旧许可自动归档为「已换发」。
          </p>
        </header>
        <div class="flex flex-wrap gap-2">
          <button
            class={BTN_WARN}
            disabled={busy()}
            onClick={() =>
              void run(() =>
                permitStore.reissueAndSync({
                  pondCode: '北-03',
                  sampleDate: '2026-09-18',
                  verdict: '不予放行',
                  reason: '换发复检：Mg²⁺ 回升至 11.8 g/L，暂缓出卤',
                }),
              )
            }
          >
            模拟化验室换发：北-03 改判「不予放行」
          </button>
          <button
            class={BTN_WARN}
            disabled={busy()}
            onClick={() =>
              void run(() =>
                permitStore.reissueAndSync({
                  pondCode: '南-04',
                  sampleDate: '2026-09-24',
                  verdict: '准予放行',
                  reason: '',
                }),
              )
            }
          >
            模拟化验室换发：南-04 改判「准予放行」
          </button>
        </div>
      </section>
    </div>
  );
}

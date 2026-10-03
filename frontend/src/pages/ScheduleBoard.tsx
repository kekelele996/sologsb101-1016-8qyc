/**
 * /schedules 走水与出卤编排
 * 按日期排序、拖拽调整走水先后顺序、逐条推进状态；出卤完成回写池阶段与实际密度。
 * 消费模型：Schedule、Gate、Assay；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { useClearanceStore } from '../stores/clearanceStore';
import { SCHEDULE_STATE_OPTIONS, type Schedule, type ScheduleDraft, type ScheduleState } from '../types/schedule';
import type { ClearanceDecision } from '../types/clearance';
import { effectiveVerdict } from '../utils/brine';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATE_STYLE: Record<ScheduleState, string> = {
  待排: 'border-slate-300 bg-slate-100 text-slate-600',
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

const CLEARANCE_STYLE: Record<ClearanceDecision, string> = {
  放行: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  排队: 'border-amber-300 bg-amber-50 text-amber-700',
  无有效许可: 'border-rose-300 bg-rose-50 text-rose-700',
  许可撤回: 'border-rose-300 bg-rose-50 text-rose-700',
  已作废: 'border-slate-300 bg-slate-100 text-slate-500',
};

const BTN_LAB =
  'rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs text-violet-700 transition hover:bg-violet-100 disabled:opacity-50';

function emptyDraft(pondId: string, orderIndex: number): ScheduleDraft {
  return {
    pondId,
    planDate: today(),
    targetDensity: 1.15,
    volumeM3: 800,
    operator: '',
    state: '待排',
    orderIndex,
  };
}

export default function ScheduleBoard() {
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();
  const clearanceStore = useClearanceStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Schedule | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [labOpen, setLabOpen] = createSignal(false);
  const [issueForm, setIssueForm] = createStore({ pondCode: '', sampledAt: today(), approvedVolumeM3: 800, supersedesId: '' });
  const [draft, setDraft] = createStore<ScheduleDraft>(emptyDraft('', 1));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const ordered = createMemo<Schedule[]>(() =>
    [...scheduleStore.state.rows].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)),
  );

  const filtered = createMemo<Schedule[]>(() => {
    const current = scheduleStore.filters();
    const series = pondStore.state.currentSeries;
    const keyword = current.keyword.trim().toLowerCase();
    return ordered().filter((row) => {
      const pond = pondOf(row.pondId);
      if (series !== null && pond?.seriesName !== series) return false;
      if (current.state !== 'all' && row.state !== current.state) return false;
      if (keyword === '') return true;
      return (
        pondLabel(row.pondId).toLowerCase().includes(keyword) ||
        row.operator.toLowerCase().includes(keyword) ||
        row.planDate.includes(keyword)
      );
    });
  });

  const stats = createMemo(() => {
    const list = ordered();
    return {
      total: list.length,
      pending: list.filter((row) => row.state === '待排').length,
      running: list.filter((row) => row.state === '走水中').length,
      done: list.filter((row) => row.state === '已出卤').length,
      volume: Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      donePct: list.length === 0 ? 0 : Math.round((list.filter((row) => row.state === '已出卤').length / list.length) * 1000) / 10,
    };
  });

  /** 当前串级核放统计（只看在途计划的有效核定） */
  const clearanceStats = createMemo(() => {
    const active = clearanceStore.state.clearances.filter((row) => row.active);
    return {
      released: active.filter((row) => row.decision === '放行').length,
      queued: active.filter((row) => row.decision === '排队').length,
      blocked: active.filter((row) => row.decision === '无有效许可' || row.decision === '许可撤回').length,
      shortfall: Math.round(active.reduce((acc, row) => acc + row.shortfallM3, 0) * 10) / 10,
    };
  });

  /** 化验室侧现行许可（演示用，只读展示） */
  const labPermitRows = createMemo(() =>
    [...clearanceStore.state.permits].sort((a, b) =>
      a.pondCode.localeCompare(b.pondCode, 'zh-Hans-CN') || b.version - a.version || b.issuedAt.localeCompare(a.issuedAt),
    ),
  );

  const openIssue = (supersedesId = ''): void => {
    const source = supersedesId === '' ? null : clearanceStore.state.permits.find((permit) => permit.id === supersedesId) ?? null;
    setIssueForm({
      pondCode: source?.pondCode ?? pondStore.state.ponds[0]?.code ?? '',
      sampledAt: source?.sampledAt ?? today(),
      approvedVolumeM3: source?.approvedVolumeM3 ?? 800,
      supersedesId,
    });
    setLabOpen(true);
  };

  const submitIssue = async (): Promise<void> => {
    if (issueForm.pondCode === '' || issueForm.sampledAt === '') {
      scheduleStore.setMessage('请填写池号与取样日期');
      return;
    }
    const permit = await clearanceStore.labIssue({
      pondCode: issueForm.pondCode,
      sampledAt: issueForm.sampledAt,
      labName: '盐湖中心化验室',
      approvedVolumeM3: issueForm.approvedVolumeM3,
      supersedesId: issueForm.supersedesId === '' ? undefined : issueForm.supersedesId,
    });
    setLabOpen(false);
    scheduleStore.setMessage(
      issueForm.supersedesId === ''
        ? `化验室已签发 ${permit.permitNo}，台账同步后已按串级重核`
        : `化验室已换发 ${permit.permitNo}（v${permit.version}），旧许可放行已重新判定`,
    );
  };

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId, ordered().length + 1));
    setDialogOpen(true);
  };

  const openEdit = (row: Schedule): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      planDate: row.planDate,
      targetDensity: row.targetDensity,
      volumeM3: row.volumeM3,
      operator: row.operator,
      state: row.state,
      orderIndex: row.orderIndex,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      scheduleStore.setMessage('请选择蒸发池');
      return;
    }
    if (editingId() === null) {
      const row = await scheduleStore.createSchedule({ ...draft });
      scheduleStore.setMessage(`已新建走水计划：${row.planDate}，目标密度 ${row.targetDensity} g/cm³`);
    } else {
      await scheduleStore.updateSchedule(editingId() as string, { ...draft });
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await scheduleStore.deleteSchedule(row.id);
    setDeleting(null);
  };

  const handleDrop = async (targetId: string): Promise<void> => {
    const fromId = scheduleStore.draggingId();
    setDragOverId(null);
    scheduleStore.setDraggingId(null);
    if (fromId === null || fromId === targetId) return;
    await scheduleStore.moveBefore(fromId, targetId);
  };

  const nextStateLabel = (state: ScheduleState): string => {
    if (state === '待排') return '标记已排';
    if (state === '已排') return '开始走水';
    if (state === '走水中') return '完成出卤';
    return '已出卤';
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="走水计划" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="待排" value={stats().pending} suffix="条" tone="default" />
        <StatBadge label="走水中" value={stats().running} suffix="条" tone="warning" />
        <StatBadge label="已出卤" value={stats().done} suffix="条" tone="success" />
        <StatBadge label="计划总量" value={stats().volume} suffix="m³" tone="info" />
        <StatBadge label="出卤完成率" value={`${stats().donePct}%`} percent={stats().donePct} tone="success" />
      </div>

      <Show when={scheduleStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {scheduleStore.state.lastMessage}
        </div>
      </Show>

      {/* 化验室出卤许可同步面板：台账只读，写操作全在化验室侧 */}
      <section class="rounded-xl border border-violet-200 bg-violet-50/40 p-4">
        <header class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-[15px] font-semibold text-slate-800">化验室出卤许可（外部系统 · 台账只读）</h2>
            <p class="mt-0.5 text-xs text-slate-500">
              许可由化验室另一套系统签发，晒程台账按「池号 + 取样日期」对齐镜像，不改许可内容；
              换新许可后按旧许可放行的计划自动重新判定。
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" class={BTN_LAB} onClick={() => void clearanceStore.syncFromLab()} disabled={clearanceStore.state.syncing}>
              {clearanceStore.state.syncing ? '同步中…' : '从化验室同步 / 失败重试'}
            </button>
            <button type="button" class={BTN_LAB} onClick={() => void clearanceStore.recheckNow()}>
              按串级重新核放
            </button>
            <button type="button" class={BTN_LAB} onClick={() => openIssue('')}>
              化验室签发新许可
            </button>
            <button type="button" class={BTN_LAB} onClick={() => clearanceStore.armNextSyncFailure()}>
              模拟同步故障
            </button>
          </div>
        </header>
        <div class="mb-2.5 flex flex-wrap gap-3 text-xs text-slate-600">
          <span>
            放行 <span class="font-semibold text-emerald-700">{clearanceStats().released}</span> 条
          </span>
          <span>
            排队 <span class="font-semibold text-amber-700">{clearanceStats().queued}</span> 条
          </span>
          <span>
            无许可 / 撤回 <span class="font-semibold text-rose-700">{clearanceStats().blocked}</span> 条
          </span>
          <span>
            排队总缺口 <span class="font-semibold tabular-nums text-amber-700">{clearanceStats().shortfall}</span> m³
          </span>
          <Show when={clearanceStore.state.lastSyncFailed}>
            <span class="font-medium text-rose-700">上次同步失败：化验室侧未确认，请重试（重送不多出放行）</span>
          </Show>
        </div>
        <Show
          when={labPermitRows().length > 0}
          fallback={<p class="text-xs text-slate-500">尚未同步到任何许可，点「从化验室同步」拉取。</p>}
        >
          <div class="overflow-x-auto rounded-lg border border-violet-100 bg-white">
            <table class="w-full min-w-[860px] border-collapse text-xs">
              <thead>
                <tr class="border-b border-violet-100 bg-violet-50/60 text-left text-slate-500">
                  <th class="px-3 py-2">许可号</th>
                  <th class="px-3 py-2">池号</th>
                  <th class="px-3 py-2">取样日期</th>
                  <th class="px-3 py-2 text-right">批准量(m³)</th>
                  <th class="px-3 py-2">版本</th>
                  <th class="px-3 py-2">状态</th>
                  <th class="px-3 py-2">化验室</th>
                  <th class="px-3 py-2">镜像同步</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={labPermitRows()}>
                  {(permit) => (
                    <tr class="border-b border-slate-100 last:border-0">
                      <td class="px-3 py-2 font-medium text-slate-700">{permit.permitNo}</td>
                      <td class="px-3 py-2">{permit.pondCode}</td>
                      <td class="px-3 py-2">{permit.sampledAt}</td>
                      <td class="px-3 py-2 text-right tabular-nums">{permit.approvedVolumeM3}</td>
                      <td class="px-3 py-2">
                        v{permit.version}
                        {permit.supersedesId !== '' ? <span class="ml-1 text-slate-400">（换发）</span> : ''}
                      </td>
                      <td class="px-3 py-2">
                        <span
                          class={`rounded border px-1.5 py-0.5 ${
                            permit.status === '批准'
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                              : 'border-rose-300 bg-rose-50 text-rose-700'
                          }`}
                        >
                          {permit.status}
                        </span>
                      </td>
                      <td class="px-3 py-2 text-slate-500">{permit.labName}</td>
                      <td class="px-3 py-2">
                        <span
                          class={`rounded border px-1.5 py-0.5 ${
                            permit.syncState === '已同步'
                              ? 'border-sky-300 bg-sky-50 text-sky-700'
                              : permit.syncState === '同步失败'
                                ? 'border-rose-300 bg-rose-50 text-rose-700'
                                : 'border-slate-300 bg-slate-100 text-slate-500'
                          }`}
                        >
                          {permit.syncState}
                          {permit.syncAttempts > 1 ? ` ×${permit.syncAttempts}` : ''}
                        </span>
                      </td>
                      <td class="px-3 py-2">
                        <div class="flex gap-2">
                          <button
                            class="text-violet-700 hover:underline disabled:text-slate-300 disabled:no-underline"
                            disabled={permit.status !== '批准'}
                            onClick={() => openIssue(permit.id)}
                            title="化验室换发同池号同取样日期的新版本，旧许可放行自动重判"
                          >
                            换发新版
                          </button>
                          <button
                            class="text-rose-600 hover:underline disabled:text-slate-300 disabled:no-underline"
                            disabled={permit.status !== '批准'}
                            onClick={() => void clearanceStore.labRevoke(permit.id)}
                          >
                            化验室撤回
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">走水与出卤编排</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
            + 新建走水计划
          </button>
        </header>

        <FilterBar
          keyword={scheduleStore.filters().keyword}
          onKeyword={(value) => scheduleStore.patchFilters({ keyword: value })}
          fields={[
            { key: 'series', label: '池系', options: pondStore.seriesOptions() },
            { key: 'state', label: '状态', options: [...SCHEDULE_STATE_OPTIONS] },
          ]}
          values={{ series: pondStore.state.currentSeries ?? 'all', state: scheduleStore.filters().state }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
            if (key === 'state') scheduleStore.patchFilters({ state: value as ScheduleState | 'all' });
          }}
          onReset={() => {
            scheduleStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${ordered().length} 条`}
        />

        <Show when={ordered().length === 0}>
          <EmptyPanel
            title="还没有走水编排"
            description="为蒸发池编排走水日期、目标密度与计划量，拖拽列表可以调整走水先后顺序，逐条推进到「已出卤」会自动回写池阶段。"
            actionText="新建第一条走水计划"
            onAction={openCreate}
          />
        </Show>

        <Show when={ordered().length > 0}>
          <ul class="space-y-2">
            <For each={filtered()}>
              {(row, index) => (
                <li
                  draggable={true}
                  class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 transition ${
                    dragOverId() === row.id ? 'border-brine-500 ring-1 ring-brine-400' : 'border-slate-200'
                  }`}
                  onDragStart={() => scheduleStore.setDraggingId(row.id)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverId(row.id);
                  }}
                  onDragLeave={() => setDragOverId(null)}
                  onDrop={(event) => {
                    event.preventDefault();
                    void handleDrop(row.id);
                  }}
                >
                  <span class="grid h-7 w-7 shrink-0 cursor-grab place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
                    {index() + 1}
                  </span>
                  <span class="cursor-grab text-slate-300" title="按住拖拽调整顺序">
                    ⠿
                  </span>
                  <div class="min-w-[180px] flex-1">
                    <p class="text-sm font-medium text-slate-800">{pondLabel(row.pondId)}</p>
                    <p class="text-xs text-slate-500">
                      计划日期 {row.planDate} · 调度员 {row.operator === '' ? '未填写' : row.operator}
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    <StageTag stage={pondOf(row.pondId)?.stage ?? null} size="sm" />
                  </div>
                  <div class="text-xs text-slate-600">
                    <p>
                      目标密度 <span class="tabular-nums font-medium text-slate-800">{row.targetDensity}</span> g/cm³
                    </p>
                    <p>
                      当前密度{' '}
                      <span class="tabular-nums font-medium text-brine-700">
                        {pondStore.statOf(row.pondId).currentDensity || '—'}
                      </span>
                    </p>
                  </div>
                  <div class="text-xs text-slate-600">
                    <p>
                      计划量 <span class="tabular-nums font-medium text-slate-800">{row.volumeM3}</span> m³
                    </p>
                    <p>
                      组分判定{' '}
                      <span class="font-medium text-slate-800">
                        {(() => {
                          const list = pondStore.state.assays
                            .filter((item) => item.pondId === row.pondId)
                            .sort((a, b) => a.date.localeCompare(b.date));
                          return list.length === 0 ? '未化验' : effectiveVerdict(list[list.length - 1]);
                        })()}
                      </span>
                    </p>
                  </div>
                  {(() => {
                    const clearance = clearanceStore.clearanceOf(row.id);
                    return (
                      <div class="min-w-[190px] max-w-[300px]">
                        <Show
                          when={clearance !== null}
                          fallback={
                            <span class="rounded border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
                              串级待核
                            </span>
                          }
                        >
                          <span
                            class={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${CLEARANCE_STYLE[clearance!.decision]}`}
                            title={clearance!.reason}
                          >
                            核放：{clearance!.decision}
                            <Show when={clearance!.decision === '排队'}>· 第 {clearance!.queueRank} 位 · 差 {clearance!.shortfallM3} m³</Show>
                          </span>
                          <p class="mt-1 leading-snug text-[11px] text-slate-500 line-clamp-2" title={clearance!.reason}>
                            {clearance!.reason}
                          </p>
                        </Show>
                      </div>
                    );
                  })()}
                  <span class={`rounded border px-2 py-0.5 text-[11px] ${STATE_STYLE[row.state]}`}>{row.state}</span>
                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:opacity-50"
                      disabled={
                        row.state === '已出卤' ||
                        (row.state === '待排' && clearanceStore.clearanceOf(row.id)?.decision !== '放行')
                      }
                      title={
                        row.state === '待排' && clearanceStore.clearanceOf(row.id)?.decision !== '放行'
                          ? clearanceStore.clearanceOf(row.id)?.reason ?? '串级尚未核放'
                          : ''
                      }
                      onClick={async () => {
                        const next = await scheduleStore.advance(row.id);
                        if (next === null) scheduleStore.setMessage('该计划已处于「已出卤」状态');
                        if (next === 'blocked') {
                          // 拦截原因已写入 scheduleStore.lastMessage
                        }
                      }}
                    >
                      {nextStateLabel(row.state)}
                    </button>
                    <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                      编辑
                    </button>
                    <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                      删除
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={ordered().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的走水计划"
            description="可以切换池系或状态筛选条件，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => scheduleStore.resetFilters()}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建走水计划' : '编辑走水计划'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => setDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划走水日期</span>
            <input type="date" class={INPUT} value={draft.planDate} onInput={(event) => setDraft('planDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>目标密度（g/cm³）</span>
            <input
              type="number"
              step="0.001"
              class={INPUT}
              value={draft.targetDensity}
              onInput={(event) => setDraft('targetDensity', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>调度员</span>
            <input class={INPUT} value={draft.operator} onInput={(event) => setDraft('operator', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>走水状态</span>
            <select class={INPUT} value={draft.state} onChange={(event) => setDraft('state', event.currentTarget.value as ScheduleState)}>
              <For each={SCHEDULE_STATE_OPTIONS}>{(state) => <option value={state}>{state}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>排序序号（越小越先走水）</span>
            <input
              type="number"
              min="1"
              step="1"
              class={INPUT}
              value={draft.orderIndex}
              onInput={(event) => setDraft('orderIndex', Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          状态推进到「已出卤」时，会把该池推进到下一蒸发阶段，并把最新一次观测的密度回写为当前实际密度。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除走水计划？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.planDate} 的走水计划。
        </p>
      </AppDialog>

      <AppDialog
        open={labOpen()}
        title={issueForm.supersedesId === '' ? '化验室签发新出卤许可（外部系统）' : '化验室换发出卤许可（新版本）'}
        width="max-w-lg"
        onClose={() => setLabOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setLabOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitIssue()}>
              化验室签发并同步
            </button>
          </>
        }
      >
        <div class="space-y-3">
          <p class="rounded-md bg-violet-50 px-3 py-2 text-xs leading-relaxed text-violet-800">
            此动作发生在化验室系统：晒程台账不能手工录许可。签发后台账自动从化验室同步，
            并按「池号 + 取样日期」对在途计划重新串级核放；同一许可重送不产生重复放行。
          </p>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-[13px] text-slate-600">
              <span>池号（与台账按池号对齐）</span>
              <input
                class={INPUT}
                value={issueForm.pondCode}
                disabled={issueForm.supersedesId !== ''}
                onInput={(event) => setIssueForm('pondCode', event.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1 text-[13px] text-slate-600">
              <span>取样日期</span>
              <input
                type="date"
                class={INPUT}
                value={issueForm.sampledAt}
                disabled={issueForm.supersedesId !== ''}
                onInput={(event) => setIssueForm('sampledAt', event.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
              <span>许可放行量上限（m³）</span>
              <input
                type="number"
                step="10"
                class={INPUT}
                value={issueForm.approvedVolumeM3}
                onInput={(event) => setIssueForm('approvedVolumeM3', Number(event.currentTarget.value))}
              />
            </label>
          </div>
          <Show when={issueForm.supersedesId !== ''}>
            <p class="text-xs text-slate-500">
              换发后旧版本许可保留留痕，按旧许可放行的走水计划会立刻按新版本重新判定（计划量与池水位不动）。
            </p>
          </Show>
        </div>
      </AppDialog>
    </div>
  );
}

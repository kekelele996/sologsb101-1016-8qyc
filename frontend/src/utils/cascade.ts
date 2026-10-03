/**
 * 串级放行核算引擎（纯函数，不落库、不改任何业务数据）
 *
 * 规则：
 * 1. 受纳容量 = 面积 ×（有效水深 − 当前水位），末端池（无下游闸）不查容量，直放；
 * 2. 按串级顺序（orderIndex → 计划日期）逐条核，排在前面的先占下游余量，
 *    后面的计划必须按「被扣减后的余量」重新计算，余量不足即排队并写明差多少；
 * 3. 许可按「池号 + 取样日期」对化验室批准的现行版本，对不上就不放行；
 * 4. 核算只产出结论，计划量与池里水位一律不动。
 */
import type { Assay } from '../types/assay';
import type { ClearanceAllocation, ReleaseClearance } from '../types/clearance';
import type { DischargePermit } from '../types/permit';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Pond } from '../types/pond';
import type { Schedule } from '../types/schedule';
import { receivingCapacityM3 } from './brine';

const EPSILON = 0.05;

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 参与本次串级核算的一条计划（顺序已由调用方排好） */
export interface CascadeSchedule extends Schedule {
  /** 已排 / 走水中：先前已放行、水量已锁定，无条件占用下游余量 */
  committed: boolean;
}

export interface CascadeInput {
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: CascadeSchedule[];
  permits: DischargePermit[];
  decidedAt: string;
}

/** 某池在某次核算时的容量快照 */
interface PondCapacity {
  pondCode: string;
  capacityM3: number;
  remainingM3: number;
}

/** 取池当前水位：最近一次观测；无观测按满水（容量 0）保守处理 */
function latestLevelCm(observations: Observation[], pondId: string): number {
  const list = observations.filter((row) => row.pondId === pondId).sort((a, b) => a.date.localeCompare(b.date));
  const latest = list[list.length - 1];
  return latest === undefined ? Number.POSITIVE_INFINITY : latest.levelCm;
}

/** 取计划核放所依据的化验取样日期：不晚于计划日期的最近一次化验；没有则空串 */
export function matchedSampleDate(assays: Assay[], pondId: string, planDate: string): string {
  const list = assays
    .filter((row) => row.pondId === pondId && row.date <= planDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = list[list.length - 1];
  return latest === undefined ? '' : latest.date;
}

/** 现行有效许可：池号 + 取样日期一致、批准状态，取版本号最大者 */
export function findCurrentPermit(
  permits: DischargePermit[],
  pondCode: string,
  sampledAt: string,
): DischargePermit | null {
  if (sampledAt === '') return null;
  const candidates = permits
    .filter((permit) => permit.pondCode === pondCode && permit.sampledAt === sampledAt && permit.status === '批准')
    .sort((a, b) => b.version - a.version || b.issuedAt.localeCompare(a.issuedAt));
  return candidates[0] ?? null;
}

/** 同池号同取样日期是否存在已撤回的许可（用于区分「无有效许可」与「许可撤回」） */
function findRevokedPermit(permits: DischargePermit[], pondCode: string, sampledAt: string): DischargePermit | null {
  if (sampledAt === '') return null;
  const list = permits
    .filter((permit) => permit.pondCode === pondCode && permit.sampledAt === sampledAt && permit.status === '撤回')
    .sort((a, b) => b.version - a.version || b.issuedAt.localeCompare(a.issuedAt));
  return list[0] ?? null;
}

/** 派生核定记录 id：同一「计划 + 许可版本」恒为同一条，保证重算 / 重送幂等 */
export function clearanceId(scheduleId: string, permitId: string, sampledAt: string): string {
  const key = permitId === '' ? `none@${sampledAt || 'na'}` : permitId;
  return `cl-${scheduleId}--${key}`;
}

/** 计划的出流去向：非关闭闸，按开度权重分摊计划量 */
function downstreamRoutes(
  gates: Gate[],
  ponds: Pond[],
  fromPondId: string,
): Array<{ pondId: string; pondCode: string; weight: number }> {
  const out = gates.filter((gate) => gate.fromPondId === fromPondId && gate.state !== '关闭' && gate.openingPct > 0);
  const total = out.reduce((acc, gate) => acc + gate.openingPct, 0);
  if (total <= 0) return [];
  return out
    .map((gate) => {
      const pond = ponds.find((item) => item.id === gate.toPondId);
      return pond === undefined
        ? null
        : { pondId: pond.id, pondCode: pond.code, weight: gate.openingPct / total };
    })
    .filter((route): route is { pondId: string; pondCode: string; weight: number } => route !== null);
}

function shortfallText(allocations: ClearanceAllocation[]): string {
  return allocations
    .filter((item) => item.shortfallM3 > EPSILON)
    .map((item) => `${item.pondCode} 缺 ${round1(item.shortfallM3)} m³（余 ${round1(item.remainingM3)} m³）`)
    .join('；');
}

/**
 * 串级核算主入口：返回每条计划的放行核定。
 * 调用方负责只传入参与核算的计划（已出卤的不重判）并已排好串级顺序。
 */
export function adjudicateCascade(input: CascadeInput): ReleaseClearance[] {
  const { ponds, gates, observations, assays, schedules, permits, decidedAt } = input;

  const pondById = new Map(ponds.map((pond) => [pond.id, pond]));
  // 各池受纳容量账本：第一次遇到该池时按面积与当前水位建账，之后只减不增
  const ledger = new Map<string, PondCapacity>();

  function capacityOf(pondId: string): PondCapacity {
    let entry = ledger.get(pondId);
    if (entry === undefined) {
      const pond = pondById.get(pondId);
      const levelCm = latestLevelCm(observations, pondId);
      const capacityM3 = pond === undefined ? 0 : receivingCapacityM3(pond.areaM2, pond.depthCm, levelCm);
      entry = { pondCode: pond?.code ?? '（池已删除）', capacityM3, remainingM3: capacityM3 };
      ledger.set(pondId, entry);
    }
    return entry;
  }

  let queueRank = 0;
  const results: ReleaseClearance[] = [];

  schedules.forEach((schedule) => {
    const pond = pondById.get(schedule.pondId);
    const pondCode = pond?.code ?? '';
    const sampledAt = matchedSampleDate(assays, schedule.pondId, schedule.planDate);
    const permit = findCurrentPermit(permits, pondCode, sampledAt);
    const revoked = findRevokedPermit(permits, pondCode, sampledAt);
    const planned = round1(schedule.volumeM3);
    const baseId = clearanceId(schedule.id, permit?.id ?? '', sampledAt);

    const base: ReleaseClearance = {
      id: baseId,
      scheduleId: schedule.id,
      pondCode,
      planDate: schedule.planDate,
      sampledAt,
      plannedVolumeM3: planned,
      permitId: permit?.id ?? '',
      permitNo: permit?.permitNo ?? '',
      permitVersion: permit?.version ?? 0,
      decision: '无有效许可',
      queueRank: 0,
      shortfallM3: 0,
      allocations: [],
      reason: '',
      active: true,
      decidedAt,
      createdAt: decidedAt,
      updatedAt: decidedAt,
      revision: 1,
    };

    const committedSuffix = schedule.committed
      ? '该计划已放行走水，此为许可变动后的重判提示；计划量与池水位均不改动。'
      : '';

    // 1) 先核许可 —— 化验室系统是放行前置条件
    if (permit === null) {
      const decision = revoked !== null ? '许可撤回' : '无有效许可';
      const why =
        sampledAt === ''
          ? `池号 ${pondCode} 在计划日期 ${schedule.planDate} 前没有化验取样记录，无法按池号 + 取样日期对上出卤许可`
          : revoked !== null
            ? `池号 ${pondCode}、取样日期 ${sampledAt} 的出卤许可已被化验室撤回（原许可 ${revoked.permitNo}）`
            : `池号 ${pondCode}、取样日期 ${sampledAt} 在化验室系统中查不到批准的现行出卤许可`;
      results.push({
        ...base,
        decision,
        reason: committedSuffix === '' ? why : `${why}。${committedSuffix}`,
      });
      return;
    }

    // 2) 许可批准量上限：待排计划量超出许可批量时排队（已放走的不拦，只留重判提示）
    if (!schedule.committed && planned > permit.approvedVolumeM3 + EPSILON) {
      const permitGap = round1(planned - permit.approvedVolumeM3);
      queueRank += 1;
      results.push({
        ...base,
        decision: '排队',
        queueRank,
        shortfallM3: permitGap,
        reason:
          `许可 ${permit.permitNo}（v${permit.version}）批准量上限为 ${round1(permit.approvedVolumeM3)} m³，` +
          `本计划 ${planned} m³ 超出许可 ${permitGap} m³，按串级顺序排第 ${queueRank} 位，请向化验室申请换发；计划量与池水位不动。`,
      });
      return;
    }

    // 3) 末端池（无下游通道）：许可有效即放行，不占容量
    const routes = downstreamRoutes(gates, ponds, schedule.pondId);
    if (routes.length === 0) {
      results.push({
        ...base,
        decision: '放行',
        reason:
          `许可 ${permit.permitNo}（v${permit.version}）批准放行 ${planned} m³；` +
          `该池为串级末端，无下游受纳池，按许可直放。` +
          (committedSuffix === '' ? '' : committedSuffix),
      });
      return;
    }

    // 4) 串级容量：按开度权重把计划量分到各下游，逐池扣减先放行计划占掉的余量
    const allocations: ClearanceAllocation[] = routes.map((route) => {
      const cap = capacityOf(route.pondId);
      const want = round1(planned * route.weight);
      const allocated = round1(Math.min(want, Math.max(0, cap.remainingM3)));
      const shortfall = round1(Math.max(0, want - cap.remainingM3));
      return {
        pondCode: route.pondCode,
        capacityM3: round1(cap.capacityM3),
        remainingM3: round1(cap.remainingM3),
        allocatedM3: allocated,
        shortfallM3: shortfall,
      };
    });

    const totalShortfall = round1(allocations.reduce((acc, item) => acc + item.shortfallM3, 0));
    const hasShortfall = totalShortfall > EPSILON;

    // 已放行走水的计划：水量事实上已经走掉，按实占扣减余量（宁可超占也要把账记实）；
    // 待排计划只占用「能接住」的部分，缺口排队，不硬扣成负数。
    routes.forEach((route, index) => {
      const cap = capacityOf(route.pondId);
      cap.remainingM3 = round1(cap.remainingM3 - (schedule.committed ? round1(planned * route.weight) : allocations[index].allocatedM3));
    });

    if (hasShortfall) {
      queueRank += 1;
      const detail = shortfallText(allocations);
      results.push({
        ...base,
        decision: '排队',
        queueRank,
        shortfallM3: totalShortfall,
        allocations,
        reason:
          `许可 ${permit.permitNo}（v${permit.version}）有效，但串级下游受纳容量不足：${detail}，` +
          `计划量 ${planned} m³ 合计差 ${totalShortfall} m³，按串级顺序排第 ${queueRank} 位候放；计划量与池水位不动。`,
      });
      return;
    }

    results.push({
      ...base,
      decision: '放行',
      allocations,
      reason:
        `许可 ${permit.permitNo}（v${permit.version}）批准放行 ${planned} m³；` +
        `下游受纳余量 ${allocations.map((item) => `${item.pondCode} 余 ${item.remainingM3} m³`).join('、')}，本笔占用后已重算。` +
        (committedSuffix === '' ? '' : committedSuffix),
    });
  });

  return results;
}

/**
 * 串级放行核算（纯函数，不落库、不改任何业务数据）
 *
 * 规则：
 * 1. 放行先核化验室出卤许可：按「池号 + 取样日期」对上，仅认「现行有效」且
 *    「准予放行」的许可；取样日期不得晚于计划走水日期。
 * 2. 再核下游受纳容量：受纳容量 = 蒸发池面积 ×（可用水深 − 当前水位），
 *    当前水位取该池最近一次卤水日观测。
 * 3. 走水计划按 orderIndex 串级顺序逐条核：排在前面且「已放行」的计划先占用
 *    下游余量，排在后面的计划必须在扣减后的余量上重算，余量不足即排队，
 *    并写明差多少方、卡在哪口下游池。
 * 4. 排队计划不占容量、不改动计划量，也不回写任何池的水位。
 * 5. 末端池（没有开启的下游闸）只核许可，不核受纳容量。
 *
 * 保守约定：同一轮编排里只计「下游进水」，不计下游池自身再放出腾出的空间，
 * 避免把还没走成的水重复算两遍。
 */
import type { Gate } from '../types/gate';
import type { LabPermit } from '../types/permit';
import type { Observation } from '../types/observation';
import type { Pond } from '../types/pond';
import type { ClearanceStatus, Schedule } from '../types/schedule';
import { pondVolumeM3 } from './brine';

/** 单条走水计划的放行核算结果（字段与 Schedule 上的缓存判定一一对应） */
export interface ClearanceResult {
  scheduleId: string
  clearance: ClearanceStatus
  permitId: string
  permitVersion: number
  note: string
  waitingForPondId: string
  shortfallM3: number
}

export interface ClearanceInput {
  ponds: Pond[]
  gates: Gate[]
  observations: Observation[]
  schedules: Schedule[]
  permits: LabPermit[]
}

/** 保留 1 位小数 */
function r1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 池内当前存卤量（m³）= 面积 × 最近观测水位 */
export function storedVolumeM3(pond: Pond, latestObs: Observation | null): number {
  if (latestObs === null) return 0;
  return r1(pond.areaM2 * (Math.max(0, latestObs.levelCm) / 100));
}

/**
 * 受纳余量（m³）= 面积 ×（可用水深 − 当前水位）/100。
 * 返回 null 表示无法给出余量（池非在用 / 缺少水位观测），reason 说明原因。
 */
export function freeCapacityM3(
  pond: Pond,
  latestObs: Observation | null,
): { value: number | null; reason: string } {
  if (pond.status !== '在用') {
    return { value: null, reason: `下游 ${pond.code} 当前为「${pond.status}」，不具备受纳条件` };
  }
  if (latestObs === null) {
    return { value: null, reason: `下游 ${pond.code} 缺少水位观测，受纳余量按 0 计` };
  }
  const usable = pondVolumeM3(pond.areaM2, pond.depthCm);
  const stored = storedVolumeM3(pond, latestObs);
  return { value: r1(Math.max(0, usable - stored)), reason: '' };
}

/**
 * 按「池号 + 取样日期」匹配计划走水日期当天可用的现行许可：
 * 取 sampleDate ≤ planDate 中取样日期最新、版本号最大的一条。
 */
export function matchPermit(
  pond: Pond,
  planDate: string,
  permits: LabPermit[],
): { permit: LabPermit | null; superseded: boolean } {
  const samePond = permits.filter((item) => item.pondCode === pond.code);
  const current = samePond
    .filter((item) => item.status === '现行有效' && item.sampleDate <= planDate)
    .sort((a, b) => b.sampleDate.localeCompare(a.sampleDate) || b.version - a.version);
  if (current.length === 0) {
    // 有过该池号的许可但全部已换发：提示按旧许可放行的已失效
    const hadOld = samePond.some((item) => item.status === '已换发');
    return { permit: null, superseded: hadOld };
  }
  return { permit: current[0], superseded: false };
}

/** 每口池最近一次观测（按日期） */
function latestObservationMap(observations: Observation[]): Map<string, Observation> {
  const map = new Map<string, Observation>();
  observations.forEach((row) => {
    const held = map.get(row.pondId);
    if (held === undefined || row.date > held.date) map.set(row.pondId, row);
  });
  return map;
}

/** 已出卤的计划沿用既有判定，不参与本轮串级容量重算 */
function keepExisting(schedule: Schedule): ClearanceResult {
  return {
    scheduleId: schedule.id,
    clearance: schedule.clearance ?? '已放行',
    permitId: schedule.permitId ?? '',
    permitVersion: schedule.permitVersion ?? 0,
    note: schedule.clearanceNote ?? '已出卤计划沿用当时的放行判定',
    waitingForPondId: schedule.waitingForPondId ?? '',
    shortfallM3: schedule.shortfallM3 ?? 0,
  };
}

/**
 * 串级顺序逐条核算放行。
 * 已放行计划按闸门顺序把计划量 greedy 分配到各受纳池并累计占用；
 * 任一受纳池扣减累计占用后的余量不足，则整条计划排队（全有或全无，不部分占用）。
 */
export function evaluateClearance(input: ClearanceInput): ClearanceResult[] {
  const { ponds, gates, observations, schedules, permits } = input;
  const pondMap = new Map(ponds.map((pond) => [pond.id, pond]));
  const obsMap = latestObservationMap(observations);
  /** pondId -> 已被排在前面的放行计划累计占用的受纳量 */
  const occupied = new Map<string, number>();

  const ordered = [...schedules].sort(
    (a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate),
  );

  return ordered.map((schedule) => {
    if (schedule.state === '已出卤') return keepExisting(schedule);

    const pond = pondMap.get(schedule.pondId);
    if (pond === undefined) {
      return failed(schedule, '关联蒸发池已删除，无法核对放行');
    }

    // ---------- 第一步：核化验室出卤许可（池号 + 取样日期） ----------
    const matched = matchPermit(pond, schedule.planDate, permits);
    if (matched.permit === null) {
      return failed(
        schedule,
        matched.superseded
          ? `化验室旧许可已换发，${pond.code}（取样 ${schedule.planDate} 前）需按新许可重新判定`
          : `化验室未签发 ${pond.code} 在 ${schedule.planDate} 之前取样的现行出卤许可`,
      );
    }
    const permit = matched.permit;
    if (permit.verdict === '不予放行') {
      return {
        scheduleId: schedule.id,
        clearance: '未达标',
        permitId: permit.id,
        permitVersion: permit.version,
        note: `化验室许可 ${permit.id} 判定不予放行${permit.reason === '' ? '' : `：${permit.reason}`}`,
        waitingForPondId: '',
        shortfallM3: 0,
      };
    }

    // ---------- 第二步：核下游串级受纳容量 ----------
    const downstreamGates = gates
      .filter((gate) => gate.fromPondId === pond.id && gate.state !== '关闭' && gate.openingPct > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
    const targetIds = Array.from(new Set(downstreamGates.map((gate) => gate.toPondId)));

    if (targetIds.length === 0) {
      return {
        scheduleId: schedule.id,
        clearance: '已放行',
        permitId: permit.id,
        permitVersion: permit.version,
        note: `许可 ${permit.id}（取样 ${permit.sampleDate}）现行有效；末端出卤无下游受纳池，仅核许可`,
        waitingForPondId: '',
        shortfallM3: 0,
      };
    }

    // 先算每条下游通道在扣减前面计划占用后的余量（不落库，仅本轮核算用）
    let need = r1(Math.max(0, schedule.volumeM3));
    let blockingPondId = '';
    let blockingCode = '';
    const detail: string[] = [];
    for (const targetId of targetIds) {
      const target = pondMap.get(targetId);
      if (target === undefined) continue;
      const cap = freeCapacityM3(target, obsMap.get(targetId) ?? null);
      const used = occupied.get(targetId) ?? 0;
      if (cap.value === null) {
        return {
          scheduleId: schedule.id,
          clearance: '排队中',
          permitId: permit.id,
          permitVersion: permit.version,
          note: `${cap.reason}，计划 ${r1(schedule.volumeM3)} m³ 暂不能放行`,
          waitingForPondId: targetId,
          shortfallM3: need,
        };
      }
      const remaining = r1(Math.max(0, cap.value - used));
      const take = r1(Math.min(need, remaining));
      detail.push(`${target.code} 余量 ${remaining} m³`);
      if (need > 0) {
        blockingPondId = targetId;
        blockingCode = target.code;
      }
      need = r1(need - take);
      if (need <= 0) break;
    }

    if (need > 0) {
      // 容量不足：整条排队，不占用任何下游余量，计划量与池水位均不动
      return {
        scheduleId: schedule.id,
        clearance: '排队中',
        permitId: permit.id,
        permitVersion: permit.version,
        note: `许可有效；按串级顺序核算下游受纳不足（${detail.join('、') || '无可用下游通道'}），${blockingCode} 还差 ${need} m³`,
        waitingForPondId: blockingPondId,
        shortfallM3: need,
      };
    }

    // 容量核足：才把计划量累计占用到下游池，供排在后面的串级重算
    let alloc = r1(Math.max(0, schedule.volumeM3));
    for (const targetId of targetIds) {
      if (alloc <= 0) break;
      const target = pondMap.get(targetId);
      if (target === undefined) continue;
      const cap = freeCapacityM3(target, obsMap.get(targetId) ?? null);
      if (cap.value === null) continue;
      const remaining = r1(Math.max(0, cap.value - (occupied.get(targetId) ?? 0)));
      const take = r1(Math.min(alloc, remaining));
      occupied.set(targetId, r1((occupied.get(targetId) ?? 0) + take));
      alloc = r1(alloc - take);
    }

    return {
      scheduleId: schedule.id,
      clearance: '已放行',
      permitId: permit.id,
      permitVersion: permit.version,
      note: `许可 ${permit.id}（取样 ${permit.sampleDate}）有效；${detail.join('、')}，受纳容量核足`,
      waitingForPondId: '',
      shortfallM3: 0,
    };
  });
}

function failed(schedule: Schedule, note: string): ClearanceResult {
  return {
    scheduleId: schedule.id,
    clearance: '未达标',
    permitId: '',
    permitVersion: 0,
    note,
    waitingForPondId: '',
    shortfallM3: 0,
  };
}

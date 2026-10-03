/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { DischargePermit } from '../types/permit';
import type { ReleaseClearance } from '../types/clearance';
import { estimateEvapMm } from './brine';
import { nowIso } from './id';
import { seedDatabase, seedLabPermits } from './seed';
import { pullPermitsSince, listLabPermits } from './labClient';
import { adjudicateCascade } from './cascade';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

/** 许可同步游标在 localStorage 的键（记录已成功拉到化验室的哪个签发时间） */
export const PERMIT_CURSOR_KEY = 'gbbrinepond:permitCursor';

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  /** 化验室出卤许可的同步镜像（台账只读，写操作只来自同步） */
  permits!: Table<DischargePermit, string>;
  /** 串级放行核定台账（只追加结论，不动计划量与水位） */
  clearances!: Table<ReleaseClearance, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：化验室出卤许可镜像 + 串级放行核定（新表，旧记录无需迁移） ----------
    this.version(DB_SCHEMA_VERSION).stores({
      permits: 'id, permitNo, [pondCode+sampledAt], status, version, supersedesId, syncState, syncedAt',
      clearances: 'id, scheduleId, permitId, decision, active, queueRank, decidedAt',
    });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
      // 化验室许可在另一套系统（独立库）：先确保演示许可存在，再首次同步进台账镜像
      await seedLabPermits();
      await syncPermitsFromLab().catch(() => {
        /* 化验室暂时不可达不阻断台账使用，调度页可手动重试同步 */
      });
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划及其放行核定（许可镜像属化验室，不动） */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.clearances],
    async () => {
    const gates = await db.gates.toArray();
    const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
    if (related.length > 0) await db.gates.bulkDelete(related);
    await db.observations.where('pondId').equals(id).delete();
    await db.assays.where('pondId').equals(id).delete();
    const removedSchedules = await db.schedules.where('pondId').equals(id).toArray();
    await db.schedules.where('pondId').equals(id).delete();
    await Promise.all(removedSchedules.map((row) => db.clearances.where('scheduleId').equals(row.id).delete()));
    await db.ponds.delete(id);
  });
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* --------------------------- 化验室出卤许可（同步镜像，只读） --------------------------- */

function readCursor(): string {
  try {
    return window.localStorage.getItem(PERMIT_CURSOR_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeCursor(value: string): void {
  try {
    window.localStorage.setItem(PERMIT_CURSOR_KEY, value);
  } catch {
    /* 隐私模式下降级：本次只少了增量游标，不影响落库幂等 */
  }
}

export async function listPermits(): Promise<DischargePermit[]> {
  const rows = await db.permits.toArray();
  return rows.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

export interface SyncPermitsResult {
  /** 本次成功落库的许可条数 */
  fetched: number;
  /** 同步是否失败（失败时调用方应稍后重试，游标不前移） */
  failed: boolean;
  message: string;
}

/**
 * 从化验室系统同步出卤许可到台账镜像。
 * - 增量游标：只在本批成功落库后前移，同步失败后重试会重新从化验室取本批；
 * - 幂等：镜像按许可号主键覆盖，同一批重送不产生重复许可，也不产生重复放行；
 * - 台账只读语义：这里是唯一的镜像写入入口，任何页面都不能直接改许可内容。
 */
export async function syncPermitsFromLab(): Promise<SyncPermitsResult> {
  const cursor = readCursor();
  let pulled: Awaited<ReturnType<typeof pullPermitsSince>>;
  try {
    pulled = await pullPermitsSince(cursor);
  } catch (err) {
    return {
      fetched: 0,
      failed: true,
      message: err instanceof Error ? err.message : '化验室系统同步失败，请重试',
    };
  }

  const stamp = nowIso();
  let maxIssuedAt = cursor;
  await db.transaction('rw', db.permits, async () => {
    for (const source of pulled.permits) {
      // 同一许可号即同一张许可：重送只刷新同步状态，不新增行
      const existing = await db.permits.get(source.id);
      const mirror: DischargePermit = {
        ...source,
        syncState: '已同步',
        syncedAt: stamp,
        syncError: '',
        syncAttempts: (existing?.syncAttempts ?? 0) + 1,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      await db.permits.put(mirror);
      if (source.issuedAt > maxIssuedAt) maxIssuedAt = source.issuedAt;
    }
  });
  writeCursor(maxIssuedAt);

  // 游标只覆盖「新签发」的许可；对已镜像许可还要按化验室原件刷新状态，
  // 否则化验室撤回一张旧许可时，增量批次为空，台账永远感知不到撤回。
  // 镜像按主键覆盖、天然幂等：重送不会多出许可或放行。
  const mirrors = await db.permits.toArray();
  let permitChanged = pulled.fetched > 0;
  if (mirrors.length > 0) {
    const labRows = await listLabPermits();
    const labById = new Map(labRows.map((row) => [row.id, row]));
    const refreshStamp = nowIso();
    await db.transaction('rw', db.permits, async () => {
      for (const mirror of mirrors) {
        const source = labById.get(mirror.id);
        if (source === undefined) continue;
        if (source.status !== mirror.status || source.version !== mirror.version || source.approvedVolumeM3 !== mirror.approvedVolumeM3) {
          permitChanged = true;
          await db.permits.put({
            ...mirror,
            ...source,
            syncState: '已同步',
            syncedAt: refreshStamp,
            syncError: '',
            updatedAt: refreshStamp,
            revision: ROW_REVISION,
          });
        }
      }
    });
  }

  // 许可有变化（新许可或状态刷新）：统一按现行许可重新串级核放
  if (permitChanged) {
    await reAdjudicateClearances();
  }
  return {
    fetched: pulled.fetched,
    failed: false,
    message: pulled.fetched === 0 ? '化验室许可已是最新，无新增许可' : `已从化验室同步 ${pulled.fetched} 张许可，并按串级重新核放`,
  };
}

/* ------------------------------ 串级放行核定（只追加结论） ------------------------------ */

export async function listClearances(): Promise<ReleaseClearance[]> {
  return db.clearances.toArray();
}

/**
 * 按当前台账数据 + 化验室许可镜像，把全部在途走水计划（待排 / 已排 / 走水中）
 * 按串级顺序重新核一遍。
 *
 * - 已出卤的历史计划不重判；
 * - 新许可版本出现后，按旧许可放行的旧核定置 active=false（结论改「已作废」），
 *   现行核定按新许可重算 —— 计划量与池水位一概不动；
 * - 同一「计划 + 许可版本」核定 id 恒定，重复执行不多出行。
 */
export async function reAdjudicateClearances(): Promise<ReleaseClearance[]> {
  const [ponds, gates, observations, assays, schedules, permits] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.permits.where('syncState').equals('已同步').toArray(),
  ]);

  // 已出卤的历史计划不重判；已排 / 走水中按已锁定水量占用串级余量
  const activeStates = ['待排', '已排', '走水中'];
  const ordered = schedules
    .filter((row) => activeStates.includes(row.state))
    .sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate))
    .map((row) => ({ ...row, committed: row.state === '已排' || row.state === '走水中' }));

  const stamp = nowIso();
  const nextRows = adjudicateCascade({
    ponds,
    gates,
    observations,
    assays,
    schedules: ordered,
    permits,
    decidedAt: stamp,
  });
  const nextIds = new Set(nextRows.map((row) => row.id));

  await db.transaction('rw', db.clearances, async () => {
    const existing = await db.clearances.toArray();
    // 同计划的旧版本核定（如旧许可放行）：未被本次结果覆盖的，留痕作废
    for (const row of existing) {
      if (row.active && !nextIds.has(row.id)) {
        await db.clearances.update(row.id, {
          active: false,
          decision: '已作废',
          queueRank: 0,
          updatedAt: stamp,
        });
      }
    }
    for (const row of nextRows) {
      const old = await db.clearances.get(row.id);
      await db.clearances.put({
        ...row,
        createdAt: old?.createdAt ?? stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      });
    }
  });

  return nextRows;
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
  /** 化验室许可镜像（只读快照） */
  permits: DischargePermit[];
  /** 串级放行核定台账 */
  clearances: ReleaseClearance[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, permits, clearances] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.permits.toArray(),
    db.clearances.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    ponds,
    gates,
    observations,
    assays,
    schedules,
    permits,
    clearances,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.permits, db.clearances],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.permits.clear(),
        db.clearances.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
      // 旧版存档可能没有这两张表，缺省按空数组处理
      await db.permits.bulkPut((snapshot.permits ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.clearances.bulkPut((snapshot.clearances ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.permits, db.clearances],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.permits.clear(),
        db.clearances.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, permits, clearances] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.permits.count(),
    db.clearances.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, permits, clearances };
}

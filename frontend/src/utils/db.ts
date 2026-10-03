/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：新增 labPermits（化验室出卤许可只读镜像）/ syncBatches（同步批次）表，
 *   schedules 增加串级放行判定字段并为旧记录补齐
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import type { LabPermit, SyncBatch } from '../types/permit';
import { estimateEvapMm } from './brine';
import { evaluateClearance, type ClearanceResult } from './clearance';
import { nowIso } from './id';
import { seedDatabase } from './seed';
import { LAB_INITIAL_BATCH_NO, LAB_INITIAL_SYNC_BATCH_ID, initialLabPermits } from './labAdapter';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  /** 化验室出卤许可（外部系统只读镜像） */
  labPermits!: Table<LabPermit, string>;
  /** 许可同步批次（成功 / 失败重试） */
  syncBatches!: Table<SyncBatch, string>;

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
    this.version(2).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
      gates: 'id, fromPondId, toPondId, state, openingPct',
      observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
      assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v3：化验室许可镜像 + 同步批次 + 走水串级放行判定字段 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, clearance',
        labPermits: 'id, pondCode, sampleDate, status, verdict, [pondCode+sampleDate], version',
        syncBatches: 'id, remoteBatchNo, state, syncedAt',
      })
      .upgrade(async (tx) => {
        // 迁移 1（沿用 v2）：补齐 revision / createdAt / updatedAt
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
        // 迁移 2（沿用 v2）：卤水观测新增 evapMm
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3（沿用 v2）：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4（沿用 v2）：走水编排补齐排序序号
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
        // 迁移 5（v3 新增）：走水计划补齐串级放行判定字段
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.clearance !== 'string') row.clearance = '未达标';
          if (typeof row.permitId !== 'string') row.permitId = '';
          if (typeof row.permitVersion !== 'number') row.permitVersion = 0;
          if (typeof row.clearanceNote !== 'string') {
            row.clearanceNote = 'v3 升级前的旧计划，尚未按串级受纳容量核算，请重算放行';
          }
          if (typeof row.waitingForPondId !== 'string') row.waitingForPondId = '';
          if (typeof row.shortfallM3 !== 'number') row.shortfallM3 = 0;
          if (typeof row.clearanceCheckedAt !== 'string') row.clearanceCheckedAt = '';
        });
        // 迁移 6（v3 新增）：镜像化验室首批出卤许可并补一条初次拉取批次
        const permitCount = await tx.table('labPermits').count();
        if (permitCount === 0) {
          await tx.table('labPermits').bulkAdd(initialLabPermits());
          const stamp = nowIso();
          await tx.table('syncBatches').bulkAdd([
            {
              id: LAB_INITIAL_SYNC_BATCH_ID,
              remoteBatchNo: LAB_INITIAL_BATCH_NO,
              action: '初次拉取',
              state: '同步成功',
              permitCount: initialLabPermits().length,
              matchedCount: initialLabPermits().length,
              errorMessage: '',
              syncedAt: stamp,
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            } satisfies SyncBatch,
          ]);
        }
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
  await recomputeClearance();
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划与许可镜像 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.labPermits],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.schedules.where('pondId').equals(id).delete();
      await db.ponds.delete(id);
    },
  );
  await recomputeClearance();
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
  await recomputeClearance();
}

/** 就地调整开度：同步推导闸门状态，并按新的串级走向重算放行 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
  await recomputeClearance();
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
  await recomputeClearance();
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
 * 水位变化会影响下游受纳余量，写入后重算串级放行。
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
  await recomputeClearance();
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
  await recomputeClearance();
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
  await recomputeClearance();
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
  await recomputeClearance();
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用），随后整条串级链路重算放行 */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
  await recomputeClearance();
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
  await recomputeClearance();
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: Schedule['state'], actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
  await recomputeClearance();
}

/* --------------------------- 串级放行核算（重算） --------------------------- */

/**
 * 按当前池 / 闸 / 观测 / 许可 / 走水计划全量重算串级放行，
 * 只回写 schedules 上的判定字段；计划量与池水位一律不动。
 */
export async function recomputeClearance(): Promise<ClearanceResult[]> {
  return db.transaction(
    'rw',
    db.schedules,
    db.ponds,
    db.gates,
    db.observations,
    db.labPermits,
    async () => {
      const [ponds, gates, observations, schedules, permits] = await Promise.all([
        db.ponds.toArray(),
        db.gates.toArray(),
        db.observations.toArray(),
        db.schedules.toArray(),
        db.labPermits.toArray(),
      ]);
      const results = evaluateClearance({ ponds, gates, observations, schedules, permits });
      const checkedAt = nowIso();
      for (const result of results) {
        await db.schedules.update(result.scheduleId, {
          clearance: result.clearance,
          permitId: result.permitId,
          permitVersion: result.permitVersion,
          clearanceNote: result.note,
          waitingForPondId: result.waitingForPondId,
          shortfallM3: result.shortfallM3,
          clearanceCheckedAt: checkedAt,
          updatedAt: checkedAt,
        });
      }
      return results;
    },
  );
}

/* ------------------------ 化验室许可镜像与同步批次 ------------------------ */

export async function listLabPermits(): Promise<LabPermit[]> {
  const rows = await db.labPermits.toArray();
  return rows.sort((a, b) => b.issuedDate.localeCompare(a.issuedDate) || b.version - a.version);
}

export async function listSyncBatches(): Promise<SyncBatch[]> {
  const rows = await db.syncBatches.toArray();
  return rows.sort((a, b) => b.syncedAt.localeCompare(a.syncedAt));
}

/** 最近一次同步成功的化验室批次号（没有则取首批号） */
export async function latestSyncedBatchNo(): Promise<number> {
  const rows = await db.syncBatches.where('state').equals('同步成功').toArray();
  if (rows.length === 0) return LAB_INITIAL_BATCH_NO;
  return rows.reduce((max, row) => Math.max(max, row.remoteBatchNo), LAB_INITIAL_BATCH_NO);
}

export interface ApplyLabSyncResult {
  batch: SyncBatch;
  /** 同一批次已成功同步过时为 false（幂等：重送不重复落库、不多出放行） */
  changed: boolean;
  results: ClearanceResult[];
}

/**
 * 落化验室同步结果：
 * - 同一 remoteBatchNo 已成功同步过 → 直接返回，不重复镜像、不重复重算；
 * - 成功：镜像许可（旧 id 覆盖为「已换发」、新 id 新增），登记批次，重算放行；
 * - 失败：只登记失败批次，不动许可与放行。
 */
export async function applyLabSync(
  remoteBatchNo: number,
  permits: LabPermit[],
  action: string,
): Promise<ApplyLabSyncResult> {
  const batchId = `sync-${remoteBatchNo}`;
  return db.transaction(
    'rw',
    [db.labPermits, db.syncBatches, db.schedules, db.ponds, db.gates, db.observations],
    async () => {
      const existing = await db.syncBatches.get(batchId);
    const stamp = nowIso();
    if (existing?.state === '同步成功') {
      return { batch: existing, changed: false, results: [] };
    }
    const pondCodes = new Set((await db.ponds.toArray()).map((pond) => pond.code));
    const matchedCount = permits.filter((permit) => permit.status === '现行有效' && pondCodes.has(permit.pondCode)).length;
    for (const permit of permits) {
      await db.labPermits.put({
        ...permit,
        lastSyncBatchId: batchId,
        updatedAt: stamp,
        revision: ROW_REVISION,
      });
    }
    const batch: SyncBatch = {
      id: batchId,
      remoteBatchNo,
      action,
      state: '同步成功',
      permitCount: permits.length,
      matchedCount,
      errorMessage: '',
      syncedAt: stamp,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.syncBatches.put(batch);

    // 许可可能换发：按新许可全量重算串级放行（旧许可放行的计划会被重新判定）
    const [ponds, gates, observations, schedules, currentPermits] = await Promise.all([
      db.ponds.toArray(),
      db.gates.toArray(),
      db.observations.toArray(),
      db.schedules.toArray(),
      db.labPermits.toArray(),
    ]);
    const results = evaluateClearance({ ponds, gates, observations, schedules, permits: currentPermits });
    for (const result of results) {
      await db.schedules.update(result.scheduleId, {
        clearance: result.clearance,
        permitId: result.permitId,
        permitVersion: result.permitVersion,
        clearanceNote: result.note,
        waitingForPondId: result.waitingForPondId,
        shortfallM3: result.shortfallM3,
        clearanceCheckedAt: stamp,
        updatedAt: stamp,
      });
    }
    return { batch, changed: true, results };
    },
  );
}

/** 登记一次同步失败（重试时仍写入同一批次 id，成功后覆盖为成功） */
export async function recordSyncFailure(
  remoteBatchNo: number,
  action: string,
  errorMessage: string,
): Promise<SyncBatch> {
  const batchId = `sync-${remoteBatchNo}`;
  const stamp = nowIso();
  const existing = await db.syncBatches.get(batchId);
  const batch: SyncBatch = {
    id: batchId,
    remoteBatchNo,
    action,
    state: '同步失败',
    permitCount: existing?.permitCount ?? 0,
    matchedCount: existing?.matchedCount ?? 0,
    errorMessage,
    syncedAt: stamp,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await db.syncBatches.put(batch);
  return batch;
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
  labPermits: LabPermit[];
  syncBatches: SyncBatch[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, labPermits, syncBatches] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.labPermits.toArray(),
    db.syncBatches.toArray(),
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
    labPermits,
    syncBatches,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.labPermits, db.syncBatches],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.labPermits.clear(),
        db.syncBatches.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
      // v2 及更早的存档没有许可镜像，导入后为空，放行判定会提示「未签发许可」
      await db.labPermits.bulkPut((snapshot.labPermits ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.syncBatches.bulkPut((snapshot.syncBatches ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
  await recomputeClearance();
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.labPermits, db.syncBatches],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.labPermits.clear(),
        db.syncBatches.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, labPermits, syncBatches] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.labPermits.count(),
    db.syncBatches.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, labPermits, syncBatches };
}

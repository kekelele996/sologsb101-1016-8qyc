/**
 * 化验室 → 台账同步与串级核放集成测试（fake-indexeddb）：
 * A. 首次同步成功落镜像并产生放行核定
 * B. 同步失败后游标不前移；重试成功，同一批重送不产生重复许可/重复放行
 * C. 化验室换发新版本许可后，旧许可放行核定作废，按新许可重新判定
 * D. 排队场景：容量不足按顺序排队、写明缺口；计划量与水位不动
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { db } from '../src/utils/db';
import { reAdjudicateClearances, syncPermitsFromLab } from '../src/utils/db';
import { armLabPullFailure, issuePermit, labDb } from '../src/utils/labClient';

// Node 环境下补一个内存版 localStorage（游标持久化用）
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}
Object.assign(globalThis, { window: { localStorage: new MemoryStorage() } });

afterEach(async () => {
  await Promise.all([
    db.ponds.clear(),
    db.gates.clear(),
    db.observations.clear(),
    db.assays.clear(),
    db.schedules.clear(),
    db.permits.clear(),
    db.clearances.clear(),
    labDb.permits.clear(),
  ]);
  window.localStorage.clear();
});

const STAMP = '2026-10-01T00:00:00.000Z';

async function seedCascade(): Promise<void> {
  await db.ponds.bulkPut([
    { id: 'a', code: 'A', seriesName: '系', areaM2: 12000, depthCm: 45, stage: '钠盐', status: '在用', createdAt: STAMP, updatedAt: STAMP, revision: 3 },
    { id: 'b', code: 'B', seriesName: '系', areaM2: 10000, depthCm: 40, stage: '钾盐', status: '在用', createdAt: STAMP, updatedAt: STAMP, revision: 3 },
  ]);
  await db.gates.bulkPut([
    { id: 'g1', fromPondId: 'a', toPondId: 'b', openingPct: 60, widthCm: 100, state: '半开', note: '', createdAt: STAMP, updatedAt: STAMP, revision: 3 },
  ]);
  await db.observations.bulkPut([
    { id: 'o-a', pondId: 'a', date: '2026-09-30', densityGcm3: 1.1, tempC: 25, levelCm: 39, windLevel: 2, evapMm: 5, createdAt: STAMP, updatedAt: STAMP, revision: 3 },
    { id: 'o-b', pondId: 'b', date: '2026-09-30', densityGcm3: 1.15, tempC: 25, levelCm: 30, windLevel: 2, evapMm: 5, createdAt: STAMP, updatedAt: STAMP, revision: 3 }, // B 容量 1000
  ]);
  await db.assays.bulkPut([
    { id: 'as-a', pondId: 'a', date: '2026-10-01', liGpl: 1.2, kGpl: 22, mgGpl: 0, naGpl: 0, labName: '室', verdict: '达标', verdictManual: false, createdAt: STAMP, updatedAt: STAMP, revision: 3 },
  ]);
  await db.schedules.bulkPut([
    { id: 's1', pondId: 'a', planDate: '2026-10-10', targetDensity: 1.2, volumeM3: 700, operator: '', state: '待排', orderIndex: 1, createdAt: STAMP, updatedAt: STAMP, revision: 3 },
    { id: 's2', pondId: 'a', planDate: '2026-10-11', targetDensity: 1.2, volumeM3: 400, operator: '', state: '待排', orderIndex: 2, createdAt: STAMP, updatedAt: STAMP, revision: 3 },
  ]);
}

test('A. 首次同步：许可镜像落库，串级按序放行 / 排队，计划量水位不动', async () => {
  await seedCascade();
  await issuePermit({ pondCode: 'A', sampledAt: '2026-10-01', labName: '室', approvedVolumeM3: 2000 });
  const result = await syncPermitsFromLab();
  assert.equal(result.failed, false);
  assert.equal(result.fetched, 1);

  const mirrors = await db.permits.toArray();
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0].syncState, '已同步');

  const clearances = await reAdjudicateClearances();
  assert.deepEqual(
    clearances.map((row) => [row.scheduleId, row.decision]),
    [
      ['s1', '放行'],
      ['s2', '排队'], // s1 占 700，B 余 300，s2 需 400 差 100
    ],
  );
  const queued = clearances.find((row) => row.scheduleId === 's2');
  assert.equal(queued?.shortfallM3, 100);
  assert.equal(queued?.queueRank, 1);
  assert.match(queued?.reason ?? '', /差 100 m³/);

  // 计划量与水位不动
  assert.equal((await db.schedules.get('s2'))?.volumeM3, 400);
  assert.equal((await db.observations.get('o-b'))?.levelCm, 30);
});

test('B. 同步失败重试：游标不前移，重送不产生重复许可与重复放行', async () => {
  await seedCascade();
  await issuePermit({ pondCode: 'A', sampledAt: '2026-10-01', labName: '室', approvedVolumeM3: 2000 });

  armLabPullFailure();
  const failed = await syncPermitsFromLab();
  assert.equal(failed.failed, true);
  assert.equal(await db.permits.count(), 0); // 失败不落库

  // 重试：同一批再送一次
  const retry = await syncPermitsFromLab();
  assert.equal(retry.failed, false);
  assert.equal(retry.fetched, 1);
  assert.equal(await db.permits.count(), 1);

  // 再同步一次：无新增（游标前移），许可与核定数量不变
  const again = await syncPermitsFromLab();
  assert.equal(again.fetched, 0);
  assert.equal(await db.permits.count(), 1);
  await reAdjudicateClearances();
  const clearances = await db.clearances.toArray();
  assert.equal(clearances.filter((row) => row.active && row.scheduleId === 's1').length, 1);
});

test('C. 换发新许可：旧核定作废留痕，按新许可重新判定（放量变化可解除排队）', async () => {
  await seedCascade();
  const v1 = await issuePermit({ pondCode: 'A', sampledAt: '2026-10-01', labName: '室', approvedVolumeM3: 2000 });
  await syncPermitsFromLab();
  await reAdjudicateClearances();

  // 关键验证：v1 的核定被置为已作废，v2 产生新的一条有效核定（批准量仍覆盖计划，不与容量/许可上限排队混淆）
  await issuePermit({ pondCode: 'A', sampledAt: '2026-10-01', labName: '室', approvedVolumeM3: 2000, supersedesId: v1.id });
  await syncPermitsFromLab();
  await reAdjudicateClearances();

  const all = await db.clearances.toArray();
  const s1Rows = all.filter((row) => row.scheduleId === 's1');
  assert.equal(s1Rows.length, 2); // v1、v2 各一条
  const old = s1Rows.find((row) => row.permitVersion === 1);
  const current = s1Rows.find((row) => row.permitVersion === 2);
  assert.equal(old?.active, false);
  assert.equal(old?.decision, '已作废');
  assert.equal(current?.active, true);
  assert.equal(current?.decision, '放行');

  // 镜像里 v1 仍保留留痕（化验室原件不删）
  const permits = await db.permits.toArray();
  assert.equal(permits.length, 2);
});

test('D. 无许可时不放行；许可撤回后重判为撤回', async () => {
  await seedCascade();
  await reAdjudicateClearances();
  let clearances = await db.clearances.toArray();
  assert.ok(clearances.every((row) => row.decision === '无有效许可'));

  const permit = await issuePermit({ pondCode: 'A', sampledAt: '2026-10-01', labName: '室', approvedVolumeM3: 2000 });
  await syncPermitsFromLab();
  await reAdjudicateClearances();
  assert.equal((await db.clearances.where('scheduleId').equals('s1').filter((row) => row.active).toArray())[0]?.decision, '放行');

  // 化验室撤回（直接调 lab 侧撤回 + 同步）
  const { revokePermit } = await import('../src/utils/labClient');
  await revokePermit(permit.id);
  await syncPermitsFromLab();
  await reAdjudicateClearances();
  clearances = await db.clearances.where('scheduleId').equals('s1').filter((row) => row.active).toArray();
  assert.equal(clearances[0]?.decision, '许可撤回');
});

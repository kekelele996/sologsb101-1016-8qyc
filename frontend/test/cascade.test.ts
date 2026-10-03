/**
 * 串级核放引擎纯函数测试：
 * 1. 受纳容量 = 面积 ×（有效水深 − 当前水位）
 * 2. 上游先核走的水扣减下游余量，后面的串级按余量重算，不足即排队并写明差多少
 * 3. 许可按池号 + 取样日期对齐；对不上 / 撤回 / 末端直放
 * 4. 重算纯函数，不改计划量与水位
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjudicateCascade, clearanceId, matchedSampleDate } from '../src/utils/cascade';
import { receivingCapacityM3 } from '../src/utils/brine';
import type { Pond } from '../src/types/pond';
import type { Gate } from '../src/types/gate';
import type { Observation } from '../src/types/observation';
import type { Assay } from '../src/types/assay';
import type { Schedule } from '../src/types/schedule';
import type { DischargePermit } from '../src/types/permit';

const STAMP = '2026-10-01T00:00:00.000Z';

function pond(id: string, code: string, areaM2: number, depthCm: number): Pond {
  return { id, code, seriesName: '测试系', areaM2, depthCm, stage: '钠盐', status: '在用', createdAt: STAMP, updatedAt: STAMP, revision: 1 };
}
function gate(id: string, fromPondId: string, toPondId: string, openingPct: number): Gate {
  return {
    id,
    fromPondId,
    toPondId,
    openingPct,
    widthCm: 100,
    state: openingPct <= 0 ? '关闭' : openingPct >= 95 ? '全开' : '半开',
    note: '',
    createdAt: STAMP,
    updatedAt: STAMP,
    revision: 1,
  };
}
function obs(pondId: string, date: string, levelCm: number): Observation {
  return { pondId, date, densityGcm3: 1.1, tempC: 25, levelCm, windLevel: 2, evapMm: 5, createdAt: STAMP, updatedAt: STAMP, revision: 1, id: `obs-${pondId}-${date}` };
}
function assay(pondId: string, date: string): Assay {
  return { id: `assay-${pondId}`, pondId, date, liGpl: 1.2, kGpl: 22, mgGpl: 0, naGpl: 0, labName: '化验室', verdict: '达标', verdictManual: false, createdAt: STAMP, updatedAt: STAMP, revision: 1 };
}
function schedule(id: string, pondId: string, volumeM3: number, orderIndex: number, state: Schedule['state'] = '待排'): Schedule {
  return { id, pondId, planDate: '2026-10-10', targetDensity: 1.2, volumeM3, operator: '', state, orderIndex, createdAt: STAMP, updatedAt: STAMP, revision: 1 };
}
function permit(id: string, pondCode: string, sampledAt: string, volume: number, status: DischargePermit['status'] = '批准', version = 1, supersedesId = ''): DischargePermit {
  return {
    id,
    permitNo: `${id}-no`,
    pondCode,
    sampledAt,
    labName: '化验室',
    status,
    version,
    supersedesId,
    approvedVolumeM3: volume,
    issuedAt: STAMP,
    syncState: '已同步',
    syncedAt: STAMP,
    syncError: '',
    syncAttempts: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    revision: 1,
  };
}

test('受纳容量按面积与可用水深计算，水位到顶容量为 0', () => {
  assert.equal(receivingCapacityM3(10000, 40, 30), 1000); // 10000㎡ × 0.1m
  assert.equal(receivingCapacityM3(10000, 40, 40), 0);
  assert.equal(receivingCapacityM3(10000, 40, 45), 0); // 超深按 0 兜底
});

test('取样日期取不晚于计划日期的最近一次化验', () => {
  const assays = [assay('p1', '2026-09-01'), assay('p2', '2026-10-01')];
  assert.equal(matchedSampleDate(assays, 'p1', '2026-10-10'), '2026-09-01');
  assert.equal(matchedSampleDate(assays, 'p2', '2026-09-15'), ''); // 化验晚于计划，不可用
  assert.equal(matchedSampleDate(assays, 'px', '2026-10-10'), '');
});

test('无有效许可：池号 + 取样日期对不上，不放行不占容量', () => {
  const pA = pond('a', 'A', 10000, 50);
  const pB = pond('b', 'B', 1000, 40);
  const gates = [gate('g1', 'a', 'b', 50)];
  const observations = [obs('a', '2026-10-01', 40), obs('b', '2026-10-01', 30)];
  const assays = [assay('a', '2026-10-01')];
  const schedules = [{ ...schedule('s1', 'a', 100, 1), committed: false }];
  const rows = adjudicateCascade({ ponds: [pA, pB], gates, observations, assays, schedules, permits: [], decidedAt: STAMP });
  assert.equal(rows[0].decision, '无有效许可');
  assert.equal(rows[0].shortfallM3, 0);
});

test('许可撤回：重判结论为许可撤回', () => {
  const pA = pond('a', 'A', 10000, 50);
  const observations = [obs('a', '2026-10-01', 40)];
  const assays = [assay('a', '2026-10-01')];
  const schedules = [{ ...schedule('s1', 'a', 100, 1, '走水中'), committed: true }];
  const permits = [permit('k1', 'A', '2026-10-01', 100, '撤回')];
  const rows = adjudicateCascade({ ponds: [pA], gates: [], observations, assays, schedules, permits, decidedAt: STAMP });
  assert.equal(rows[0].decision, '许可撤回');
  assert.match(rows[0].reason, /不改动/);
});

test('串级排队：上游先放行扣减余量，后面的按余量重算并写明差多少', () => {
  // 链路 A→B→C：B 可用水深 10cm（容量 10000×0.1=1000m³），C 容量 6800×0.1=680m³
  const pA = pond('a', 'A', 12000, 45);
  const pB = pond('b', 'B', 10000, 40);
  const pC = pond('c', 'C', 6800, 35);
  const gates = [gate('g1', 'a', 'b', 60), gate('g2', 'b', 'c', 40)];
  const observations = [
    obs('a', '2026-09-30', 39),
    obs('b', '2026-09-30', 30), // B 容量 1000
    obs('c', '2026-09-30', 25), // C 容量 680
  ];
  const assays = [assay('a', '2026-10-01'), assay('b', '2026-10-01')];
  const schedules = [
    { ...schedule('s1', 'a', 700, 1), committed: false }, // A→B 700，B 余 300
    { ...schedule('s2', 'b', 500, 2), committed: false }, // B→C 500，C 余 180
    { ...schedule('s3', 'a', 400, 3), committed: false }, // A→B 需 400，B 只余 300，差 100，排队
    { ...schedule('s4', 'b', 250, 4), committed: false }, // B→C 需 250，C 余 180，差 70，排队第 2
  ];
  const permits = [
    permit('k-a', 'A', '2026-10-01', 2000),
    permit('k-b', 'B', '2026-10-01', 2000),
  ];
  const rows = adjudicateCascade({ ponds: [pA, pB, pC], gates, observations, assays, schedules, permits, decidedAt: STAMP });

  assert.deepEqual(
    rows.map((row) => row.decision),
    ['放行', '放行', '排队', '排队'],
  );
  // s1 占用后 B 余量被重算为 300
  const s3 = rows[2];
  assert.equal(s3.queueRank, 1);
  assert.equal(s3.shortfallM3, 100);
  assert.equal(s3.allocations[0].pondCode, 'B');
  assert.equal(s3.allocations[0].remainingM3, 300);
  assert.match(s3.reason, /排第 1 位/);
  // s4 看到的 C 余量是 s2 扣减后的 180
  const s4 = rows[3];
  assert.equal(s4.queueRank, 2);
  assert.equal(s4.shortfallM3, 70);
  assert.equal(s4.allocations[0].remainingM3, 180);

  // 计划量与水位输入不被修改
  assert.equal(schedules[2].volumeM3, 400);
  assert.equal(observations.find((row) => row.pondId === 'b')?.levelCm, 30);
});

test('已放行（已排/走水中）计划无条件占用余量，后续排队', () => {
  const pA = pond('a', 'A', 12000, 45);
  const pB = pond('b', 'B', 10000, 40);
  const gates = [gate('g1', 'a', 'b', 60)];
  const observations = [obs('a', '2026-09-30', 39), obs('b', '2026-09-30', 30)]; // B 容量 1000
  const assays = [assay('a', '2026-10-01')];
  const schedules = [
    { ...schedule('s1', 'a', 900, 1, '走水中'), committed: true }, // 已走水，锁 900
    { ...schedule('s2', 'a', 200, 2), committed: false }, // B 只剩 100，差 100
  ];
  const permits = [permit('k-a', 'A', '2026-10-01', 2000)];
  const rows = adjudicateCascade({ ponds: [pA, pB], gates, observations, assays, schedules, permits, decidedAt: STAMP });
  assert.equal(rows[0].decision, '放行');
  assert.equal(rows[1].decision, '排队');
  assert.equal(rows[1].shortfallM3, 100);
  assert.equal(rows[1].queueRank, 1);
});

test('末端池无下游：许可有效即放行', () => {
  const pC = pond('c', 'C', 6800, 35);
  const observations = [obs('c', '2026-09-30', 34)]; // 只剩 68m³ 容量，也不查
  const assays = [assay('c', '2026-10-01')];
  const schedules = [{ ...schedule('s1', 'c', 600, 1), committed: false }];
  const permits = [permit('k-c', 'C', '2026-10-01', 600)];
  const rows = adjudicateCascade({ ponds: [pC], gates: [], observations, assays, schedules, permits, decidedAt: STAMP });
  assert.equal(rows[0].decision, '放行');
  assert.match(rows[0].reason, /末端/);
});

test('换新许可：现行版本取版本号最大者，核定 id 随许可版本变化（旧版留痕作废由持久层处理）', () => {
  const pC = pond('c', 'C', 6800, 35);
  const observations = [obs('c', '2026-09-30', 30)];
  const assays = [assay('c', '2026-10-01')];
  const schedules = [{ ...schedule('s1', 'c', 600, 1), committed: false }];
  const v1 = permit('k1', 'C', '2026-10-01', 500, '批准', 1);
  const v2 = permit('k2', 'C', '2026-10-01', 700, '批准', 2, 'k1');
  const rows = adjudicateCascade({ ponds: [pC], gates: [], observations, assays, schedules, permits: [v1, v2], decidedAt: STAMP });
  assert.equal(rows[0].permitId, 'k2');
  assert.equal(rows[0].permitVersion, 2);
  assert.notEqual(clearanceId('s1', 'k1', '2026-10-01'), clearanceId('s1', 'k2', '2026-10-01'));
});

test('许可批准量上限：待排计划超许可批量排队，已放走计划不拦', () => {
  const pA = pond('a', 'A', 12000, 45);
  const pB = pond('b', 'B', 10000, 40);
  const gates = [gate('g1', 'a', 'b', 60)];
  const observations = [obs('a', '2026-09-30', 39), obs('b', '2026-09-30', 10)]; // B 容量 3000，够接
  const assays = [assay('a', '2026-10-01')];
  const permits = [permit('k-a', 'A', '2026-10-01', 500)];

  const pending = adjudicateCascade({
    ponds: [pA, pB],
    gates,
    observations,
    assays,
    schedules: [{ ...schedule('s1', 'a', 700, 1), committed: false }],
    permits,
    decidedAt: STAMP,
  });
  assert.equal(pending[0].decision, '排队');
  assert.equal(pending[0].shortfallM3, 200);
  assert.match(pending[0].reason, /许可/);
  assert.equal(pending[0].allocations.length, 0); // 许可层面拦下，不进入容量分摊

  const committed = adjudicateCascade({
    ponds: [pA, pB],
    gates,
    observations,
    assays,
    schedules: [{ ...schedule('s1', 'a', 700, 1, '走水中'), committed: true }],
    permits,
    decidedAt: STAMP,
  });
  assert.equal(committed[0].decision, '放行');
});

test('多闸分流：按开度权重分摊计划量并逐池核容量', () => {
  const pA = pond('a', 'A', 12000, 45);
  const pB = pond('b', 'B', 10000, 40);
  const pC = pond('c', 'C', 10000, 40);
  // A 有两条等开度出流闸
  const gates = [gate('g1', 'a', 'b', 50), gate('g2', 'a', 'c', 50)];
  const observations = [
    obs('a', '2026-09-30', 39),
    obs('b', '2026-09-30', 30), // B 容量 1000
    obs('c', '2026-09-30', 38), // C 容量 200
  ];
  const assays = [assay('a', '2026-10-01')];
  // 600 按 50/50 分：B 300（够）、C 300（只余 200，差 100）
  const schedules = [{ ...schedule('s1', 'a', 600, 1), committed: false }];
  const permits = [permit('k-a', 'A', '2026-10-01', 600)];
  const rows = adjudicateCascade({ ponds: [pA, pB, pC], gates, observations, assays, schedules, permits, decidedAt: STAMP });
  assert.equal(rows[0].decision, '排队');
  assert.equal(rows[0].shortfallM3, 100);
  assert.deepEqual(rows[0].allocations.map((item) => item.pondCode).sort(), ['B', 'C']);
});

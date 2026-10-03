/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：蒸发池 → 闸门串级 / 卤水日观测 → 离子组分分析 → 走水编排
 * 所有 id 固定，保证 /gates、/observations、/assays、/schedules 打开就有真实串级与数据。
 */
import { db, ROW_REVISION } from './db';
import { labDb } from './labClient';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import type { DischargePermit } from '../types/permit';
import { autoVerdict, estimateEvapMm } from './brine';

const SEED_TIME = '2026-09-01T00:30:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  pondA: 'pond-north-01',
  pondB: 'pond-north-02',
  pondC: 'pond-north-03',
  pondD: 'pond-south-04',
  pondE: 'pond-south-05',
} as const;

function wrap<T>(row: Omit<T, 'createdAt' | 'updatedAt' | 'revision'>): T {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION } as T;
}

/** 生成观测记录，evapMm 由经验公式估算 */
function observation(
  id: string,
  pondId: string,
  date: string,
  densityGcm3: number,
  tempC: number,
  levelCm: number,
  windLevel: number,
): Observation {
  return wrap<Observation>({
    id,
    pondId,
    date,
    densityGcm3,
    tempC,
    levelCm,
    windLevel,
    evapMm: estimateEvapMm(densityGcm3, tempC, levelCm, windLevel),
  });
}

/** 生成化验记录，verdict 默认自动判定 */
function assay(
  id: string,
  pondId: string,
  date: string,
  liGpl: number,
  kGpl: number,
  mgGpl: number,
  naGpl: number,
  labName: string,
  manual?: { verdict: Assay['verdict']; verdictManual: true },
): Assay {
  return wrap<Assay>({
    id,
    pondId,
    date,
    liGpl,
    kGpl,
    mgGpl,
    naGpl,
    labName,
    verdict: manual?.verdict ?? autoVerdict(liGpl, kGpl),
    verdictManual: manual?.verdictManual ?? false,
  });
}

export async function seedDatabase(): Promise<void> {
  const exists = await db.ponds.count();
  if (exists > 0) return;

  // ---------------- 蒸发池（5 口，跨 2 个池系、3 个阶段） ----------------
  const ponds: Pond[] = [
    wrap<Pond>({ id: SEED_IDS.pondA, code: '北-01', seriesName: '北部一系', areaM2: 12000, depthCm: 45, stage: '钠盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondB, code: '北-02', seriesName: '北部一系', areaM2: 9000, depthCm: 40, stage: '钾盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondC, code: '北-03', seriesName: '北部一系', areaM2: 6800, depthCm: 35, stage: '锂盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondD, code: '南-04', seriesName: '南部二系', areaM2: 15000, depthCm: 50, stage: '钠盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondE, code: '南-05', seriesName: '南部二系', areaM2: 7200, depthCm: 38, stage: '钾盐', status: '清池中' }),
  ];

  // ---------------- 闸门串级（上游 → 下游，形成完整走向链） ----------------
  const gates: Gate[] = [
    wrap<Gate>({ id: 'gate-a-b', fromPondId: SEED_IDS.pondA, toPondId: SEED_IDS.pondB, openingPct: 65, widthCm: 120, state: '半开', note: '北部一系主走水通道' }),
    wrap<Gate>({ id: 'gate-b-c', fromPondId: SEED_IDS.pondB, toPondId: SEED_IDS.pondC, openingPct: 40, widthCm: 100, state: '半开', note: '进入锂盐阶段前的控流闸' }),
    wrap<Gate>({ id: 'gate-d-e', fromPondId: SEED_IDS.pondD, toPondId: SEED_IDS.pondE, openingPct: 80, widthCm: 140, state: '半开', note: '南部二系主走水通道' }),
    wrap<Gate>({ id: 'gate-b-e', fromPondId: SEED_IDS.pondB, toPondId: SEED_IDS.pondE, openingPct: 0, widthCm: 90, state: '关闭', note: '跨池系调水备用闸，当前关闭' }),
  ];

  // ---------------- 卤水日观测（每池 2–4 条，密度随日期递增） ----------------
  const observations: Observation[] = [
    observation('obs-a1', SEED_IDS.pondA, '2026-08-20', 1.045, 28, 45, 2),
    observation('obs-a2', SEED_IDS.pondA, '2026-08-30', 1.062, 30, 43, 3),
    observation('obs-a3', SEED_IDS.pondA, '2026-09-10', 1.086, 29, 41, 2),
    observation('obs-a4', SEED_IDS.pondA, '2026-09-22', 1.108, 26, 39, 3),
    observation('obs-b1', SEED_IDS.pondB, '2026-08-22', 1.112, 27, 40, 2),
    observation('obs-b2', SEED_IDS.pondB, '2026-09-02', 1.14, 29, 38, 3),
    observation('obs-b3', SEED_IDS.pondB, '2026-09-14', 1.168, 28, 36, 2),
    observation('obs-c1', SEED_IDS.pondC, '2026-08-25', 1.195, 26, 35, 1),
    observation('obs-c2', SEED_IDS.pondC, '2026-09-05', 1.222, 27, 33, 2),
    observation('obs-c3', SEED_IDS.pondC, '2026-09-18', 1.248, 25, 31, 2),
    observation('obs-d1', SEED_IDS.pondD, '2026-08-21', 1.038, 30, 50, 4),
    observation('obs-d2', SEED_IDS.pondD, '2026-09-01', 1.055, 31, 48, 3),
    observation('obs-d3', SEED_IDS.pondD, '2026-09-12', 1.074, 29, 46, 2),
    observation('obs-d4', SEED_IDS.pondD, '2026-09-24', 1.092, 27, 44, 3),
    observation('obs-e1', SEED_IDS.pondE, '2026-08-24', 1.12, 28, 38, 2),
    observation('obs-e2', SEED_IDS.pondE, '2026-09-04', 1.146, 29, 36, 2),
  ];

  // ---------------- 离子组分分析（含达标 / 接近 / 未达标三种判定） ----------------
  const assays: Assay[] = [
    assay('assay-a1', SEED_IDS.pondA, '2026-09-22', 0.12, 6.4, 42.5, 88.2, '盐湖中心化验室'),
    assay('assay-b1', SEED_IDS.pondB, '2026-09-14', 0.72, 15.5, 21.8, 58.4, '盐湖中心化验室'),
    assay('assay-c1', SEED_IDS.pondC, '2026-09-05', 1.05, 18.2, 9.6, 26.1, '盐湖中心化验室'),
    assay('assay-c2', SEED_IDS.pondC, '2026-09-18', 1.32, 22.6, 8.4, 24.3, '盐湖中心化验室'),
    assay('assay-d1', SEED_IDS.pondD, '2026-09-24', 0.08, 4.2, 48.9, 96.5, '南部化验站'),
    assay('assay-e1', SEED_IDS.pondE, '2026-09-04', 0.48, 13.6, 24.2, 61.7, '南部化验站', {
      verdict: '接近',
      verdictManual: true,
    }),
  ];

  // ---------------- 走水编排（覆盖四种状态，orderIndex 决定先后） ----------------
  // 串级容量账本（按面积与最近观测水位）：北-02 受纳 360 m³、北-03 受纳 272 m³、南-05 受纳 144 m³。
  // a1 已放走 200 m³（北-02 余 160）：紧随的 a2 要 440，差 280 排队；
  // b1 许可已被化验室撤回 → 重判拦下（不占容量）；
  // d1 已放走 100 m³（南-05 余 44）：紧随的 d2 要 300，差 256 排队；
  // c1 为末端锂盐池，无下游，许可有效即放行。
  const schedules: Schedule[] = [
    wrap<Schedule>({ id: 'schedule-a1', pondId: SEED_IDS.pondA, planDate: '2026-10-02', targetDensity: 1.115, volumeM3: 200, operator: '韩江', state: '已排', orderIndex: 1 }),
    wrap<Schedule>({ id: 'schedule-d1', pondId: SEED_IDS.pondD, planDate: '2026-10-04', targetDensity: 1.098, volumeM3: 100, operator: '王锐', state: '走水中', orderIndex: 2 }),
    wrap<Schedule>({ id: 'schedule-a2', pondId: SEED_IDS.pondA, planDate: '2026-10-05', targetDensity: 1.12, volumeM3: 440, operator: '韩江', state: '待排', orderIndex: 3 }),
    wrap<Schedule>({ id: 'schedule-b1', pondId: SEED_IDS.pondB, planDate: '2026-10-06', targetDensity: 1.175, volumeM3: 900, operator: '韩江', state: '待排', orderIndex: 4 }),
    wrap<Schedule>({ id: 'schedule-d2', pondId: SEED_IDS.pondD, planDate: '2026-10-08', targetDensity: 1.1, volumeM3: 300, operator: '王锐', state: '待排', orderIndex: 5 }),
    wrap<Schedule>({ id: 'schedule-c1', pondId: SEED_IDS.pondC, planDate: '2026-10-12', targetDensity: 1.255, volumeM3: 600, operator: '李文', state: '待排', orderIndex: 6 }),
    wrap<Schedule>({ id: 'schedule-e1', pondId: SEED_IDS.pondE, planDate: '2026-09-28', targetDensity: 1.15, volumeM3: 700, operator: '王锐', state: '已出卤', orderIndex: 7 }),
  ];

  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await db.ponds.bulkPut(ponds);
    await db.gates.bulkPut(gates);
    await db.observations.bulkPut(observations);
    await db.assays.bulkPut(assays);
    await db.schedules.bulkPut(schedules);
  });
}

/**
 * 化验室系统演示许可播种（独立库 gbbrinepond-lab，幂等）。
 * 注意：这里写的是「化验室侧原件」，台账镜像要靠同步动作拉过去，
 * 以演示外部系统 → 只读镜像 → 串级核放的完整链路。
 *
 * 覆盖：
 * - 北-01 / 2026-09-22：批准 v1（对应 schedule-a1，走水到北-02）
 * - 南-04 / 2026-09-24：批准 v1（对应 schedule-d1，走水到南-05）
 * - 北-02 / 2026-09-14：批准 v1 已撤回（对应 schedule-b1，演示许可撤回重判）
 * - 北-03 / 2026-09-18：批准 v1（末端锂盐池，对应 schedule-c1，直放）
 */
function labPermit(
  id: string,
  pondCode: string,
  sampledAt: string,
  version: number,
  supersedesId: string,
  approvedVolumeM3: number,
  status: DischargePermit['status'],
  issuedAt: string,
  labName = '盐湖中心化验室',
): DischargePermit {
  return {
    id,
    permitNo: `CK-${pondCode}-${sampledAt.replace(/-/g, '')}-v${version}`,
    pondCode,
    sampledAt,
    labName,
    status,
    version,
    supersedesId,
    approvedVolumeM3,
    issuedAt,
    syncState: '待同步',
    syncedAt: '',
    syncError: '',
    syncAttempts: 0,
    createdAt: issuedAt,
    updatedAt: issuedAt,
    revision: 1,
  };
}

export async function seedLabPermits(): Promise<void> {
  if ((await labDb.permits.count()) > 0) return;
  const permits: DischargePermit[] = [
    labPermit('lab-a1', '北-01', '2026-09-22', 1, '', 1200, '批准', '2026-09-23T02:10:00.000Z'),
    labPermit('lab-d1', '南-04', '2026-09-24', 1, '', 1600, '批准', '2026-09-25T01:40:00.000Z', '南部化验站'),
    labPermit('lab-b1', '北-02', '2026-09-14', 1, '', 900, '撤回', '2026-09-15T03:00:00.000Z'),
    labPermit('lab-c1', '北-03', '2026-09-18', 1, '', 600, '批准', '2026-09-19T02:30:00.000Z'),
  ];
  await labDb.permits.bulkPut(permits);
}

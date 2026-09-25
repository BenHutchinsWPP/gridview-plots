// .claude/skills/drive-app/make-sample-data.mjs
//
// Invented full-year (8,760-row) exports for driving the app: two Cases of
// Interface flow and Bus LMP, a two-line-header BusList, two interface limit
// schedules, and a one-Case study of every kind with groups. Every name is SAMPLE_. Usage: node make-sample-data.mjs <dir>
import { mkdirSync, writeFileSync } from 'node:fs';
const Y = 2035,
  dir = process.argv[2];
mkdirSync(dir, { recursive: true });
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function* hours() {
  for (let m = 1; m <= 12; m++)
    for (let d = 1; d <= DAYS[m - 1]; d++) for (let h = 1; h <= 24; h++) yield [m, d, h];
}
function iface(file, quantity, levels, scale = 1) {
  const names = Object.keys(levels);
  const out = [
    `Interface Hourly '${quantity}' Data for Year ${Y}`,
    'SYNTHETIC DATA -- invented for an app check. Not a real export.',
    `(From the first hour of 1/1/${Y} to the last hour of 12/31/${Y}. Column identifier -- Interface Name)`,
    '',
    `Date, Hour, TOU,${names.join(',')}`,
  ];
  for (const [m, d, h] of hours())
    out.push(
      `${m}/${d}/${Y},${h},${h % 2 ? 'OffPeak' : 'OnPeak'},${names.map((n) => levels[n] * scale).join(',')}`,
    );
  writeFileSync(`${dir}/${file}`, out.join('\r\n') + '\r\n');
}
function bus(file, quantity, ids, names, levels) {
  const out = [
    `Bus Hourly '${quantity}' Data for Year ${Y}`,
    '',
    `(From the first hour of 1/1/${Y} to the last hour of 12/31/${Y}. Column identifier -- BusName)`,
    '',
    ['', '', 'BusNumber', ...ids].join(','),
    ['Date', ' Hour', ' TOU', ...names].join(','),
  ];
  for (const [m, d, h] of hours())
    out.push([`${m}/${d}/${Y}`, h, h % 2 ? 'OffPeak' : 'OnPeak', ...levels].join(','));
  writeFileSync(`${dir}/${file}`, out.join('\r\n') + '\r\n');
}
const flows = { SAMPLE_P01: 100, SAMPLE_P02: 40, SAMPLE_P03: 7 };
iface('SAMPLE_CASEA_InterfaceFlow.csv', 'Power Flow (MW)', flows);
iface('SAMPLE_CASEB_InterfaceFlow.csv', 'Power Flow (MW)', flows, 2);
const ids = [90001, 90002, 90003];
const bnames = ['SAMPLE_BUS_A', 'SAMPLE_BUS_B', 'SAMPLE_BUS_C'];
bus('SAMPLE_CASEA_BusLMP.csv', 'LMP ($/MWh)', ids, bnames, [21, 22, 23]);
bus('SAMPLE_CASEB_BusLMP.csv', 'LMP ($/MWh)', ids, bnames, [31, 32, 33]);
function busList(file, areaOf) {
  writeFileSync(
    `${dir}/${file}`,
    [
      'BUS_GENERAL,,,',
      'BusID,Name,BaseKV,LoadArea',
      ...ids.map((id, i) => `${id},${bnames[i]},230,${areaOf(i)}`),
    ].join('\r\n') + '\r\n',
  );
}
busList('SAMPLE_BusList.csv', (i) => `SAMPLE_AREA_${i < 2 ? 'W' : 'E'}`);
// Two monthly limit schedules: one to share across Cases, one for a single
// Case. The per-Case one wins for its Case, so P01's MAX reads 500 there and
// 300 on the other; P02 has a MIN only in the per-Case file.
function limits(file, rows) {
  const months = 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec';
  const out = [
    'INTERFACELIMITSCHEDULE_MONTHLY,SYNTHETIC DATA,invented for an app check',
    ',not a real export',
    '',
    `Interface Name,Year,Type,${months}`,
    ...rows.map(([name, side, value]) => `${name},${Y},${side},${Array(12).fill(value).join(',')}`),
  ];
  writeFileSync(`${dir}/${file}`, out.join('\r\n') + '\r\n');
}
limits('SAMPLE_Limits_Shared.csv', [['SAMPLE_P01', 'MAX', 300]]);
limits('SAMPLE_Limits_Own.csv', [
  ['SAMPLE_P01', 'MAX', 500],
  ['SAMPLE_P02', 'MIN', -60],
]);
// One Case of every kind with groups, for checking group rows: Area load with
// a Groupings file, Bus load (MW sums across buses, LMP refuses), Generator
// energy with a GeneratorList. Levels are powers of ten apart, so every
// subset of members has a sum that names it.
function hourly(file, title, ident, quantity, levels) {
  const names = Object.keys(levels);
  const out = [
    `${title} Hourly '${quantity}' Data for Year ${Y}`,
    '',
    `(From the first hour of 1/1/${Y} to the last hour of 12/31/${Y}. Column identifier -- ${ident})`,
    '',
    `Date, Hour, TOU,${names.join(',')}`,
  ];
  for (const [m, d, h] of hours())
    out.push(
      `${m}/${d}/${Y},${h},${h % 2 ? 'OffPeak' : 'OnPeak'},${names.map((n) => levels[n]).join(',')}`,
    );
  writeFileSync(`${dir}/${file}`, out.join('\r\n') + '\r\n');
}
hourly('SAMPLE_CASEA_AreaLoad.csv', 'Area', 'AreaName', 'Load (MWh)', {
  SAMPLE_AREA_1: 1000,
  SAMPLE_AREA_2: 100,
  SAMPLE_AREA_3: 10,
});
// Long Area exports (one row per area-hour, many metrics, no preamble) with a
// load-weighted LMP beside its weight, and beside a metric that is not its
// weight: what Area Groups may offer turns on which. A per-column export
// cannot hold both, being one metric per Case.
function areaLong(file, metrics) {
  const names = Object.keys(metrics);
  const out = [`Date, Hour, TOU, Name, ${names.join(', ')}`];
  for (const [m, d, h] of hours())
    for (const [a, area] of ['SAMPLE_AREA_1', 'SAMPLE_AREA_2', 'SAMPLE_AREA_3'].entries())
      out.push(
        [
          `${m}/${d}/${Y}`,
          h,
          h % 2 ? 'OffPeak' : 'OnPeak',
          area,
          ...names.map((n) => metrics[n][a]),
        ].join(','),
      );
  writeFileSync(`${dir}/${file}`, out.join('\r\n') + '\r\n');
}
const LMP = 'Avg LMP Weighted by Load ($/MWh)';
hourly('SAMPLE_CASEA_AreaLMP.csv', 'Area', 'AreaName', LMP, {
  SAMPLE_AREA_1: 30,
  SAMPLE_AREA_2: 20,
  SAMPLE_AREA_3: 10,
});
areaLong('SAMPLE_CASEA_AreaLong_WithLoad.csv', {
  'Load (MWh)': [1000, 100, 10],
  [LMP]: [30, 20, 10],
});
areaLong('SAMPLE_CASEA_AreaLong_NoLoad.csv', {
  'Generation (MWh)': [1000, 100, 10],
  [LMP]: [30, 20, 10],
});
writeFileSync(
  `${dir}/SAMPLE_Groupings.csv`,
  'Name,Grouping\r\nSAMPLE_AREA_1,SAMPLE_ZONE_N\r\nSAMPLE_AREA_2,SAMPLE_ZONE_N\r\nSAMPLE_AREA_3,SAMPLE_ZONE_S\r\n',
);
bus('SAMPLE_CASEA_BusLoad.csv', 'Load (MW)', ids, bnames, [1000, 100, 10]);
// In MWh as well, because a stack refuses mixed units before it asks whether
// an area already holds a bus, and the area export is in MWh.
bus('SAMPLE_CASEA_BusEnergy.csv', 'Load (MWh)', ids, bnames, [1000, 100, 10]);
hourly('SAMPLE_CASEA_GenEnergy.csv', 'Generator', 'GeneratorName', 'Energy (MWh)', {
  SAMPLE_GEN_1: 1000,
  SAMPLE_GEN_2: 100,
  SAMPLE_GEN_3: 10,
});
function generatorList(file, areaOf) {
  writeFileSync(
    `${dir}/${file}`,
    [
      'GENERATORLIST',
      'SYNTHETIC DATA -- invented for an app check',
      'GeneratorKey,Name,Bus ID,Bus Name,Bus KV,Unit ID,Generator TypeID,SubType,Long ID,Long Name,ServiceStatus,Commission Date,Retirement Date,DevStatus,Area Name,Region Name,PSSEMinCap(MW),PSSEMaxCap(MW),',
      ...[1, 2, 3].map(
        (k) =>
          `${k},SAMPLE_GEN_${k},${ids[k - 1]},${bnames[k - 1]},230,1,SAMPLE_TYPE_1,SAMPLE_SUBTYPE_${k === 3 ? 2 : 1},SAMPLE_LID_${k},SAMPLE Plant ${k},YES,#2020-01-15#,,SAMPLE_DEV_1,${areaOf(k)},SAMPLE_REGION_1,1,2000,`,
      ),
    ].join('\r\n') + '\r\n',
  );
}
generatorList('SAMPLE_GeneratorList.csv', (k) => `SAMPLE_AREA_${k}`);
// The stacked-slot overlap check needs members that sit INSIDE an area the
// area export draws: units 1 and 2 and buses 90001 and 90002 in SAMPLE_AREA_1,
// the third of each in SAMPLE_AREA_3. Same names, so only the lists differ.
generatorList('SAMPLE_GeneratorList_SharedArea.csv', (k) => `SAMPLE_AREA_${k < 3 ? 1 : 3}`);
busList('SAMPLE_BusList_SharedArea.csv', (i) => `SAMPLE_AREA_${i < 2 ? 1 : 3}`);

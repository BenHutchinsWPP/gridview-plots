// src/series/scales.ts
//
// Which y scale a unit is drawn on, and how a merged axis is labelled.
//
// A property of the drawn LINE, not of any kind: every pane that puts two
// units on one chart -- the three uPlot panes, the box plot, the X-Y scatter
// -- asks the same question of the same unit strings. It lived in four kinds'
// `rules.ts` as four copies, and the copies had already drifted: Area labelled
// a blank unit `''` where the other three said `(no unit)`, so the same
// unitless column read differently depending on which section drew it.
//
// It imports no kind, and no kind's rules table: a unit is a string here. What
// a unit MEANS when hours are combined is the kind's own rules file (see
// `src/tables/wide/quantity.ts`'s `unitRules`), and the merge below must never
// reach it.

/**
 * The y scale a unit is drawn on. Two units share a scale only when they are
 * the same NUMBER, which MW and MWh are here: every value in the cube is one
 * hour, and 1 MW held for an hour is 1 MWh. Splitting `Load (MWh)` and `Net
 * Load (MW)` across a left and a right axis draws two identical quantities at
 * two different zoom levels, which reads as a difference that is not there.
 *
 * This is a property of the HOUR, and it stops at the chart: a period total of
 * MW is still not MWh, so nothing here touches `class`, `temporal` or the
 * stats table, which keep treating MW as a rate.
 */
export function scaleOf(unit: string): string {
  return unit === 'MW' ? 'MWh' : unit;
}

/**
 * Distinct y scales among the drawn lines, in first-seen order, each labelled
 * with every unit sharing it -- so a merged axis reads "MWh · MW" rather than
 * silently renaming one of them. A line with no unit is labelled `(no unit)`
 * and gets an axis of its own rather than borrowing someone else's.
 */
export function scalesOf(series: { unit: string }[]): { scale: string; label: string }[] {
  const byScale = new Map<string, string[]>();
  for (const { unit } of series) {
    const scale = scaleOf(unit);
    const seen = byScale.get(scale) ?? [];
    if (!seen.includes(unit)) seen.push(unit);
    byScale.set(scale, seen);
  }
  return [...byScale].map(([scale, units]) => ({
    scale,
    label: units.map((unit) => unit || '(no unit)').join(' · '),
  }));
}

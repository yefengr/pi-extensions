export type Interval = readonly [number, number];

export function mergeIntervals(intervals: readonly Interval[]): readonly Interval[] {
  const ordered = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .slice()
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of ordered) {
    const previous = merged.at(-1);
    if (previous === undefined || start > previous[1]) {
      merged.push([start, end]);
    } else {
      previous[1] = Math.max(previous[1], end);
    }
  }
  return Object.freeze(merged.map((interval) => Object.freeze(interval) as Interval));
}

export function intervalSeconds(intervals: readonly Interval[]): number {
  const milliseconds = mergeIntervals(intervals)
    .reduce((total, [start, end]) => total + end - start, 0);
  return seconds(milliseconds);
}

export function overlapSeconds(left: readonly Interval[], right: readonly Interval[]): number {
  const first = mergeIntervals(left);
  const second = mergeIntervals(right);
  let firstIndex = 0;
  let secondIndex = 0;
  let milliseconds = 0;
  while (firstIndex < first.length && secondIndex < second.length) {
    const start = Math.max(first[firstIndex][0], second[secondIndex][0]);
    const end = Math.min(first[firstIndex][1], second[secondIndex][1]);
    if (end > start) milliseconds += end - start;
    if (first[firstIndex][1] <= second[secondIndex][1]) firstIndex += 1;
    else secondIndex += 1;
  }
  return seconds(milliseconds);
}

export function seconds(milliseconds: number): number {
  return Number((Math.max(0, milliseconds) / 1000).toFixed(3));
}

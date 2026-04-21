// Seasonality math — pure functions over snapshot rows.

export type SnapshotLite = {
  scraped_at: string;
  avg_daily_price: number | null;
};

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(nums: number[], q: number): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
}

export type MonthlyStat = {
  monthIndex: number; // 0-11
  label: string;
  median: number;
  p25: number;
  p75: number;
  multiplier: number;
  sampleSize: number;
};

export type WeekdayStat = {
  weekdayIndex: number; // 0=Sun..6=Sat
  label: string;
  median: number;
  multiplier: number;
  sampleSize: number;
};

export function computeMonthlyStats(snaps: SnapshotLite[]): MonthlyStat[] {
  const buckets: number[][] = Array.from({ length: 12 }, () => []);
  const all: number[] = [];
  for (const s of snaps) {
    const p = Number(s.avg_daily_price);
    if (!p || !isFinite(p)) continue;
    const d = new Date(s.scraped_at);
    if (isNaN(d.getTime())) continue;
    buckets[d.getMonth()].push(p);
    all.push(p);
  }
  const overall = median(all) || 1;
  return buckets.map((vals, i) => {
    const med = median(vals);
    return {
      monthIndex: i,
      label: MONTH_LABELS[i],
      median: med,
      p25: quantile(vals, 0.25),
      p75: quantile(vals, 0.75),
      multiplier: med ? med / overall : 1,
      sampleSize: vals.length,
    };
  });
}

export function computeWeekdayStats(snaps: SnapshotLite[]): WeekdayStat[] {
  const buckets: number[][] = Array.from({ length: 7 }, () => []);
  const all: number[] = [];
  for (const s of snaps) {
    const p = Number(s.avg_daily_price);
    if (!p || !isFinite(p)) continue;
    const d = new Date(s.scraped_at);
    if (isNaN(d.getTime())) continue;
    buckets[d.getDay()].push(p);
    all.push(p);
  }
  const overall = median(all) || 1;
  return buckets.map((vals, i) => {
    const med = median(vals);
    return {
      weekdayIndex: i,
      label: WEEKDAY_LABELS[i],
      median: med,
      multiplier: med ? med / overall : 1,
      sampleSize: vals.length,
    };
  });
}

export function weekendPremiumPct(weekday: WeekdayStat[]): number {
  const wknd = [weekday[5], weekday[6], weekday[0]].filter((w) => w.median > 0).map((w) => w.median);
  const wkdy = [weekday[1], weekday[2], weekday[3], weekday[4]].filter((w) => w.median > 0).map((w) => w.median);
  if (!wknd.length || !wkdy.length) return 0;
  const a = wknd.reduce((x, y) => x + y, 0) / wknd.length;
  const b = wkdy.reduce((x, y) => x + y, 0) / wkdy.length;
  return b ? ((a - b) / b) * 100 : 0;
}

export function annualSeasonalityFactor(monthly: MonthlyStat[]): number {
  // Average of multipliers, ~1 by construction. Useful for sanity.
  const valid = monthly.filter((m) => m.sampleSize > 0);
  if (!valid.length) return 1;
  return valid.reduce((s, m) => s + m.multiplier, 0) / valid.length;
}

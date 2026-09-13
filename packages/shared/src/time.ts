/**
 * Timezone-correct run windows.
 *
 * The format prompts are explicit that the orchestrator, never the model,
 * computes run timestamps and coverage windows, and that they must be exact
 * Europe/Paris boundaries in ISO-8601 with offset. Everything here is pure
 * arithmetic over Intl, with no dependency and no reliance on the host's local
 * timezone.
 */

/** Minutes that `timeZone` is ahead of UTC at the given instant. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl did not return ${type} for ${timeZone}`);
    return Number(part.value);
  };

  const localAsUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  // Drop sub-second precision so the difference is a clean offset.
  return (localAsUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000;
}

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, '0');
}

/** `2026-09-11T00:00:00+02:00` — the exact shape the run prompts require. */
export function toZonedIso(instant: Date, timeZone: string): string {
  const offset = zoneOffsetMinutes(instant, timeZone);
  const local = new Date(instant.getTime() + offset * 60_000);
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** `YYYY-MM-DD` for an instant, as seen in `timeZone`. */
export function toZonedDate(instant: Date, timeZone: string): string {
  const offset = zoneOffsetMinutes(instant, timeZone);
  const local = new Date(instant.getTime() + offset * 60_000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
}

/**
 * The UTC instant of 00:00:00 local time on `isoDate` in `timeZone`.
 * Two passes, because the offset itself depends on the instant (DST).
 */
export function startOfZonedDay(isoDate: string, timeZone: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Expected YYYY-MM-DD, got "${isoDate}"`);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000);
  guess = new Date(naive - zoneOffsetMinutes(guess, timeZone) * 60_000);
  return guess;
}

export function addDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * 86_400_000);
}

export function addHours(instant: Date, hours: number): Date {
  return new Date(instant.getTime() + hours * 3_600_000);
}

/** Calendar-day arithmetic in the zone, DST-safe (not a fixed 24h step). */
export function shiftZonedDate(isoDate: string, days: number, timeZone: string): string {
  return toZonedDate(addHours(startOfZonedDay(isoDate, timeZone), days * 24 + 12), timeZone);
}

export interface RunWindowShape {
  timeZone: string;
  /** Length of the primary coverage window, ending at 00:00 on the run date. */
  coverageHours: number;
  /** Optional earlier start for late-indexed primary material. */
  backstopHours?: number;
  /** Rolling context window, in days, ending at the coverage end. */
  rollingContextDays?: number;
  /** Forward-looking watch window, in days, starting on the run date. */
  forwardWatchDays?: number;
}

export interface RunWindows {
  timeZone: string;
  runDate: string;
  runTimeIso: string;
  coverageStartIso: string;
  coverageEndIso: string;
  coverageHours: number;
  backstopStartIso?: string;
  backstopHours?: number;
  rollingContextStartIso?: string;
  rollingContextEndIso?: string;
  rollingContextDays?: number;
  forwardWatchStart?: string;
  forwardWatchEnd?: string;
  forwardWatchDays?: number;
  /**
   * True when the coverage window crosses a DST transition. The window is still
   * exactly `coverageHours` of elapsed time (which is what the formats' hard
   * preflight gate requires), so on such a day the local clock boundaries are
   * not both midnight. Surfaced rather than silently absorbed.
   */
  coverageSpansDstChange: boolean;
}

/**
 * All windows for one run. Coverage ends at 00:00 local on the run date and
 * runs backwards, which is what "yesterday 00:00 -> today 00:00 CEST" means in
 * the prompts.
 */
export function computeRunWindows(runDate: string, shape: RunWindowShape): RunWindows {
  const { timeZone } = shape;
  const coverageEnd = startOfZonedDay(runDate, timeZone);
  const coverageStart = addHours(coverageEnd, -shape.coverageHours);

  const windows: RunWindows = {
    timeZone,
    runDate,
    runTimeIso: toZonedIso(coverageEnd, timeZone),
    coverageStartIso: toZonedIso(coverageStart, timeZone),
    coverageEndIso: toZonedIso(coverageEnd, timeZone),
    coverageHours: shape.coverageHours,
    coverageSpansDstChange:
      zoneOffsetMinutes(coverageStart, timeZone) !== zoneOffsetMinutes(coverageEnd, timeZone),
  };

  if (shape.backstopHours !== undefined) {
    windows.backstopStartIso = toZonedIso(addHours(coverageEnd, -shape.backstopHours), timeZone);
    windows.backstopHours = shape.backstopHours;
  }
  if (shape.rollingContextDays !== undefined) {
    windows.rollingContextStartIso = toZonedIso(
      startOfZonedDay(shiftZonedDate(runDate, -shape.rollingContextDays, timeZone), timeZone),
      timeZone,
    );
    windows.rollingContextEndIso = toZonedIso(coverageEnd, timeZone);
    windows.rollingContextDays = shape.rollingContextDays;
  }
  if (shape.forwardWatchDays !== undefined) {
    windows.forwardWatchStart = runDate;
    windows.forwardWatchEnd = shiftZonedDate(runDate, shape.forwardWatchDays, timeZone);
    windows.forwardWatchDays = shape.forwardWatchDays;
  }
  return windows;
}

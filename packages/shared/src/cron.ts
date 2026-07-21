/** Conservative five-field cron parsing for server-issued schedule receipts. */

export interface ParsedCronExpression {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
}

const MONTH_ALIASES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const WEEKDAY_ALIASES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron must contain exactly five fields");
  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const dayOfMonth = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12, MONTH_ALIASES);
  const dayOfWeek = parseField(fields[4]!, 0, 7, WEEKDAY_ALIASES, true);
  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    dayOfMonthWildcard: dayOfMonth.wildcard,
    dayOfWeekWildcard: dayOfWeek.wildcard,
  };
}

export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function cronMatches(
  expression: string | ParsedCronExpression,
  timeZone: string,
  instant: Date,
): boolean {
  const cron = typeof expression === "string" ? parseCronExpression(expression) : expression;
  if (!isValidTimeZone(timeZone)) throw new Error(`invalid IANA time zone: ${timeZone}`);
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const minute = Number(part("minute"));
  const hour = Number(part("hour"));
  const dayOfMonth = Number(part("day"));
  const month = Number(part("month"));
  const weekday = WEEKDAY_ALIASES[part("weekday").slice(0, 3).toUpperCase()];
  if (weekday === undefined) throw new Error("could not derive weekday for cron evaluation");

  const domMatches = cron.dayOfMonth.has(dayOfMonth);
  const dowMatches = cron.dayOfWeek.has(weekday);
  const dayMatches = cron.dayOfMonthWildcard && cron.dayOfWeekWildcard
    ? true
    : cron.dayOfMonthWildcard
      ? dowMatches
      : cron.dayOfWeekWildcard
        ? domMatches
        : domMatches || dowMatches;
  return cron.minute.has(minute) &&
    cron.hour.has(hour) &&
    cron.month.has(month) &&
    dayMatches;
}

export function cronOccurrenceEpochMinute(instant: Date): number {
  return Math.floor(instant.getTime() / 60_000);
}

function parseField(
  source: string,
  min: number,
  max: number,
  aliases: Record<string, number> = {},
  normalizeSunday = false,
): { values: Set<number>; wildcard: boolean } {
  if (!source || source.includes("?")) throw new Error(`unsupported cron field: ${source}`);
  const values = new Set<number>();
  const wildcard = source === "*";
  for (const segment of source.toUpperCase().split(",")) {
    if (!segment) throw new Error("cron list contains an empty segment");
    const [baseRaw, stepRaw, extra] = segment.split("/");
    if (!baseRaw) throw new Error(`invalid cron segment: ${segment}`);
    const base = baseRaw;
    if (extra !== undefined) throw new Error(`invalid cron step: ${segment}`);
    const step = stepRaw === undefined ? 1 : parseInteger(stepRaw, 1, max - min + 1, aliases);
    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) throw new Error(`invalid cron range: ${base}`);
      start = parseInteger(range[0]!, min, max, aliases);
      end = parseInteger(range[1]!, min, max, aliases);
      if (start > end) throw new Error(`cron ranges cannot wrap: ${base}`);
    } else {
      start = parseInteger(base, min, max, aliases);
      end = stepRaw === undefined ? start : max;
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }
  if (values.size === 0) throw new Error(`cron field has no values: ${source}`);
  return { values, wildcard };
}

function parseInteger(
  source: string,
  min: number,
  max: number,
  aliases: Record<string, number>,
): number {
  const aliased = aliases[source];
  const value = aliased ?? (/^\d+$/.test(source) ? Number(source) : Number.NaN);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`cron value ${source} must be between ${min} and ${max}`);
  }
  return value;
}

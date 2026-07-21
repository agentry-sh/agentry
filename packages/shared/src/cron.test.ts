import { describe, expect, it } from "vitest";
import {
  cronMatches,
  cronOccurrenceEpochMinute,
  isValidCronExpression,
  isValidTimeZone,
  parseCronExpression,
} from "./cron.js";

describe("five-field cron", () => {
  it("supports lists, ranges, steps, names, and Sunday 7", () => {
    const parsed = parseCronExpression("*/15 9-17 * JAN,MAR MON-FRI");
    expect([...parsed.minute]).toEqual([0, 15, 30, 45]);
    expect(parsed.month.has(1)).toBe(true);
    expect(parsed.month.has(3)).toBe(true);
    expect(parsed.dayOfWeek.has(1)).toBe(true);
    expect(parseCronExpression("0 0 * * 7").dayOfWeek.has(0)).toBe(true);
  });

  it("rejects malformed or ambiguous non-five-field expressions", () => {
    for (const expression of ["", "* * * *", "* * * * * *", "61 * * * *", "* * ? * *", "*/0 * * * *"]) {
      expect(isValidCronExpression(expression)).toBe(false);
    }
  });

  it("matches using the declared IANA timezone and cron day semantics", () => {
    const instant = new Date("2026-07-09T12:30:00.000Z");
    expect(cronMatches("30 15 * * THU", "Europe/Helsinki", instant)).toBe(true);
    expect(cronMatches("30 15 1 * THU", "Europe/Helsinki", instant)).toBe(true);
    expect(cronMatches("30 15 1 * FRI", "Europe/Helsinki", instant)).toBe(false);
    expect(isValidTimeZone("Europe/Helsinki")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("uses the absolute epoch minute as the idempotent occurrence key", () => {
    expect(cronOccurrenceEpochMinute(new Date("1970-01-01T00:01:59Z"))).toBe(1);
  });
});

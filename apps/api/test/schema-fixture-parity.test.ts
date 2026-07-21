import { afterEach, describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is, sql, Table } from "drizzle-orm";
import * as schema from "@agentry/db/schema";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

let env: TestEnv | undefined;

afterEach(() => {
  if (env) disposeTestEnv(env);
  env = undefined;
});

describe("API test database schema parity", () => {
  it("keeps every canonical core table and column in the shared test fixture", async () => {
    env = await makeTestEnv();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const canonicalTables = new Map<string, Table>();
    for (const value of Object.values(schema)) {
      if (is(value, Table)) canonicalTables.set(getTableName(value), value);
    }

    const actualTableRows = await db.all<{ name: string }>(sql`
      SELECT name
        FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name
    `);
    const actualTableNames = actualTableRows.map((row) => row.name);
    expect(actualTableNames).toEqual([...canonicalTables.keys()].sort());

    const mismatches: Array<{
      table: string;
      expected: string[];
      actual: string[];
    }> = [];
    for (const [tableName, table] of canonicalTables) {
      const expected = Object.values(getTableColumns(table))
        .map((column) => column.name)
        .sort();
      const actual = (await db.all<{ name: string }>(
        sql.raw(`PRAGMA table_info(${JSON.stringify(tableName)})`),
      )).map((row) => row.name).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches.push({ table: tableName, expected, actual });
      }
    }
    expect(mismatches).toEqual([]);
  });
});

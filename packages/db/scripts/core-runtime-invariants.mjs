import { createHash } from "node:crypto";

import { createClient } from "@libsql/client";
import { CORE_BOOTSTRAP_TRIGGER_STATEMENTS } from "./core-bootstrap-triggers.mjs";
import { CORE_METADATA_SQL } from "./core-migration-metadata.mjs";
// Trigger SQL is checked-in security policy, not an optimization. Derive the
// immutable verifier map from the same canonical statements used by empty
// bootstrap so drift cannot hide behind a separately maintained hash list.
function triggerName(statement) {
  const match = /^CREATE\s+TRIGGER\s+([^\s]+)\s/i.exec(statement.trim());
  if (!match) throw new Error("canonical bootstrap contains malformed trigger SQL");
  return match[1];
}

export const CORE_SECURITY_TRIGGER_SHA256 = Object.freeze(Object.fromEntries(
  CORE_BOOTSTRAP_TRIGGER_STATEMENTS.map((statement) => [
    triggerName(statement),
    createHash("sha256").update(normalizedSql(statement)).digest("hex"),
  ]),
));

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedSql(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function quotedIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizedColumn(row) {
  return {
    name: String(row.name),
    type: String(row.type ?? "").trim().toUpperCase(),
    notnull: Number(row.notnull ?? 0),
    default: normalizedSql(row.dflt_value),
    pk: Number(row.pk ?? 0),
    hidden: Number(row.hidden ?? 0),
  };
}

function normalizedForeignKey(row) {
  return JSON.stringify({
    table: String(row.table),
    from: String(row.from),
    to: String(row.to),
    on_update: String(row.on_update),
    on_delete: String(row.on_delete),
    match: String(row.match),
  });
}

async function tableShape(client, tableName) {
  const [columns, foreignKeys, definition] = await Promise.all([
    client.execute(`PRAGMA table_xinfo(${quotedIdentifier(tableName)})`),
    client.execute(`PRAGMA foreign_key_list(${quotedIdentifier(tableName)})`),
    client.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      args: [tableName],
    }),
  ]);
  const definitionSql = normalizedSql(definition.rows[0]?.sql);
  if (!definitionSql) throw new Error(`core schema invariant cannot read table definition ${tableName}`);
  return {
    columns: columns.rows.map(normalizedColumn),
    foreignKeys: foreignKeys.rows.map(normalizedForeignKey).sort(),
    definitionHash: hash(definitionSql),
  };
}

async function indexShape(client, tableName, indexName) {
  const [indexList, indexInfo] = await Promise.all([
    client.execute(`PRAGMA index_list(${quotedIdentifier(tableName)})`),
    client.execute(`PRAGMA index_xinfo(${quotedIdentifier(indexName)})`),
  ]);
  const descriptor = indexList.rows.find((row) => String(row.name) === indexName);
  if (!descriptor) return null;
  return {
    unique: Number(descriptor.unique ?? 0),
    partial: Number(descriptor.partial ?? 0),
    origin: String(descriptor.origin ?? ""),
    columns: indexInfo.rows
      .filter((row) => Number(row.key ?? 0) === 1)
      .map((row) => ({
        name: row.name === null ? null : String(row.name),
        desc: Number(row.desc ?? 0),
        coll: String(row.coll ?? ""),
      })),
  };
}

export async function verifyCoreRuntimeInvariants(client, baseline) {
  const expected = createClient({ url: "file::memory:" });
  try {
    await expected.batch([
      ...baseline.statements,
      ...CORE_METADATA_SQL,
      ...CORE_BOOTSTRAP_TRIGGER_STATEMENTS,
    ], "write");
    const expectedTablesResult = await expected.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const actualTablesResult = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const actualTables = new Set(actualTablesResult.rows.map((row) => String(row.name)));
    const expectedTables = expectedTablesResult.rows.map((row) => String(row.name));
    const expectedTableSet = new Set(expectedTables);
    for (const tableName of actualTables) {
      if (!expectedTableSet.has(tableName)) {
        throw new Error(`core schema invariant found unexpected table ${tableName}`);
      }
    }
    const shapeEvidence = [];
    for (const tableName of expectedTables) {
      if (!actualTables.has(tableName)) throw new Error(`core schema invariant missing table ${tableName}`);
      const [expectedShape, actualShape] = await Promise.all([
        tableShape(expected, tableName),
        tableShape(client, tableName),
      ]);
      if (actualShape.columns.length !== expectedShape.columns.length) {
        throw new Error(
          `core schema invariant column count drift at ${tableName}: ` +
          `expected ${expectedShape.columns.length}, got ${actualShape.columns.length}`,
        );
      }
      const actualColumns = new Map(actualShape.columns.map((column) => [column.name, column]));
      for (const expectedColumn of expectedShape.columns) {
        const actualColumn = actualColumns.get(expectedColumn.name);
        if (JSON.stringify(actualColumn) !== JSON.stringify(expectedColumn)) {
          throw new Error(
            `core schema invariant drift at ${tableName}.${expectedColumn.name}: ` +
            `expected ${JSON.stringify(expectedColumn)}, got ${JSON.stringify(actualColumn ?? null)}`,
          );
        }
      }
      if (JSON.stringify(actualShape.foreignKeys) !== JSON.stringify(expectedShape.foreignKeys)) {
        throw new Error(`core schema invariant foreign-key drift at ${tableName}`);
      }
      if (actualShape.definitionHash !== expectedShape.definitionHash) {
        throw new Error(`core schema invariant table-definition drift at ${tableName}`);
      }
      shapeEvidence.push({ tableName, expectedShape });
    }

    const expectedIndexesResult = await expected.execute(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
    );
    const actualIndexesResult = await client.execute(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
    );
    const actualIndexes = new Map(
      actualIndexesResult.rows.map((row) => [String(row.name), String(row.tbl_name)]),
    );
    const expectedIndexNames = new Set(
      expectedIndexesResult.rows.map((row) => String(row.name)),
    );
    for (const indexName of actualIndexes.keys()) {
      if (!expectedIndexNames.has(indexName)) {
        throw new Error(`core schema invariant found unexpected index ${indexName}`);
      }
    }
    const indexEvidence = [];
    for (const row of expectedIndexesResult.rows) {
      const indexName = String(row.name);
      const tableName = String(row.tbl_name);
      if (actualIndexes.get(indexName) !== tableName) {
        throw new Error(`core schema invariant missing index ${indexName} on ${tableName}`);
      }
      const [expectedShape, actualShape] = await Promise.all([
        indexShape(expected, tableName, indexName),
        indexShape(client, tableName, indexName),
      ]);
      if (JSON.stringify(actualShape) !== JSON.stringify(expectedShape)) {
        throw new Error(`core schema invariant drift at index ${indexName}`);
      }
      indexEvidence.push({ indexName, tableName, expectedShape });
    }

    const triggers = await client.execute(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    );
    const actualTriggerHashes = new Map(
      triggers.rows.map((row) => [String(row.name), hash(normalizedSql(row.sql))]),
    );
    for (const name of actualTriggerHashes.keys()) {
      if (!(name in CORE_SECURITY_TRIGGER_SHA256)) {
        throw new Error(`core security trigger invariant found unexpected trigger ${name}`);
      }
    }
    for (const [name, expectedHash] of Object.entries(CORE_SECURITY_TRIGGER_SHA256)) {
      const actualHash = actualTriggerHashes.get(name);
      if (actualHash !== expectedHash) {
        throw new Error(
          `core security trigger invariant drift at ${name}: expected ${expectedHash}, got ${actualHash ?? "missing"}`,
        );
      }
    }

    return {
      tableCount: expectedTables.length,
      indexCount: expectedIndexesResult.rows.length,
      triggerCount: Object.keys(CORE_SECURITY_TRIGGER_SHA256).length,
      fingerprint: hash(JSON.stringify({
        shapeEvidence,
        indexEvidence,
        triggers: CORE_SECURITY_TRIGGER_SHA256,
      })),
    };
  } finally {
    expected.close();
  }
}

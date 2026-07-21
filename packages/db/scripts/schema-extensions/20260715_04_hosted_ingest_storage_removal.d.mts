export const HOSTED_INGEST_STORAGE_REMOVAL_SCHEMA_STATEMENTS: readonly string[];

export const HOSTED_INGEST_STORAGE_REMOVAL_SCHEMA_EXTENSION: Readonly<{
  id: string;
  schemaProjection: string;
  statements: readonly string[];
  tables: readonly string[];
}>;

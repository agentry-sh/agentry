export const READ_ONLY_SCHEMA_HARD_CUT_TRIGGER_STATEMENTS: readonly string[];

export const READ_ONLY_SCHEMA_HARD_CUT_SCHEMA_EXTENSION: Readonly<{
  id: string;
  schemaProjection: string;
  statements: readonly string[];
  tables: readonly string[];
}>;

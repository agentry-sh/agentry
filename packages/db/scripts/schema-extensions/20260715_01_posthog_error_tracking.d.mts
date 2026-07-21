export const POSTHOG_ERROR_TRACKING_SCHEMA_STATEMENTS: readonly string[];

export const POSTHOG_ERROR_TRACKING_SCHEMA_EXTENSION: Readonly<{
  id: string;
  schemaProjection: string;
  statements: readonly string[];
  tables: readonly string[];
}>;

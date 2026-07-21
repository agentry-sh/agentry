export const POSTHOG_OAUTH_CONNECTION_SCHEMA_STATEMENTS: readonly string[];

export const POSTHOG_OAUTH_CONNECTION_SCHEMA_EXTENSION: Readonly<{
  id: string;
  schemaProjection: string;
  statements: readonly string[];
  tables: readonly string[];
}>;

import assert from "node:assert/strict";
import test from "node:test";
import {
  findForbiddenKey,
  parseArgs,
  safeResourceId,
  surveyResponseWindow,
  validatedBaseUrl,
} from "./run-posthog-read-live-test.mjs";

test("parses only explicit project and API options", () => {
  assert.deepEqual(
    parseArgs(["--project-id", "project-1", "--api", "https://api.agentry.test"]),
    { projectId: "project-1", api: "https://api.agentry.test" },
  );
  assert.throws(() => parseArgs(["--project-id"]), /requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("allows HTTPS and loopback HTTP without credential-bearing URLs", () => {
  assert.equal(validatedBaseUrl("https://api.agentry.test/"), "https://api.agentry.test");
  assert.equal(validatedBaseUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => validatedBaseUrl("http://api.agentry.test"), /must use HTTPS/);
  assert.throws(
    () => validatedBaseUrl("https://owner:secret@api.agentry.test"),
    /exact origin/,
  );
  assert.throws(() => validatedBaseUrl("https://api.agentry.test/v1"), /exact origin/);
});

test("survey response reads require an explicit ordered bounded pair", () => {
  assert.equal(surveyResponseWindow({}), null);
  assert.throws(() => surveyResponseWindow({
    AGENTRY_POSTHOG_SURVEY_RESPONSES_SINCE: "2026-07-01T00:00:00Z",
  }), /Set both/);
  assert.deepEqual(surveyResponseWindow({
    AGENTRY_POSTHOG_SURVEY_RESPONSES_SINCE: "2026-07-01T00:00:00Z",
    AGENTRY_POSTHOG_SURVEY_RESPONSES_UNTIL: "2026-07-31T00:00:00Z",
  }), {
    since: "2026-07-01T00:00:00Z",
    until: "2026-07-31T00:00:00Z",
  });
  assert.throws(() => surveyResponseWindow({
    AGENTRY_POSTHOG_SURVEY_RESPONSES_SINCE: "2026-07-31T00:00:00Z",
    AGENTRY_POSTHOG_SURVEY_RESPONSES_UNTIL: "2026-07-01T00:00:00Z",
  }), /ordered/);
  assert.throws(() => surveyResponseWindow({
    AGENTRY_POSTHOG_SURVEY_RESPONSES_SINCE: "2026-01-01T00:00:00Z",
    AGENTRY_POSTHOG_SURVEY_RESPONSES_UNTIL: "2026-07-01T00:00:00Z",
  }), /90 days/);
});

test("detects nested recording content and accepts only bounded provider ids", () => {
  assert.equal(
    findForbiddenKey(
      { session_recording: { metadata: { snapshots: [{ data: "not-read" }] } } },
      new Set(["snapshots", "content"]),
    ),
    "$.session_recording.metadata.snapshots",
  );
  assert.equal(findForbiddenKey({ session_recording: { id: "rec-1" } }, new Set(["snapshots"])), null);
  assert.equal(safeResourceId(42, "flag"), "42");
  assert.equal(safeResourceId("survey:a.b-c_1", "survey"), "survey:a.b-c_1");
  assert.throws(() => safeResourceId("../survey", "survey"), /invalid resource id/);
});

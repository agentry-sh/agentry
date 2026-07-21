import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactError,
  redactArtifactText,
  redactArtifactValue,
  registerArtifactRedactionValues,
  resetArtifactRedactionValuesForTests,
} from "./artifact-redaction.mjs";

test("redacts opaque credentials from fatal, cleanup, and unexpected-response artifacts", () => {
  const fatal = new Error(
    'Unexpected 201\n{"credential":"opaque-fatal-secret","api_key":"opaque-api-secret"}',
  );
  fatal.detail = {
    body: {
      credential: "opaque-response-secret",
      nested: { client_secret: "opaque-client-secret" },
    },
  };
  const artifact = redactArtifactValue({
    fatal_error: artifactError(fatal),
    cleanup: { error: "credential=opaque-cleanup-secret" },
    results: {
      response: {
        authorization: "opaque-authorization-secret",
        public_key: "agentry_pk_known-prefix-secret",
      },
    },
  });
  const serialized = JSON.stringify(artifact);
  for (const secret of [
    "opaque-fatal-secret",
    "opaque-api-secret",
    "opaque-response-secret",
    "opaque-client-secret",
    "opaque-cleanup-secret",
    "opaque-authorization-secret",
    "known-prefix-secret",
  ]) {
    assert(!serialized.includes(secret), `artifact retained ${secret}`);
  }
  assert(serialized.includes("<redacted>"));
});

test("redacts dynamically registered auth scalars and proof markers from text and structured values", () => {
  resetArtifactRedactionValuesForTests();
  const opaqueAuth = "sk-proj-opaque-with-no-supported-prefix";
  const proofMarker = "proof-marker-scalar-with-no-supported-prefix";
  const nestedCredential = "nested-auth-json-scalar-value";
  registerArtifactRedactionValues({
    auth_file: { access: opaqueAuth, nested: [nestedCredential] },
    proof_marker: proofMarker,
  });

  const text = redactArtifactText(`stdout=${opaqueAuth}\nstderr=${proofMarker}\njson=${nestedCredential}`);
  const structured = JSON.stringify(redactArtifactValue({
    message: `received ${opaqueAuth}`,
    output: proofMarker,
    detail: { value: nestedCredential },
  }));
  for (const secret of [opaqueAuth, proofMarker, nestedCredential]) {
    assert(!text.includes(secret), `plain text retained ${secret}`);
    assert(!structured.includes(secret), `structured value retained ${secret}`);
  }
  assert.match(text, /<redacted-exact>/);
  assert.match(structured, /<redacted-exact>/);
  resetArtifactRedactionValuesForTests();
});

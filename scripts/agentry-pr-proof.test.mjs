import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTOMATION_ID,
  PLAYBOOK,
  ProofError,
  REQUIRED_TESTS,
  USER_AGENT,
  collectGithubProof,
  parseRunIdMarker,
  postAgentryProof,
  summarizeChangedFiles,
} from "./agentry-pr-proof.mjs";

const RUN_ID = "01900000-0000-7000-8000-000000000001";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubFixture(overrides = {}) {
  return {
    number: 17,
    state: "open",
    draft: true,
    body: `Repair summary.\n\n<!-- agentry-automation-run-id: ${RUN_ID} -->`,
    html_url: "https://github.com/agentry-sh/agentry/pull/17",
    changed_files: 2,
    additions: 14,
    deletions: 3,
    head: {
      sha: HEAD_SHA,
      ref: "codex/agentry-repair-17",
      repo: { full_name: "agentry-sh/agentry" },
    },
    base: {
      sha: BASE_SHA,
      ref: "main",
      repo: {
        full_name: "agentry-sh/agentry",
        html_url: "https://github.com/agentry-sh/agentry",
      },
    },
    ...overrides,
  };
}

const FILES = [
  {
    filename: "apps/api/src/example.ts",
    status: "modified",
    additions: 10,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
  },
  {
    filename: "apps/api/test/example.test.ts",
    status: "added",
    additions: 4,
    deletions: 2,
    patch: "@@ -0,0 +1,2 @@\n+test one\n+test two",
  },
];

function regularTreeEntry(path) {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha: "c".repeat(40),
    size: 12,
  };
}

function treeFixture(sha, entries, overrides = {}) {
  return {
    sha,
    truncated: false,
    tree: entries,
    ...overrides,
  };
}

const HEAD_TREE = treeFixture(HEAD_SHA, [
  regularTreeEntry("apps/api/src/example.ts"),
  regularTreeEntry("apps/api/test/example.test.ts"),
]);
const BASE_TREE = treeFixture(BASE_SHA, [
  regularTreeEntry("apps/api/src/example.ts"),
]);

test("accepts exactly one standalone canonical UUIDv7 run marker", () => {
  assert.equal(
    parseRunIdMarker(
      `Summary\r\n<!-- agentry-automation-run-id: ${RUN_ID.toUpperCase()} -->\r\n`,
    ),
    RUN_ID,
  );
  assert.equal(parseRunIdMarker("An ordinary draft PR."), null);
});

test("rejects inline, malformed, and duplicate run markers", () => {
  const invalidBodies = [
    `Summary <!-- agentry-automation-run-id: ${RUN_ID} -->`,
    `<!-- agentry-automation-run-id:${RUN_ID} -->`,
    `<!-- agentry-automation-run-id: 01900000-0000-4000-8000-000000000001 -->`,
    `<!-- agentry-automation-run-id: ${RUN_ID} -->\n<!-- agentry-automation-run-id: ${RUN_ID} -->`,
  ];
  for (const body of invalidBodies) {
    assert.throws(
      () => parseRunIdMarker(body),
      (error) =>
        error instanceof ProofError && error.code === "invalid_run_id_marker",
    );
  }
});

test("sorts provider paths and derives deterministic bounded evidence", () => {
  assert.deepEqual(summarizeChangedFiles([...FILES].reverse()), {
    change_types: ["application_code", "tests"],
    changed_files: ["apps/api/src/example.ts", "apps/api/test/example.test.ts"],
    changed_lines: { added: 14, deleted: 3 },
  });
});

test("fails closed for out-of-scope, oversized, and cross-boundary rename diffs", () => {
  const cases = [
    [
      {
        filename: ".github/workflows/unsafe.yml",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      "changed_file_out_of_scope",
    ],
    [
      {
        filename: "apps/api/src/large.ts",
        status: "modified",
        additions: 241,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+large",
      },
      "provider_diff_too_large",
    ],
    [
      {
        filename: "apps/api/test/moved.test.ts",
        previous_filename: "apps/api/src/moved.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patch: "similarity index 100%",
      },
      "renamed_file_crosses_scope",
    ],
  ];
  for (const [file, code] of cases) {
    assert.throws(
      () => summarizeChangedFiles([file]),
      (error) => error instanceof ProofError && error.code === code,
    );
  }
});

test("rejects missing, empty, and NUL-bearing provider patches", () => {
  for (const patch of [undefined, null, "", "@@ -1 +1 @@\n-old\0value\n+new"]) {
    const file = { ...FILES[0], patch };
    if (patch === undefined) delete file.patch;
    assert.throws(
      () => summarizeChangedFiles([file]),
      (error) =>
        error instanceof ProofError && error.code === "non_text_provider_diff",
    );
  }
});

test("derives every proof fact from the GitHub API and binds tested head/base", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/pulls/17")) return jsonResponse(200, githubFixture());
    if (url.includes("/pulls/17/files?")) return jsonResponse(200, FILES);
    if (url.includes(`/git/trees/${HEAD_SHA}?recursive=1`)) {
      return jsonResponse(200, HEAD_TREE);
    }
    if (url.includes(`/git/trees/${BASE_SHA}?recursive=1`)) {
      return jsonResponse(200, BASE_TREE);
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const proof = await collectGithubProof({
    fetchImpl,
    githubApiUrl: "https://api.github.com",
    githubServerUrl: "https://github.com",
    githubToken: "github-read-token",
    repository: "agentry-sh/agentry",
    prNumber: 17,
    expectedHeadSha: HEAD_SHA,
    expectedBaseSha: BASE_SHA,
    ciUrl: "https://github.com/agentry-sh/agentry/actions/runs/123",
  });

  assert.deepEqual(proof, {
    status: "ready",
    run_id: RUN_ID,
    payload: {
      vcs_provider: "github",
      repository: "https://github.com/agentry-sh/agentry",
      pr_url: "https://github.com/agentry-sh/agentry/pull/17",
      pr_number: 17,
      draft: true,
      head_sha: HEAD_SHA,
      head_branch: "codex/agentry-repair-17",
      base_branch: "main",
      change_types: ["application_code", "tests"],
      changed_files: [
        "apps/api/src/example.ts",
        "apps/api/test/example.test.ts",
      ],
      changed_lines: { added: 14, deleted: 3 },
      tests: REQUIRED_TESTS,
      ci_url: "https://github.com/agentry-sh/agentry/actions/runs/123",
    },
  });
  assert.equal(requests.length, 4);
  assert.equal(
    requests.some(({ url }) =>
      url.includes(`/git/trees/${HEAD_SHA}?recursive=1`),
    ),
    true,
  );
  assert.equal(
    requests.some(({ url }) =>
      url.includes(`/git/trees/${BASE_SHA}?recursive=1`),
    ),
    true,
  );
  assert.equal(
    requests.every(({ init }) => init.headers["user-agent"] === USER_AGENT),
    true,
  );
  assert.equal(
    requests.every(
      ({ init }) => init.headers.authorization === "Bearer github-read-token",
    ),
    true,
  );
});

test("rejects symlink and other non-regular provider tree objects", async () => {
  const file = {
    filename: "apps/api/src/example.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "@@ -1 +1 @@\n-old\n+new",
  };
  const nonRegularEntries = [
    { ...regularTreeEntry(file.filename), mode: "120000" },
    {
      ...regularTreeEntry(file.filename),
      mode: "160000",
      type: "commit",
    },
  ];

  for (const entry of nonRegularEntries) {
    const fetchImpl = async (url) => {
      if (url.endsWith("/pulls/17")) {
        return jsonResponse(
          200,
          githubFixture({ changed_files: 1, additions: 1, deletions: 0 }),
        );
      }
      if (url.includes("/pulls/17/files?")) {
        return jsonResponse(200, [file]);
      }
      if (url.includes(`/git/trees/${HEAD_SHA}?recursive=1`)) {
        return jsonResponse(200, treeFixture(HEAD_SHA, [entry]));
      }
      if (url.includes(`/git/trees/${BASE_SHA}?recursive=1`)) {
        return jsonResponse(
          200,
          treeFixture(BASE_SHA, [regularTreeEntry(file.filename)]),
        );
      }
      throw new Error(`unexpected URL ${url}`);
    };

    await assert.rejects(
      collectGithubProof({
        fetchImpl,
        githubApiUrl: "https://api.github.com",
        githubServerUrl: "https://github.com",
        githubToken: "github-read-token",
        repository: "agentry-sh/agentry",
        prNumber: 17,
        expectedHeadSha: HEAD_SHA,
        expectedBaseSha: BASE_SHA,
      }),
      (error) =>
        error instanceof ProofError &&
        error.code === "non_regular_changed_file",
    );
  }
});

test("fails closed when GitHub truncates an exact revision tree", async () => {
  const file = {
    filename: "apps/api/src/added.ts",
    status: "added",
    additions: 1,
    deletions: 0,
    patch: "@@ -0,0 +1 @@\n+export {};",
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/pulls/17")) {
      return jsonResponse(
        200,
        githubFixture({ changed_files: 1, additions: 1, deletions: 0 }),
      );
    }
    if (url.includes("/pulls/17/files?")) return jsonResponse(200, [file]);
    if (url.includes(`/git/trees/${HEAD_SHA}?recursive=1`)) {
      return jsonResponse(
        200,
        treeFixture(HEAD_SHA, [regularTreeEntry(file.filename)], {
          truncated: true,
        }),
      );
    }
    throw new Error(`unexpected URL ${url}`);
  };

  await assert.rejects(
    collectGithubProof({
      fetchImpl,
      githubApiUrl: "https://api.github.com",
      githubServerUrl: "https://github.com",
      githubToken: "github-read-token",
      repository: "agentry-sh/agentry",
      prNumber: 17,
      expectedHeadSha: HEAD_SHA,
      expectedBaseSha: BASE_SHA,
    }),
    (error) =>
      error instanceof ProofError && error.code === "provider_tree_truncated",
  );
});

test("refuses stale tested facts and same-event fork PRs", async () => {
  for (const [overrides, code] of [
    [
      { head: { ...githubFixture().head, sha: "c".repeat(40) } },
      "tested_head_changed",
    ],
    [
      {
        head: { ...githubFixture().head, repo: { full_name: "attacker/fork" } },
      },
      "pr_repository_mismatch",
    ],
    [{ draft: false }, "pr_not_open_draft"],
  ]) {
    const fetchImpl = async (url) =>
      url.endsWith("/pulls/17")
        ? jsonResponse(200, githubFixture(overrides))
        : jsonResponse(200, FILES);
    await assert.rejects(
      collectGithubProof({
        fetchImpl,
        githubApiUrl: "https://api.github.com",
        githubServerUrl: "https://github.com",
        githubToken: "github-read-token",
        repository: "agentry-sh/agentry",
        prNumber: 17,
        expectedHeadSha: HEAD_SHA,
        expectedBaseSha: BASE_SHA,
      }),
      (error) => error instanceof ProofError && error.code === code,
    );
  }
});

test("treats an ordinary unmarked draft PR as a no-side-effect skip", async () => {
  const requests = [];
  const proof = await collectGithubProof({
    fetchImpl: async (url) => {
      requests.push(url);
      return jsonResponse(200, githubFixture({ body: "Ordinary draft PR." }));
    },
    githubApiUrl: "https://api.github.com",
    githubServerUrl: "https://github.com",
    githubToken: "github-read-token",
    repository: "agentry-sh/agentry",
    prNumber: 17,
    expectedHeadSha: HEAD_SHA,
    expectedBaseSha: BASE_SHA,
  });

  assert.deepEqual(proof, {
    status: "skipped",
    reason: "no_agentry_run_id_marker",
  });
  assert.equal(requests.length, 1);
});

test("posts only the provider payload with CI auth and a custom User-Agent", async () => {
  let captured;
  const payload = { vcs_provider: "github", draft: true };
  const result = await postAgentryProof({
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse(200, {
        run_id: RUN_ID,
        proof_hash: "d".repeat(64),
        idempotent_replay: false,
      });
    },
    apiBaseUrl: "https://api.agentry.sh",
    ciApiKey: `agentry_ci_${"s".repeat(32)}`,
    runId: RUN_ID,
    payload,
  });

  assert.equal(
    captured.url,
    `https://api.agentry.sh/v1/automation-runs/${RUN_ID}/pr-proof`,
  );
  assert.equal(
    captured.init.headers.authorization,
    `Bearer agentry_ci_${"s".repeat(32)}`,
  );
  assert.equal(captured.init.headers["user-agent"], USER_AGENT);
  assert.deepEqual(JSON.parse(captured.init.body), payload);
  assert.equal(result.proof_hash, "d".repeat(64));
});

test("workflow keeps PR code secret-free and proof code pinned to the trusted base SHA", async () => {
  const workflow = await readFile(
    new URL(
      "../.github/workflows/agentry-self-repair-pr-proof.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const [beforeProof, proofJob] = workflow.split("  trusted_pr_proof:\n");
  assert.ok(beforeProof.includes("pull_request_target:"));
  assert.ok(
    beforeProof.includes("ref: ${{ github.event.pull_request.head.sha }}"),
  );
  assert.ok(beforeProof.includes("persist-credentials: false"));
  assert.equal(beforeProof.includes("AGENTRY_AUTOMATION_CI_API_KEY"), false);
  assert.ok(
    proofJob.includes("ref: ${{ github.event.pull_request.base.sha }}"),
  );
  assert.ok(
    proofJob.includes(
      "AGENTRY_AUTOMATION_CI_API_KEY: ${{ secrets.AGENTRY_AUTOMATION_CI_API_KEY }}",
    ),
  );
  assert.ok(proofJob.includes(`AGENTRY_AUTOMATION_ID: ${AUTOMATION_ID}`));
  assert.ok(proofJob.includes(`AGENTRY_PLAYBOOK: ${PLAYBOOK}`));
  for (const testEvidence of REQUIRED_TESTS) {
    assert.ok(beforeProof.includes(`run: ${testEvidence.command}`));
  }
  assert.equal(workflow.includes("gh pr merge"), false);
  assert.equal(workflow.includes("/v1/deploys"), false);
  assert.equal(workflow.includes("git push"), false);
});

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyFiles,
  evaluateCommitStatuses,
  getStatusSha,
  validatePolicy,
} = require("../lib/gate");

const policy = validatePolicy({
  gateCheckName: "Ruleset Test Safe PR Gate",
  maxChangedLines: 100,
  maxFiles: 1,
  requiredCommitStatuses: [{ context: "ruleset-test/bot-check" }],
  safePaths: ["README.md"],
  trustedAuthorLogins: ["mattbodle"],
});

function safeFile(overrides = {}) {
  return {
    changes: 3,
    filename: "README.md",
    patch: "@@ -1 +1 @@\n-old\n+new",
    status: "modified",
    ...overrides,
  };
}

function safeTree(overrides = {}) {
  return [{ mode: "100644", path: "README.md", type: "blob", ...overrides }];
}

test("allows an ordinary root README change", () => {
  assert.deepEqual(classifyFiles([safeFile()], safeTree(), policy), {
    eligible: true,
    reasons: [],
  });
});

test("fails closed for source, mixed, renamed, executable, or unavailable files", () => {
  assert.equal(
    classifyFiles([safeFile({ filename: "app.js" })], safeTree(), policy).eligible,
    false,
  );
  assert.equal(classifyFiles([safeFile(), safeFile()], safeTree(), policy).eligible, false);
  assert.equal(
    classifyFiles(
      [safeFile({ previous_filename: "OLD_README.md", status: "renamed" })],
      safeTree(),
      policy,
    ).eligible,
    false,
  );
  assert.equal(classifyFiles([safeFile()], safeTree({ mode: "100755" }), policy).eligible, false);
  assert.equal(classifyFiles([safeFile({ patch: undefined })], safeTree(), policy).eligible, false);
});

test("requires the latest named bot status to be successful", () => {
  assert.equal(evaluateCommitStatuses([], policy.requiredCommitStatuses).state, "pending");
  assert.equal(
    evaluateCommitStatuses(
      [
        { context: "ruleset-test/bot-check", id: 1, state: "success", updated_at: "2026-01-01T00:00:00Z" },
        { context: "ruleset-test/bot-check", id: 2, state: "pending", updated_at: "2026-01-01T00:01:00Z" },
      ],
      policy.requiredCommitStatuses,
    ).state,
    "pending",
  );
  assert.equal(
    evaluateCommitStatuses(
      [{ context: "ruleset-test/bot-check", id: 3, state: "failure", updated_at: "2026-01-01T00:02:00Z" }],
      policy.requiredCommitStatuses,
    ).state,
    "failed",
  );
  assert.equal(
    evaluateCommitStatuses(
      [{ context: "ruleset-test/bot-check", id: 4, state: "success", updated_at: "2026-01-01T00:03:00Z" }],
      policy.requiredCommitStatuses,
    ).state,
    "success",
  );
});

test("rejects unsafe policy and maps a status event to its SHA", () => {
  assert.throws(() => validatePolicy({ ...policy, safePaths: ["docs/*.md"] }));
  assert.throws(() => validatePolicy({ ...policy, trustedAuthorLogins: [] }));
  const sha = "a".repeat(40);
  assert.equal(getStatusSha({ commit: { sha } }), sha);
});

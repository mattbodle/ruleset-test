const ALLOWED_FILE_STATUSES = new Set(["added", "modified"]);

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") {
    throw new Error("Policy must be an object.");
  }

  if (
    typeof policy.gateCheckName !== "string" ||
    policy.gateCheckName.trim().length === 0
  ) {
    throw new Error("Policy must define a gate check name.");
  }

  if (
    !Number.isSafeInteger(policy.maxFiles) ||
    policy.maxFiles < 1 ||
    !Number.isSafeInteger(policy.maxChangedLines) ||
    policy.maxChangedLines < 1
  ) {
    throw new Error("Policy file and line limits must be positive integers.");
  }

  if (!Array.isArray(policy.safePaths) || policy.safePaths.length === 0) {
    throw new Error("Policy must define safe paths.");
  }

  if (
    !Array.isArray(policy.requiredCommitStatuses) ||
    policy.requiredCommitStatuses.length === 0
  ) {
    throw new Error("Policy must define required commit statuses.");
  }

  if (
    !Array.isArray(policy.trustedAuthorLogins) ||
    policy.trustedAuthorLogins.length === 0
  ) {
    throw new Error("Policy must define trusted test authors.");
  }

  for (const path of policy.safePaths) {
    if (
      typeof path !== "string" ||
      !path.endsWith(".md") ||
      path.includes("*") ||
      path.startsWith(".github/")
    ) {
      throw new Error("Safe paths must be explicit, non-workflow Markdown paths.");
    }
  }

  for (const status of policy.requiredCommitStatuses) {
    if (typeof status?.context !== "string" || !status.context.trim()) {
      throw new Error("Each required status must define a context.");
    }
  }

  return policy;
}

function classifyFiles(files, treeEntries, policy) {
  const safePaths = new Set(policy.safePaths);
  const treeByPath = new Map(treeEntries.map((entry) => [entry.path, entry]));
  const reasons = [];
  const changedLines = files.reduce(
    (total, file) => total + (Number.isSafeInteger(file.changes) ? file.changes : 0),
    0,
  );

  if (files.length === 0) reasons.push("no changed files");
  if (files.length > policy.maxFiles) reasons.push("too many changed files");
  if (changedLines > policy.maxChangedLines) reasons.push("too many changed lines");

  for (const file of files) {
    const treeEntry = treeByPath.get(file.filename);
    if (!safePaths.has(file.filename)) reasons.push("path is not allowlisted");
    if (!ALLOWED_FILE_STATUSES.has(file.status) || file.previous_filename) {
      reasons.push("file operation is not allowed");
    }
    if (typeof file.patch !== "string") reasons.push("file diff is unavailable");
    if (!treeEntry || treeEntry.type !== "blob" || treeEntry.mode !== "100644") {
      reasons.push("file mode or type is not allowed");
    }
  }

  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function evaluateCommitStatuses(statuses, requirements) {
  for (const requirement of requirements) {
    const latest = statuses
      .filter((status) => status.context === requirement.context)
      .sort((left, right) => {
        const leftTime = Date.parse(left.updated_at || left.created_at || 0) || 0;
        const rightTime = Date.parse(right.updated_at || right.created_at || 0) || 0;
        return rightTime - leftTime || (Number(right.id) || 0) - (Number(left.id) || 0);
      })[0];

    if (!latest || latest.state === "pending") {
      return { state: "pending", context: requirement.context };
    }
    if (latest.state !== "success") {
      return { state: "failed", context: requirement.context };
    }
  }
  return { state: "success" };
}

function getStatusSha(event) {
  return [event?.sha, event?.commit?.sha].find(
    (sha) => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha),
  );
}

module.exports = { classifyFiles, evaluateCommitStatuses, getStatusSha, validatePolicy };

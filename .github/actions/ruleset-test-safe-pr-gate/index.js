const fs = require("node:fs");
const {
  classifyFiles,
  evaluateCommitStatuses,
  getStatusSha,
  validatePolicy,
} = require("./lib/gate");

function getInput(name) {
  const normalizedName = name.toUpperCase();
  return (
    process.env[`INPUT_${normalizedName}`]?.trim() ||
    process.env[`INPUT_${normalizedName.replace(/-/g, "_")}`]?.trim() ||
    ""
  );
}

function requiredInput(name) {
  const value = getInput(name);
  if (!value) throw new Error(`Missing required input: ${name}`);
  return value;
}

function optionalPullRequestNumber() {
  const value = getInput("pr-number");
  if (!value) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error("pr-number must be a positive integer.");
  }
  return Number(value);
}

function toQueryPath(path, query) {
  const url = new URL(path, "https://github.invalid");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

function nextPage(header) {
  return header?.match(/<([^>]+)>; rel="next"/)?.[1] || null;
}

function createApi(apiUrl, token) {
  async function request(path, options = {}) {
    const response = await fetch(new URL(path, apiUrl), {
      method: options.method || "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok && !(options.allowStatuses || []).includes(response.status)) {
      throw new Error(`GitHub API request failed with status ${response.status}.`);
    }
    return { data, headers: response.headers, status: response.status };
  }

  async function paginate(path, collectionKey) {
    const items = [];
    let next = path;
    while (next) {
      const response = await request(next);
      const page = collectionKey ? response.data?.[collectionKey] : response.data;
      if (!Array.isArray(page)) throw new Error("Expected a paginated API response.");
      items.push(...page);
      next = nextPage(response.headers.get("link"));
    }
    return items;
  }

  return { paginate, request };
}

async function latestGateCheck(api, details) {
  const checks = await api.paginate(
    toQueryPath(
      `/repos/${details.owner}/${details.repository}/commits/${details.sha}/check-runs`,
      { check_name: details.checkName, per_page: "100" },
    ),
    "check_runs",
  );
  return checks
    .filter((check) => check.app?.slug === "github-actions")
    .sort((left, right) => right.id - left.id)[0];
}

async function writeGate(api, details, conclusion, summary) {
  const check = await latestGateCheck(api, details);
  const body = {
    name: details.checkName,
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    output: { title: details.checkName, summary },
  };
  if (check) {
    await api.request(`/repos/${details.owner}/${details.repository}/check-runs/${check.id}`, {
      method: "PATCH",
      body,
    });
    return;
  }
  await api.request(`/repos/${details.owner}/${details.repository}/check-runs`, {
    method: "POST",
    body: {
      ...body,
      external_id: `ruleset-test-safe-pr-gate:${details.prNumber}:${details.sha}`,
      head_sha: details.sha,
    },
  });
}

async function ensureGatePending(api, details, summary) {
  const check = await latestGateCheck(api, details);
  if (check && check.status !== "completed") return;
  await api.request(`/repos/${details.owner}/${details.repository}/check-runs`, {
    method: "POST",
    body: {
      external_id: `ruleset-test-safe-pr-gate:${details.prNumber}:${details.sha}`,
      head_sha: details.sha,
      name: details.checkName,
      status: "in_progress",
      output: { title: details.checkName, summary },
    },
  });
}

async function resolvePullRequestNumbers(event, api, owner, repository, requested) {
  if (requested) return [requested];
  if (Number.isInteger(event?.pull_request?.number)) return [event.pull_request.number];
  const sha = getStatusSha(event);
  if (sha) {
    const pullRequests = await api.paginate(
      toQueryPath(`/repos/${owner}/${repository}/commits/${sha}/pulls`, { per_page: "100" }),
    );
    return pullRequests
      .filter((pullRequest) => pullRequest.state === "open")
      .map((pullRequest) => pullRequest.number)
      .filter(Number.isInteger);
  }
  if (event.schedule) {
    const pullRequests = await api.paginate(
      toQueryPath(`/repos/${owner}/${repository}/pulls`, { per_page: "100", state: "open" }),
    );
    return pullRequests
      .filter((pullRequest) => pullRequest.state === "open")
      .map((pullRequest) => pullRequest.number)
      .filter(Number.isInteger);
  }
  return [];
}

async function evaluatePullRequest(context, prNumber) {
  const pr = (
    await context.api.request(`/repos/${context.owner}/${context.repository}/pulls/${prNumber}`)
  ).data;
  if (pr.state !== "open") return true;

  const details = {
    checkName: context.policy.gateCheckName,
    owner: context.owner,
    prNumber,
    repository: context.repository,
    sha: pr.head.sha,
  };
  try {
    if (pr.draft) {
      await writeGate(context.api, details, "success", "Draft PR; re-evaluate when ready.");
      return true;
    }
    const [files, tree] = await Promise.all([
      context.api.paginate(
        toQueryPath(`/repos/${context.owner}/${context.repository}/pulls/${prNumber}/files`, {
          per_page: "100",
        }),
      ),
      context.api.request(
        `/repos/${context.owner}/${context.repository}/git/trees/${pr.head.sha}?recursive=1`,
      ),
    ]);
    if (tree.data.truncated) {
      await writeGate(context.api, details, "failure", "Could not safely inspect the file tree.");
      return true;
    }
    const filesState = classifyFiles(files, tree.data.tree, context.policy);
    if (!filesState.eligible) {
      await writeGate(
        context.api,
        details,
        "action_required",
        `Outside the POC safe path: ${filesState.reasons.join(", ")}.`,
      );
      return true;
    }
    const statuses = await context.api.paginate(
      toQueryPath(
        `/repos/${context.owner}/${context.repository}/commits/${pr.head.sha}/statuses`,
        { per_page: "100" },
      ),
    );
    const statusState = evaluateCommitStatuses(statuses, context.policy.requiredCommitStatuses);
    if (statusState.state === "pending") {
      await ensureGatePending(
        context.api,
        details,
        `Waiting for ${statusState.context} on the current head SHA.`,
      );
      return true;
    }
    if (statusState.state === "failed") {
      await writeGate(context.api, details, "failure", `${statusState.context} did not succeed.`);
      return true;
    }
    const trustedAuthors = new Set(
      context.policy.trustedAuthorLogins.map((login) => login.toLowerCase()),
    );
    if (!trustedAuthors.has(pr.user.login.toLowerCase())) {
      await writeGate(
        context.api,
        details,
        "action_required",
        "Author is not in the test-only trusted-author allowlist.",
      );
      return true;
    }
    const conclusion = context.mode === "audit" ? "neutral" : "success";
    const prefix = context.mode === "audit" ? "Audit only: would report success. " : "";
    await writeGate(
      context.api,
      details,
      conclusion,
      `${prefix}Trusted author and test bot status passed for the current head SHA.`,
    );
    return true;
  } catch (error) {
    try {
      await writeGate(context.api, details, "failure", "Gate evaluation could not complete safely.");
    } catch {}
    console.error(`Ruleset Test Safe PR Gate failed for PR #${prNumber}.`, error);
    return false;
  }
}

async function main() {
  const event = JSON.parse(fs.readFileSync(requiredInput("event-path"), "utf8"));
  const owner = event.repository?.owner?.login;
  const repository = event.repository?.name;
  if (!owner || !repository) throw new Error("Event does not identify a repository.");
  const mode = requiredInput("mode");
  if (!new Set(["audit", "enforce"]).has(mode)) {
    throw new Error("mode must be audit or enforce.");
  }
  const context = {
    api: createApi(requiredInput("api-url"), requiredInput("github-token")),
    mode,
    owner,
    policy: validatePolicy(JSON.parse(fs.readFileSync(requiredInput("policy-path"), "utf8"))),
    repository,
  };
  const prNumbers = await resolvePullRequestNumbers(
    event,
    context.api,
    owner,
    repository,
    optionalPullRequestNumber(),
  );
  let succeeded = true;
  for (const prNumber of prNumbers) {
    succeeded = (await evaluatePullRequest(context, prNumber)) && succeeded;
  }
  if (!succeeded) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Ruleset Test Safe PR Gate failed.", error);
    process.exitCode = 1;
  });
}

module.exports = { getInput, resolvePullRequestNumbers };

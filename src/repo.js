import fs from "node:fs";
import path from "node:path";
import {
  hasReservedMarkerPrefix,
  parseGitignore,
  renderGitignoreBuffer
} from "./block.js";
import { atomicWriteFile, gitignorePath, repoRootForCwd } from "./paths.js";
import { readProfileTemplate } from "./registry.js";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readGitignore(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { exists: false, content: Buffer.alloc(0) };
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`refusing symbolic-link .gitignore: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`refusing non-file .gitignore: ${filePath}`);
  }
  return { exists: true, content: fs.readFileSync(filePath) };
}

function writeGitignore(filePath, content) {
  atomicWriteFile(filePath, content);
}

function buffersEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function assertTemplateIsNotDestination(templatePath, filePath, destinationExists) {
  if (!destinationExists) return;
  const templateStat = fs.statSync(templatePath);
  const destinationStat = fs.statSync(filePath);
  if (templateStat.dev === destinationStat.dev && templateStat.ino === destinationStat.ino) {
    throw new Error(`template must not be the managed .gitignore: ${filePath}`);
  }
}

function assertRenderedGitignore(profile, rendered, projectContent) {
  const parsed = parseGitignore(rendered);
  if (parsed.errors.length > 0) {
    throw new Error(`refusing to write invalid managed block: ${parsed.errors.join("; ")}`);
  }
  if (!parsed.hasBlock || parsed.profile !== profile) {
    throw new Error("refusing to write invalid managed block: rendered profile mismatch");
  }
  if (!buffersEqual(parsed.projectContent, projectContent)) {
    throw new Error("refusing to write invalid managed block: project content changed");
  }
}

function renderPlan(profile, template, projectContent) {
  const nextContent = renderGitignoreBuffer(profile, template.bytes, projectContent);
  assertRenderedGitignore(profile, nextContent, projectContent);
  return nextContent;
}

function detectManagedGitignore(repoRoot, env) {
  const filePath = gitignorePath(repoRoot);
  const gitignore = readGitignore(filePath);
  const parsed = parseGitignore(gitignore.content);
  const errors = [...parsed.errors];
  let expected = null;
  let inSync = null;
  let templatePath = null;

  if (parsed.hasBlock && parsed.errors.length === 0) {
    try {
      const template = readProfileTemplate(parsed.profile, env);
      templatePath = template.path;
      assertTemplateIsNotDestination(template.path, filePath, gitignore.exists);
      expected = renderPlan(parsed.profile, template, parsed.projectContent);
      inSync = expected.equals(gitignore.content);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  return {
    gitignorePath: filePath,
    gitignoreExists: gitignore.exists,
    content: gitignore.content,
    parsed,
    hasBlock: parsed.hasBlock,
    profile: parsed.profile,
    templatePath,
    expected,
    inSync,
    errors
  };
}

export function detectRepository({ cwd = process.cwd(), env = process.env } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const repoRoot = repoRootForCwd(resolvedCwd);
  const detected = detectManagedGitignore(repoRoot, env);
  return {
    cwd: resolvedCwd,
    repoRoot,
    gitignorePath: detected.gitignorePath,
    gitignoreExists: detected.gitignoreExists,
    hasBlock: detected.hasBlock,
    profile: detected.profile,
    templatePath: detected.templatePath,
    inSync: detected.inSync,
    errors: detected.errors
  };
}

function invalidExistingBlockMessage(errors) {
  return `invalid existing .gitignore managed block: ${errors.join("; ")}`;
}

function initPlan(profile, { cwd = process.cwd(), env = process.env } = {}) {
  const repoRoot = repoRootForCwd(cwd);
  const filePath = gitignorePath(repoRoot);
  const gitignore = readGitignore(filePath);
  const parsed = parseGitignore(gitignore.content);
  if (parsed.errors.length > 0) throw new Error(invalidExistingBlockMessage(parsed.errors));

  const template = readProfileTemplate(profile, env);
  assertTemplateIsNotDestination(template.path, filePath, gitignore.exists);
  let projectContent = gitignore.content.length > 0
    ? Buffer.concat([Buffer.from("\n"), gitignore.content])
    : Buffer.alloc(0);
  if (parsed.hasBlock) {
    if (parsed.profile !== profile) {
      throw new Error(`.gitignore is already managed by profile ${parsed.profile}`);
    }
    projectContent = parsed.projectContent;
  }

  const nextContent = renderPlan(profile, template, projectContent);
  return {
    repoRoot,
    gitignorePath: filePath,
    profile,
    templatePath: template.path,
    templateContent: template.bytes,
    originalExists: gitignore.exists,
    originalContent: gitignore.content,
    nextContent,
    changed: !nextContent.equals(gitignore.content)
  };
}

function syncPlan({ cwd = process.cwd(), env = process.env } = {}) {
  const repoRoot = repoRootForCwd(cwd);
  const filePath = gitignorePath(repoRoot);
  const gitignore = readGitignore(filePath);
  const parsed = parseGitignore(gitignore.content);

  if (!parsed.hasBlock) throw new Error("missing sharedgitignore managed block");
  if (parsed.errors.length > 0) throw new Error(invalidExistingBlockMessage(parsed.errors));

  const template = readProfileTemplate(parsed.profile, env);
  assertTemplateIsNotDestination(template.path, filePath, gitignore.exists);
  const nextContent = renderPlan(parsed.profile, template, parsed.projectContent);
  return {
    repoRoot,
    gitignorePath: filePath,
    profile: parsed.profile,
    templatePath: template.path,
    templateContent: template.bytes,
    originalExists: gitignore.exists,
    originalContent: gitignore.content,
    nextContent,
    changed: !nextContent.equals(gitignore.content)
  };
}

function publicPlanResult(plan, { dryRun, applied }) {
  return {
    repoRoot: plan.repoRoot,
    gitignorePath: plan.gitignorePath,
    profile: plan.profile,
    templatePath: plan.templatePath,
    changed: plan.changed,
    dryRun,
    applied
  };
}

function applyPlan(plan) {
  const current = readGitignore(plan.gitignorePath);
  if (current.exists !== plan.originalExists || !current.content.equals(plan.originalContent)) {
    throw new Error(".gitignore changed during planning");
  }
  writeGitignore(plan.gitignorePath, plan.nextContent);
}

export function initRepository(profile, { cwd = process.cwd(), env = process.env, dryRun = false } = {}) {
  const plan = initPlan(profile, { cwd, env });
  if (plan.changed && !dryRun) applyPlan(plan);
  return publicPlanResult(plan, { dryRun, applied: plan.changed && !dryRun });
}

export function syncRepository({ cwd = process.cwd(), env = process.env, dryRun = false } = {}) {
  const plan = syncPlan({ cwd, env });
  if (plan.changed && !dryRun) applyPlan(plan);
  return publicPlanResult(plan, { dryRun, applied: plan.changed && !dryRun });
}

export function checkRepository({ cwd = process.cwd(), env = process.env } = {}) {
  const detected = detectRepository({ cwd, env });
  const errors = [...detected.errors];
  if (!detected.hasBlock) errors.push("missing sharedgitignore managed block");
  if (errors.length > 0) {
    return {
      ...detected,
      valid: false,
      inSync: false,
      errors
    };
  }

  return {
    ...detected,
    valid: detected.inSync === true,
    errors: detected.inSync ? [] : ["managed block is stale"]
  };
}

function shouldSkipDir(name) {
  return new Set([".git", "node_modules", "Library", "Temp", "Obj", "Build", "Builds"]).has(name);
}

function validateDiscoveryRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("repository root must be a non-empty path");
  }
  const rootPath = path.resolve(root);
  let stat;
  try {
    stat = fs.statSync(rootPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`root does not exist: ${rootPath}`);
    }
    throw new Error(`cannot access root ${rootPath}: ${errorMessage(error)}`);
  }
  if (!stat.isDirectory()) throw new Error(`root is not a directory: ${rootPath}`);
  return rootPath;
}

export function findGitRepositories(root, { recursive = true } = {}) {
  const rootPath = validateDiscoveryRoot(root);
  const repositorySet = new Set();
  const diagnostics = [];

  function walk(dirPath) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (error) {
      const code = error && typeof error === "object" && error.code ? ` (${error.code})` : "";
      diagnostics.push({ path: dirPath, error: `unable to read directory${code}` });
      return;
    }

    const hasGitEntry = entries.some((entry) => entry.name === ".git");
    if (hasGitEntry) {
      try {
        const directoryRoot = fs.realpathSync(dirPath);
        const repositoryRoot = fs.realpathSync(repoRootForCwd(dirPath));
        if (repositoryRoot !== directoryRoot) {
          throw new Error(`Git reports a different repository root: ${repositoryRoot}`);
        }
        repositorySet.add(repositoryRoot);
        if (!recursive) return;
      } catch (error) {
        diagnostics.push({ path: dirPath, error: `invalid .git entry: ${errorMessage(error)}` });
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipDir(entry.name)) continue;
      walk(path.join(dirPath, entry.name));
    }
  }

  walk(rootPath);
  const repositories = [...repositorySet];
  repositories.sort((left, right) => left.localeCompare(right));
  diagnostics.sort((left, right) => left.path.localeCompare(right.path));
  return { root: rootPath, repositories, diagnostics };
}

function managedCandidate(repoRoot) {
  const filePath = gitignorePath(repoRoot);
  const gitignore = readGitignore(filePath);
  return hasReservedMarkerPrefix(gitignore.content);
}

function resultError(repoRoot, error, extra = {}) {
  return {
    repoRoot,
    skipped: false,
    changed: false,
    applied: false,
    ...extra,
    errors: [errorMessage(error)]
  };
}

function preflightSyncRepositories(discovery, env, dryRun) {
  const results = [];
  const plans = [];

  for (const discoveredRoot of discovery.repositories) {
    try {
      if (!managedCandidate(discoveredRoot)) {
        results.push({ repoRoot: discoveredRoot, skipped: true, reason: "missing managed block" });
        continue;
      }
      const plan = syncPlan({ cwd: discoveredRoot, env });
      const result = {
        ...publicPlanResult(plan, { dryRun, applied: false }),
        skipped: false,
        errors: []
      };
      results.push(result);
      plans.push({ plan, result });
    } catch (error) {
      results.push(resultError(discoveredRoot, error));
    }
  }
  return { results, plans };
}

function revalidatePlans(plans, env) {
  for (const { plan, result } of plans) {
    try {
      const current = readGitignore(plan.gitignorePath);
      if (current.exists !== plan.originalExists || !current.content.equals(plan.originalContent)) {
        throw new Error(".gitignore changed during batch preflight");
      }
      const template = readProfileTemplate(plan.profile, env);
      if (template.path !== plan.templatePath || !template.bytes.equals(plan.templateContent)) {
        throw new Error("template changed during batch preflight");
      }
      assertTemplateIsNotDestination(template.path, plan.gitignorePath, current.exists);
    } catch (error) {
      result.errors.push(errorMessage(error));
    }
  }
}

export function syncAllRepositories({ root, recursive = true, env = process.env, dryRun = false } = {}) {
  const discovery = findGitRepositories(root, { recursive });
  const { results, plans } = preflightSyncRepositories(discovery, env, dryRun);
  let aborted = discovery.diagnostics.length > 0 || results.some((result) => result.errors?.length > 0);

  if (!aborted && !dryRun) {
    revalidatePlans(plans, env);
    aborted = results.some((result) => result.errors?.length > 0);
  }

  if (!aborted && !dryRun) {
    for (const { plan, result } of plans) {
      if (!plan.changed) continue;
      try {
        writeGitignore(plan.gitignorePath, plan.nextContent);
        result.applied = true;
      } catch (error) {
        result.errors.push(errorMessage(error));
        aborted = true;
        break;
      }
    }
  }

  return {
    root: discovery.root,
    repositories: discovery.repositories,
    diagnostics: discovery.diagnostics,
    results,
    dryRun,
    aborted,
    appliedCount: results.filter((result) => result.applied).length
  };
}

export function checkAllRepositories({ root, recursive = true, env = process.env } = {}) {
  const discovery = findGitRepositories(root, { recursive });
  const results = [];

  for (const discoveredRoot of discovery.repositories) {
    try {
      if (!managedCandidate(discoveredRoot)) {
        results.push({ repoRoot: discoveredRoot, skipped: true, reason: "missing managed block" });
        continue;
      }
      results.push({
        ...checkRepository({ cwd: discoveredRoot, env }),
        skipped: false
      });
    } catch (error) {
      results.push(resultError(discoveredRoot, error, { valid: false, inSync: false }));
    }
  }

  return {
    root: discovery.root,
    repositories: discovery.repositories,
    diagnostics: discovery.diagnostics,
    results
  };
}

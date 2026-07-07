import fs from "node:fs";
import path from "node:path";
import { END_MARKER, parseGitignore, renderGitignore } from "./block.js";
import { gitignorePath, repoRootForCwd } from "./paths.js";
import { readProfileTemplate } from "./registry.js";

function readGitignore(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function writeGitignore(filePath, content) {
  fs.writeFileSync(filePath, content);
}

function detectManagedGitignore(repoRoot, env) {
  const filePath = gitignorePath(repoRoot);
  const content = readGitignore(filePath);
  const parsed = parseGitignore(content);
  const errors = [...parsed.errors];
  let expected = null;
  let inSync = null;
  let templatePath = null;

  if (parsed.hasBlock && parsed.errors.length === 0) {
    try {
      const template = readProfileTemplate(parsed.profile, env);
      templatePath = template.path;
      expected = renderGitignore(parsed.profile, template.content, parsed.projectContent);
      inSync = expected === content;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    gitignorePath: filePath,
    gitignoreExists: fs.existsSync(filePath),
    content,
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

export function initRepository(profile, { cwd = process.cwd(), env = process.env } = {}) {
  const repoRoot = repoRootForCwd(cwd);
  const filePath = gitignorePath(repoRoot);
  const content = readGitignore(filePath);
  const parsed = parseGitignore(content);
  if (parsed.errors.length > 0) throw new Error(invalidExistingBlockMessage(parsed.errors));

  const template = readProfileTemplate(profile, env);
  let projectContent = content.length > 0 ? `\n${content}` : "";
  if (parsed.hasBlock) {
    if (parsed.profile !== profile) {
      throw new Error(`.gitignore is already managed by profile ${parsed.profile}`);
    }
    projectContent = parsed.projectContent;
  }

  const nextContent = renderGitignore(profile, template.content, projectContent);
  const changed = nextContent !== content;
  if (changed) writeGitignore(filePath, nextContent);

  return {
    repoRoot,
    gitignorePath: filePath,
    profile,
    templatePath: template.path,
    changed
  };
}

export function syncRepository({ cwd = process.cwd(), env = process.env } = {}) {
  const repoRoot = repoRootForCwd(cwd);
  const filePath = gitignorePath(repoRoot);
  const content = readGitignore(filePath);
  const parsed = parseGitignore(content);

  if (!parsed.hasBlock) throw new Error("missing sharedgitignore managed block");
  if (parsed.errors.length > 0) throw new Error(invalidExistingBlockMessage(parsed.errors));

  const template = readProfileTemplate(parsed.profile, env);
  const nextContent = renderGitignore(parsed.profile, template.content, parsed.projectContent);
  const changed = nextContent !== content;
  if (changed) writeGitignore(filePath, nextContent);

  return {
    repoRoot,
    gitignorePath: filePath,
    profile: parsed.profile,
    templatePath: template.path,
    changed
  };
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

function hasGitDirEntry(dirPath) {
  return fs.existsSync(path.join(dirPath, ".git"));
}

function shouldSkipDir(name) {
  return new Set([".git", "node_modules", "Library", "Temp", "Obj", "Build", "Builds"]).has(name);
}

export function findGitRepositories(root) {
  const rootPath = path.resolve(root);
  const repositories = [];

  function walk(dirPath) {
    if (hasGitDirEntry(dirPath)) {
      repositories.push(dirPath);
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipDir(entry.name)) continue;
      walk(path.join(dirPath, entry.name));
    }
  }

  walk(rootPath);
  return repositories.sort((left, right) => left.localeCompare(right));
}

function hasAnyManagedMarker(repoRoot) {
  const filePath = gitignorePath(repoRoot);
  const content = readGitignore(filePath);
  return content.includes("### BEGIN SHAREDGITIGNORE ") || content.includes(END_MARKER);
}

export function syncAllRepositories({ root, env = process.env } = {}) {
  if (!root) throw new Error("sync-all requires --root <path>");
  const repositories = findGitRepositories(root);
  const results = [];

  for (const repoRoot of repositories) {
    if (!hasAnyManagedMarker(repoRoot)) {
      results.push({ repoRoot, skipped: true, reason: "missing managed block" });
      continue;
    }

    try {
      results.push({
        ...syncRepository({ cwd: repoRoot, env }),
        skipped: false,
        errors: []
      });
    } catch (error) {
      results.push({
        repoRoot,
        skipped: false,
        changed: false,
        errors: [error instanceof Error ? error.message : String(error)]
      });
    }
  }

  return results;
}

export function checkAllRepositories({ root, env = process.env } = {}) {
  if (!root) throw new Error("check-all requires --root <path>");
  const repositories = findGitRepositories(root);
  const results = [];

  for (const repoRoot of repositories) {
    if (!hasAnyManagedMarker(repoRoot)) {
      results.push({ repoRoot, skipped: true, reason: "missing managed block" });
      continue;
    }

    try {
      results.push({
        ...checkRepository({ cwd: repoRoot, env }),
        skipped: false
      });
    } catch (error) {
      results.push({
        repoRoot,
        skipped: false,
        valid: false,
        inSync: false,
        errors: [error instanceof Error ? error.message : String(error)]
      });
    }
  }

  return results;
}

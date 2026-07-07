import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addProfile,
  checkRepository,
  detectRepository,
  initRepository,
  listProfiles,
  parseGitignore,
  profileStatus,
  removeProfile,
  renderGitignore,
  syncRepository
} from "../src/sharedgitignore.js";

const BIN = path.resolve("bin/sharedgitignore.js");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sharedgitignore-${name}-`));
}

function testEnv(root = tempDir("home")) {
  return {
    ...process.env,
    SHAREDGITIGNORE_HOME: path.join(root, ".sharedgitignore-home")
  };
}

function initGitRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
}

function writeTemplate(root, name, content) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function runCli(args, env, options = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: path.dirname(BIN),
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
}

function expectCliFailure(args, env) {
  try {
    runCli(args, env);
  } catch (error) {
    return error;
  }
  throw new Error(`expected CLI failure: ${args.join(" ")}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("profile registry stores absolute template paths and validates ids/files", () => {
  const root = tempDir("registry");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "unity.gitignore.shared", "/[Ll]ibrary/\n");

  const added = addProfile("unity", templatePath, env);
  assert.equal(added.id, "unity");
  assert.equal(added.path, templatePath);
  assert.deepEqual(listProfiles(env), [{ id: "unity", path: templatePath }]);
  assert.equal(profileStatus(env)[0].valid, true);

  assert.throws(
    () => addProfile("Unity", templatePath, env),
    /invalid profile id/
  );
  assert.throws(
    () => addProfile("missing", path.join(root, "missing.shared"), env),
    /template file does not exist/
  );

  assert.equal(removeProfile("unity", env), true);
  assert.equal(removeProfile("unity", env), false);
  assert.deepEqual(listProfiles(env), []);
});

test("parser validates managed block markers and preserves project content", () => {
  const content = renderGitignore("unity", "/[Ll]ibrary/\n", "\n# Local\n/Assets/Samples\n");
  const parsed = parseGitignore(content);
  assert.equal(parsed.hasBlock, true);
  assert.equal(parsed.profile, "unity");
  assert.equal(parsed.projectContent, "\n# Local\n/Assets/Samples\n");
  assert.deepEqual(parsed.errors, []);

  assert.match(
    parseGitignore(`# comment\n${content}`).errors.join("\n"),
    /first non-empty/
  );
  assert.match(
    parseGitignore("### BEGIN SHAREDGITIGNORE profile=unity version=1 ###\n").errors.join("\n"),
    /missing sharedgitignore end marker/
  );
  assert.match(
    parseGitignore(`${content}${content}`).errors.join("\n"),
    /duplicate sharedgitignore begin markers/
  );
});

test("init, check, and sync update only the managed block", () => {
  const root = tempDir("repo-flow");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);

  const templatePath = writeTemplate(root, "unity.shared", "/[Ll]ibrary/\n*.slnx\n");
  addProfile("unity", templatePath, env);

  const originalProjectContent = "# Project-specific\n/Assets/Samples\n";
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), originalProjectContent);

  const initialized = initRepository("unity", { cwd: repoRoot, env });
  assert.equal(initialized.changed, true);

  let gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^### BEGIN SHAREDGITIGNORE profile=unity version=1 ###/);
  assert.ok(gitignore.endsWith(`\n${originalProjectContent}`));
  assert.equal(checkRepository({ cwd: repoRoot, env }).valid, true);

  fs.writeFileSync(templatePath, "/[Ll]ibrary/\n/[Tt]emp/\n*.slnx\n");
  const stale = checkRepository({ cwd: repoRoot, env });
  assert.equal(stale.valid, false);
  assert.deepEqual(stale.errors, ["managed block is stale"]);

  const beforeSync = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  const projectBeforeSync = parseGitignore(beforeSync).projectContent;
  const synced = syncRepository({ cwd: repoRoot, env });
  assert.equal(synced.changed, true);

  gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.equal(parseGitignore(gitignore).projectContent, projectBeforeSync);
  assert.match(gitignore, /\/\[Tt\]emp\//);
  assert.equal(checkRepository({ cwd: repoRoot, env }).valid, true);
});

test("init is idempotent for the same profile and rejects another profile", () => {
  const root = tempDir("init");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);

  addProfile("unity", writeTemplate(root, "unity.shared", "/[Ll]ibrary/\n"), env);
  addProfile("base", writeTemplate(root, "base.shared", ".DS_Store\n"), env);

  assert.equal(initRepository("unity", { cwd: repoRoot, env }).changed, true);
  assert.equal(initRepository("unity", { cwd: repoRoot, env }).changed, false);
  assert.throws(
    () => initRepository("base", { cwd: repoRoot, env }),
    /already managed by profile unity/
  );
});

test("CLI detect --json, check exit codes, and profile commands work", () => {
  const root = tempDir("cli");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const templatePath = writeTemplate(root, "unity.shared", "/[Ll]ibrary/\n");

  assert.equal(runCli(["profile", "list"], env), "no profiles registered\n");
  assert.equal(runCli(["profile", "add", "unity", templatePath], env), `unity\t${templatePath}\n`);
  assert.equal(runCli(["profile", "status"], env), `unity\tok\t${templatePath}\n`);
  assert.match(runCli(["init", "--profile", "unity", "--cwd", repoRoot], env), /^initialized\tunity\t/);

  const detected = JSON.parse(runCli(["detect", "--cwd", repoRoot, "--json"], env));
  assert.equal(detected.repoRoot, fs.realpathSync(repoRoot));
  assert.equal(detected.hasBlock, true);
  assert.equal(detected.profile, "unity");
  assert.equal(detected.inSync, true);
  assert.deepEqual(detected.errors, []);
  assert.match(runCli(["check", "--cwd", repoRoot], env), /^ok\tunity\t/);

  fs.writeFileSync(templatePath, "/[Ll]ibrary/\n/[Tt]emp/\n");
  const failure = expectCliFailure(["check", "--cwd", repoRoot], env);
  assert.match(failure.stdout.toString(), /error\tmanaged block is stale/);
});

test("sync-all and check-all operate only on repos with managed blocks", () => {
  const root = tempDir("all");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "unity.shared", "/[Ll]ibrary/\n");
  addProfile("unity", templatePath, env);

  const managedRepo = path.join(root, "managed");
  const unmanagedRepo = path.join(root, "unmanaged");
  initGitRepo(managedRepo);
  initGitRepo(unmanagedRepo);
  initRepository("unity", { cwd: managedRepo, env });
  fs.writeFileSync(path.join(unmanagedRepo, ".gitignore"), "# unmanaged\n");

  fs.writeFileSync(templatePath, "/[Ll]ibrary/\n/[Tt]emp/\n");
  const checkFailure = expectCliFailure(["check-all", "--root", root], env);
  assert.match(checkFailure.stdout.toString(), /stale\tunity\t/);
  assert.match(checkFailure.stdout.toString(), /skipped\t.*unmanaged\tmissing managed block/);

  const syncOutput = runCli(["sync-all", "--root", root], env);
  assert.match(syncOutput, /updated\tunity\t/);
  assert.match(syncOutput, /skipped\t.*unmanaged\tmissing managed block/);

  assert.match(runCli(["check-all", "--root", root], env), /ok\tunity\t/);
  assert.equal(fs.readFileSync(path.join(unmanagedRepo, ".gitignore"), "utf8"), "# unmanaged\n");
});

test("sync-all recurses into nested Git repos by default and can opt out", () => {
  const root = tempDir("recursive-all");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "unity.shared", "/[Ll]ibrary/\n");
  addProfile("unity", templatePath, env);

  const parentRepo = path.join(root, "parent");
  const nestedRepo = path.join(parentRepo, "Packages", "com.example.package");
  initGitRepo(parentRepo);
  initGitRepo(nestedRepo);
  initRepository("unity", { cwd: parentRepo, env });
  initRepository("unity", { cwd: nestedRepo, env });

  fs.writeFileSync(templatePath, "/[Ll]ibrary/\n/[Tt]emp/\n");
  const parentRealpath = fs.realpathSync(parentRepo);
  const nestedRealpath = fs.realpathSync(nestedRepo);

  const recursiveFailure = expectCliFailure(["check-all", "--root", parentRepo], env);
  assert.match(recursiveFailure.stdout.toString(), new RegExp(`stale\\tunity\\t${escapeRegExp(parentRealpath)}`));
  assert.match(recursiveFailure.stdout.toString(), new RegExp(`stale\\tunity\\t${escapeRegExp(nestedRealpath)}`));

  const shallowFailure = expectCliFailure(["check-all", "--root", parentRepo, "--no-recursive"], env);
  assert.match(shallowFailure.stdout.toString(), new RegExp(`stale\\tunity\\t${escapeRegExp(parentRealpath)}`));
  assert.doesNotMatch(shallowFailure.stdout.toString(), /com\.example\.package/);

  const syncOutput = runCli(["sync-all", "--root", parentRepo], env);
  assert.match(syncOutput, new RegExp(`updated\\tunity\\t${escapeRegExp(parentRealpath)}`));
  assert.match(syncOutput, new RegExp(`updated\\tunity\\t${escapeRegExp(nestedRealpath)}`));
  assert.match(runCli(["check-all", "--root", parentRepo], env), /ok\tunity\t/);
});

test("repo commands require a real Git repository and known profiles", () => {
  const root = tempDir("errors");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });

  assert.throws(
    () => detectRepository({ cwd: repoRoot, env }),
    /not a Git repository/
  );

  initGitRepo(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, ".gitignore"),
    "### BEGIN SHAREDGITIGNORE profile=missing version=1 ###\n### END SHAREDGITIGNORE - PROJECT RULES BELOW ###\n"
  );
  const detected = detectRepository({ cwd: repoRoot, env });
  assert.equal(detected.hasBlock, true);
  assert.match(detected.errors.join("\n"), /unknown profile: missing/);
});

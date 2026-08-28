import assert from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  addProfile,
  checkAllRepositories,
  checkRepository,
  detectRepository,
  findGitRepositories,
  getProfile,
  installZshCompletion,
  initRepository,
  listProfiles,
  parseGitignore,
  parseArgs,
  profileStatus,
  readRegistry,
  registryPath,
  removeProfile,
  renderGitignore,
  repoRootForCwd,
  syncAllRepositories,
  syncRepository,
  zshCompletionScript
} from "../src/sharedgitignore.js";

const BIN = path.resolve("bin/sharedgitignore.js");
const execFileAsync = promisify(execFile);

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

test("concurrent profile additions preserve every successful update", async () => {
  const root = tempDir("registry-concurrency");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  const profileIds = Array.from({ length: 32 }, (_, index) => `profile-${index.toString().padStart(2, "0")}`);

  await Promise.all(profileIds.map((profileId) => execFileAsync(
    process.execPath,
    [BIN, "profile", "add", profileId, templatePath],
    {
      cwd: path.dirname(BIN),
      env,
      encoding: "utf8",
      timeout: 15_000
    }
  )));

  assert.deepEqual(listProfiles(env).map((profile) => profile.id), profileIds);
  assert.equal(fs.existsSync(`${registryPath(env)}.lock`), false);
});

test("concurrent profile additions and removals remain serialized", async () => {
  const root = tempDir("registry-mixed-concurrency");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  const removedIds = Array.from({ length: 16 }, (_, index) => `removed-${index.toString().padStart(2, "0")}`);
  const addedIds = Array.from({ length: 16 }, (_, index) => `added-${index.toString().padStart(2, "0")}`);
  for (const profileId of removedIds) addProfile(profileId, templatePath, env);

  const additions = addedIds.map((profileId) => execFileAsync(
    process.execPath,
    [BIN, "profile", "add", profileId, templatePath],
    {
      cwd: path.dirname(BIN),
      env,
      encoding: "utf8",
      timeout: 15_000
    }
  ));
  const removals = removedIds.map((profileId) => execFileAsync(
    process.execPath,
    [BIN, "profile", "remove", profileId],
    {
      cwd: path.dirname(BIN),
      env,
      encoding: "utf8",
      timeout: 15_000
    }
  ));
  await Promise.all([...additions, ...removals]);

  assert.deepEqual(listProfiles(env).map((profile) => profile.id), addedIds);
  assert.equal(fs.existsSync(`${registryPath(env)}.lock`), false);
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

test("zsh completion script includes commands, options, and profile lookup", () => {
  const script = zshCompletionScript();

  assert.match(script, /^#compdef sharedgitignore/);
  assert.match(script, /'profile:manage shared gitignore profiles'/);
  assert.match(script, /'completion:print or install shell completions'/);
  assert.match(script, /compadd -- --root --no-recursive/);
  assert.match(script, /compadd -- --profile --cwd/);
  assert.match(script, /sharedgitignore profile list/);
});

test("completion install writes _sharedgitignore to a zsh completion directory", () => {
  const root = tempDir("completion-install");
  const targetDir = path.join(root, "zsh-completions");

  const result = installZshCompletion({ dir: targetDir, env: testEnv(root) });
  assert.equal(result.shell, "zsh");
  assert.equal(result.filePath, path.join(targetDir, "_sharedgitignore"));
  assert.equal(fs.existsSync(result.filePath), true);
  assert.match(fs.readFileSync(result.filePath, "utf8"), /^#compdef sharedgitignore/);

  assert.equal(
    runCli(["completion", "install", "--dir", targetDir], testEnv(root)),
    `zsh\tinstalled\t${result.filePath}\n`
  );
  assert.match(runCli(["completion", "zsh"], testEnv(root)), /^#compdef sharedgitignore/);
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

test("repository diagnostics distinguish a missing Git executable", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.throws(() => repoRootForCwd(process.cwd()), /Git is required but was not found on PATH/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("repository roots preserve trailing whitespace in directory names", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not consistently preserve trailing whitespace in directory names");
    return;
  }

  const root = tempDir("repository-whitespace");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);

  for (const name of ["repo ", "repo\t", "repo\n"]) {
    const repository = path.join(root, name);
    initGitRepo(repository);
    const expectedRoot = fs.realpathSync(repository);

    assert.equal(repoRootForCwd(repository), expectedRoot);
    initRepository("base", { cwd: repository, env });
    assert.equal(fs.existsSync(path.join(repository, ".gitignore")), true);
    assert.equal(fs.existsSync(path.join(root, name.slice(0, -1), ".gitignore")), false);
  }
});

test("v2 CLI parser types flags, rejects ambiguity, and supports --", () => {
  const parsed = parseArgs(["detect", "--json", "extra"]);
  assert.equal(parsed.command, "detect");
  assert.equal(parsed.flags.json, true);
  assert.deepEqual(parsed.positionals, ["extra"]);
  assert.equal(Object.getPrototypeOf(parsed.flags), null);

  assert.throws(() => parseArgs(["--json", "detect"]), /options must follow a command/);
  assert.throws(() => parseArgs(["detect", "--json=true"]), /does not take a value/);
  assert.throws(() => parseArgs(["detect", "--json", "--json"]), /may not be repeated/);
  assert.throws(() => parseArgs(["detect", "--cwd"]), /requires a value/);
  assert.throws(() => parseArgs(["detect", "--cwd="]), /non-empty value/);

  const root = tempDir("strict-cli");
  const env = testEnv(root);
  const templateName = "--template";
  fs.writeFileSync(path.join(root, templateName), "*.tmp\n");
  assert.match(
    runCli(["profile", "add", "dash-path", "--", templateName], env, { cwd: root }),
    /^dash-path\t/
  );

  const extraFailure = expectCliFailure(["detect", "--json", "extra"], env);
  assert.match(extraFailure.stderr.toString(), /detect does not accept positional arguments/);
});

test("CLI version comes from package metadata and requires Node 24", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  assert.equal(manifest.version, "2.0.0");
  assert.equal(manifest.engines.node, ">=24");
  assert.equal(runCli(["--version"], testEnv()), "2.0.0\n");
  assert.match(runCli(["--help"], testEnv()), /^sharedgitignore 2\.0\.0/);
});

test("v1 registry and managed-block formats remain compatible", () => {
  const root = tempDir("v1-migration");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "legacy.shared", "*.tmp\n");
  fs.mkdirSync(env.SHAREDGITIGNORE_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.SHAREDGITIGNORE_HOME, "registry.json"), JSON.stringify({
    version: 1,
    profiles: { "legacy-": { path: templatePath } }
  }));

  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const projectContent = "# legacy project\n";
  fs.writeFileSync(
    path.join(repoRoot, ".gitignore"),
    renderGitignore("legacy-", "*.tmp\n", projectContent)
  );
  assert.equal(checkRepository({ cwd: repoRoot, env }).valid, true);

  fs.writeFileSync(templatePath, "*.tmp\n*.cache\n");
  syncRepository({ cwd: repoRoot, env });
  assert.equal(parseGitignore(fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8")).projectContent, projectContent);
});

test("profile ids and registry entries are strict and prototype-safe", () => {
  const root = tempDir("strict-registry");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");

  assert.equal(getProfile("constructor", env), null);
  assert.throws(() => addProfile("Upper", templatePath, env), /invalid profile id/);
  assert.throws(() => addProfile(" base", templatePath, env), /invalid profile id/);
  assert.throws(() => addProfile("_base", templatePath, env), /invalid profile id/);
  addProfile("constructor", templatePath, env);
  assert.equal(getProfile("constructor", env).path, templatePath);
  assert.equal(Object.getPrototypeOf(readRegistry(env).profiles), null);

  const registryFile = path.join(env.SHAREDGITIGNORE_HOME, "registry.json");
  fs.writeFileSync(registryFile, JSON.stringify({ version: 1, profiles: { broken: null } }));
  assert.throws(() => listProfiles(env), /registry profile broken must be an object/);

  fs.writeFileSync(registryFile, JSON.stringify({
    version: 1,
    profiles: { Upper: { path: templatePath } }
  }));
  assert.throws(() => listProfiles(env), /registry contains invalid profile id/);

  fs.writeFileSync(registryFile, JSON.stringify({
    version: 1,
    profiles: { base: { path: "relative.shared" } }
  }));
  assert.throws(() => listProfiles(env), /absolute non-empty string/);
});

test("template registration rejects BOM, NUL, invalid UTF-8, and reserved markers", () => {
  const root = tempDir("template-content");
  const env = testEnv(root);
  const fixtures = [
    { name: "bom", bytes: Buffer.from([0xef, 0xbb, 0xbf, 0x2a, 0x0a]), error: /byte-order mark/ },
    { name: "nul", bytes: Buffer.from("*.tmp\u0000\n"), error: /NUL bytes/ },
    { name: "utf8", bytes: Buffer.from([0xc3, 0x28]), error: /valid UTF-8/ },
    {
      name: "marker",
      bytes: Buffer.from("### END SHAREDGITIGNORE - PROJECT RULES BELOW ###\n"),
      error: /reserved sharedgitignore marker/
    },
    {
      name: "malformed-marker",
      bytes: Buffer.from("### BEGIN SHAREDGITIGNORE malformed\n"),
      error: /reserved sharedgitignore marker/
    }
  ];

  for (const fixture of fixtures) {
    const templatePath = path.join(root, `${fixture.name}.shared`);
    fs.writeFileSync(templatePath, fixture.bytes);
    assert.throws(() => addProfile(fixture.name, templatePath, env), fixture.error);
  }
});

test("managed writes reject self-referential templates, symlinks, and non-files", () => {
  const root = tempDir("safe-targets");
  const env = testEnv(root);

  const selfRepo = path.join(root, "self");
  initGitRepo(selfRepo);
  const selfGitignore = path.join(selfRepo, ".gitignore");
  fs.writeFileSync(selfGitignore, "# local\n");
  addProfile("self", selfGitignore, env);
  assert.throws(
    () => initRepository("self", { cwd: selfRepo, env }),
    /template must not be the managed \.gitignore/
  );
  assert.equal(fs.readFileSync(selfGitignore, "utf8"), "# local\n");

  const templatePath = writeTemplate(root, "safe.shared", "*.tmp\n");
  addProfile("safe", templatePath, env);
  const linkRepo = path.join(root, "link");
  initGitRepo(linkRepo);
  const linkTarget = path.join(root, "link-target.txt");
  fs.writeFileSync(linkTarget, "do not touch\n");
  fs.symlinkSync(linkTarget, path.join(linkRepo, ".gitignore"));
  assert.throws(
    () => initRepository("safe", { cwd: linkRepo, env }),
    /symbolic-link \.gitignore/
  );
  assert.equal(fs.readFileSync(linkTarget, "utf8"), "do not touch\n");

  const directoryRepo = path.join(root, "directory");
  initGitRepo(directoryRepo);
  fs.mkdirSync(path.join(directoryRepo, ".gitignore"));
  assert.throws(
    () => initRepository("safe", { cwd: directoryRepo, env }),
    /non-file \.gitignore/
  );
});

test("registry and completion writes reject destination symlinks", () => {
  const root = tempDir("atomic-links");
  const env = testEnv(root);
  const home = env.SHAREDGITIGNORE_HOME;
  fs.mkdirSync(home, { recursive: true });
  const registryTarget = path.join(root, "registry-target.json");
  const registryContent = `${JSON.stringify({ version: 1, profiles: {} }, null, 2)}\n`;
  fs.writeFileSync(registryTarget, registryContent);
  fs.symlinkSync(registryTarget, path.join(home, "registry.json"));
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  assert.throws(() => addProfile("base", templatePath, env), /symbolic-link registry/);
  assert.equal(fs.readFileSync(registryTarget, "utf8"), registryContent);

  const danglingEnv = testEnv(path.join(root, "dangling-home"));
  fs.mkdirSync(danglingEnv.SHAREDGITIGNORE_HOME, { recursive: true });
  fs.symlinkSync(
    path.join(root, "missing-registry.json"),
    path.join(danglingEnv.SHAREDGITIGNORE_HOME, "registry.json")
  );
  const danglingFailure = expectCliFailure(["profile", "status"], danglingEnv);
  assert.match(danglingFailure.stderr.toString(), /symbolic-link registry/);

  const completionDir = path.join(root, "completion");
  fs.mkdirSync(completionDir);
  const completionTarget = path.join(root, "completion-target");
  fs.writeFileSync(completionTarget, "keep\n");
  fs.symlinkSync(completionTarget, path.join(completionDir, "_sharedgitignore"));
  assert.throws(
    () => installZshCompletion({ dir: completionDir, env }),
    /refusing to write symbolic link/
  );
  assert.equal(fs.readFileSync(completionTarget, "utf8"), "keep\n");
});

test("registry writes create and retain private permissions", () => {
  const root = tempDir("registry-mode");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");

  addProfile("base", templatePath, env);
  assert.equal(fs.statSync(registryPath(env)).mode & 0o777, 0o600);

  fs.chmodSync(registryPath(env), 0o644);
  addProfile("second", templatePath, env);
  assert.equal(fs.statSync(registryPath(env)).mode & 0o777, 0o600);
});

test("sync preserves file mode and every project byte", () => {
  const root = tempDir("project-bytes");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const templatePath = writeTemplate(root, "bytes.shared", "*.tmp\r\n");
  addProfile("bytes", templatePath, env);

  const originalProject = Buffer.concat([
    Buffer.from("# Project CRLF\r\nraw-"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("\r\n")
  ]);
  const filePath = path.join(fs.realpathSync(repoRoot), ".gitignore");
  fs.writeFileSync(filePath, originalProject);
  fs.chmodSync(filePath, 0o640);
  initRepository("bytes", { cwd: repoRoot, env });

  let parsed = parseGitignore(fs.readFileSync(filePath));
  assert.equal(Buffer.isBuffer(parsed.projectContent), true);
  assert.deepEqual(parsed.projectContent, Buffer.concat([Buffer.from("\n"), originalProject]));
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o640);

  fs.writeFileSync(templatePath, "*.tmp\r\n*.cache\r\n");
  const beforeSyncProject = Buffer.from(parsed.projectContent);
  syncRepository({ cwd: repoRoot, env });
  parsed = parseGitignore(fs.readFileSync(filePath));
  assert.deepEqual(parsed.projectContent, beforeSyncProject);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o640);
});

test("managed CRLF and LF line endings compare as equivalent", () => {
  const root = tempDir("managed-crlf");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n*.cache\n");
  addProfile("base", templatePath, env);
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "# project\r\n/local\r\n");
  initRepository("base", { cwd: repoRoot, env });

  const filePath = path.join(fs.realpathSync(repoRoot), ".gitignore");
  const initialized = fs.readFileSync(filePath);
  const parsed = parseGitignore(initialized);
  const managedLength = initialized.length - parsed.projectContent.length;
  const managedWithCrlf = Buffer.from(
    initialized.subarray(0, managedLength).toString("latin1").replaceAll("\n", "\r\n"),
    "latin1"
  );
  const converted = Buffer.concat([managedWithCrlf, parsed.projectContent]);
  fs.writeFileSync(filePath, converted);

  assert.equal(checkRepository({ cwd: repoRoot, env }).valid, true);
  const synced = syncRepository({ cwd: repoRoot, env });
  assert.equal(synced.changed, false);
  assert.deepEqual(fs.readFileSync(filePath), converted);

  fs.writeFileSync(templatePath, "*.tmp\n*.cache\n*.logs\n");
  assert.deepEqual(checkRepository({ cwd: repoRoot, env }).errors, ["managed block is stale"]);
});

test("single-repository writes revalidate the template immediately before replacement", () => {
  const root = tempDir("template-race");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);
  initRepository("base", { cwd: repoRoot, env });

  const filePath = path.join(fs.realpathSync(repoRoot), ".gitignore");
  const originalGitignore = fs.readFileSync(filePath);
  fs.writeFileSync(templatePath, "*.tmp\n*.cache\n");

  const originalReadFileSync = fs.readFileSync;
  let gitignoreReads = 0;
  fs.readFileSync = function patchedReadFileSync(target, ...args) {
    if (target === filePath) {
      gitignoreReads += 1;
      if (gitignoreReads === 2) fs.writeFileSync(templatePath, "*.tmp\n*.logs\n");
    }
    return Reflect.apply(originalReadFileSync, fs, [target, ...args]);
  };

  try {
    assert.throws(
      () => syncRepository({ cwd: repoRoot, env }),
      /template changed during planning/
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.deepEqual(fs.readFileSync(filePath), originalGitignore);
});

test("single-repository writes recheck .gitignore after flushing the temporary file", () => {
  const root = tempDir("commit-race");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);
  initRepository("base", { cwd: repoRoot, env });

  const filePath = path.join(fs.realpathSync(repoRoot), ".gitignore");
  const before = fs.readFileSync(filePath);
  const concurrentEdit = Buffer.from("# edit during replacement\n");
  fs.writeFileSync(templatePath, "*.tmp\n*.cache\n");

  const originalFsyncSync = fs.fsyncSync;
  let editInjected = false;
  fs.fsyncSync = function patchedFsyncSync(descriptor) {
    const result = Reflect.apply(originalFsyncSync, fs, [descriptor]);
    if (!editInjected) {
      fs.appendFileSync(filePath, concurrentEdit);
      editInjected = true;
    }
    return result;
  };

  try {
    assert.throws(
      () => syncRepository({ cwd: repoRoot, env }),
      /\.gitignore changed during planning commit/
    );
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }

  assert.equal(editInjected, true);
  assert.deepEqual(fs.readFileSync(filePath), Buffer.concat([before, concurrentEdit]));
});

test("single-repository writes do not erase a concurrent mode change", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not expose POSIX mode changes consistently");
    return;
  }

  const root = tempDir("mode-race");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);
  initRepository("base", { cwd: repoRoot, env });

  const filePath = path.join(fs.realpathSync(repoRoot), ".gitignore");
  fs.chmodSync(filePath, 0o640);
  const before = fs.readFileSync(filePath);
  fs.writeFileSync(templatePath, "*.tmp\n*.cache\n");

  const originalFsyncSync = fs.fsyncSync;
  let modeChanged = false;
  fs.fsyncSync = function patchedFsyncSync(descriptor) {
    const result = Reflect.apply(originalFsyncSync, fs, [descriptor]);
    if (!modeChanged) {
      fs.chmodSync(filePath, 0o600);
      modeChanged = true;
    }
    return result;
  };

  try {
    assert.throws(
      () => syncRepository({ cwd: repoRoot, env }),
      /destination mode or existence changed during atomic write/
    );
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }

  assert.equal(modeChanged, true);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(filePath), before);
});

test("init does not recreate a repository moved after planning", () => {
  const root = tempDir("repository-move-race");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  const movedRepo = path.join(root, "repo-moved");
  initGitRepo(repoRoot);
  const realRepoRoot = fs.realpathSync(repoRoot);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);

  const originalReadFileSync = fs.readFileSync;
  let moved = false;
  fs.readFileSync = function patchedReadFileSync(target, ...args) {
    const content = Reflect.apply(originalReadFileSync, fs, [target, ...args]);
    if (!moved && target === templatePath) {
      fs.renameSync(realRepoRoot, movedRepo);
      moved = true;
    }
    return content;
  };

  try {
    assert.throws(
      () => initRepository("base", { cwd: repoRoot, env }),
      /repository changed during planning/
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(moved, true);
  assert.equal(fs.existsSync(realRepoRoot), false);
  assert.equal(fs.existsSync(path.join(realRepoRoot, ".gitignore")), false);
  assert.equal(fs.existsSync(path.join(movedRepo, ".git")), true);
});

test("init revalidates Git metadata before writing", () => {
  const root = tempDir("git-metadata-race");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const realRepoRoot = fs.realpathSync(repoRoot);
  const gitEntry = path.join(realRepoRoot, ".git");
  const movedGitEntry = path.join(realRepoRoot, ".git-moved");
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);

  const originalReadFileSync = fs.readFileSync;
  let metadataMoved = false;
  fs.readFileSync = function patchedReadFileSync(target, ...args) {
    const content = Reflect.apply(originalReadFileSync, fs, [target, ...args]);
    if (!metadataMoved && target === templatePath) {
      fs.renameSync(gitEntry, movedGitEntry);
      metadataMoved = true;
    }
    return content;
  };

  try {
    assert.throws(
      () => initRepository("base", { cwd: repoRoot, env }),
      /repository changed during planning/
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(metadataMoved, true);
  assert.equal(fs.existsSync(path.join(realRepoRoot, ".gitignore")), false);
  assert.equal(fs.existsSync(movedGitEntry), true);
});

test("malformed reserved marker prefixes are errors and init does not mutate", () => {
  const malformed = "### BEGIN SHAREDGITIGNORE profile=Upper version=1 ###\n# local\n";
  assert.match(parseGitignore(malformed).errors.join("\n"), /malformed sharedgitignore begin marker/);

  const root = tempDir("malformed-prefix");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), malformed);
  assert.throws(
    () => initRepository("base", { cwd: repoRoot, env }),
    /invalid existing \.gitignore managed block/
  );
  assert.equal(fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8"), malformed);
});

test("init rejects a project .gitignore BOM that would stop its first rule matching", () => {
  const root = tempDir("project-bom");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  addProfile("base", writeTemplate(root, "base.shared", ".cache/\n"), env);

  const filePath = path.join(repoRoot, ".gitignore");
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("*.tmp\n")]);
  fs.writeFileSync(filePath, original);
  assert.equal(
    execFileSync("git", ["check-ignore", "artifact.tmp"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    "artifact.tmp"
  );

  assert.throws(
    () => initRepository("base", { cwd: repoRoot, env }),
    /unmanaged \.gitignore with a UTF-8 byte-order mark/
  );
  assert.deepEqual(fs.readFileSync(filePath), original);
});

test("init and sync dry runs report changes without writing", () => {
  const root = tempDir("dry-run");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);

  const emptyRepo = path.join(root, "empty-repo");
  initGitRepo(emptyRepo);
  const emptyResult = initRepository("base", { cwd: emptyRepo, env, dryRun: true });
  assert.equal(emptyResult.changed, true);
  assert.equal(fs.existsSync(path.join(emptyRepo, ".gitignore")), false);

  const filePath = path.join(repoRoot, ".gitignore");
  fs.writeFileSync(filePath, "# local\n");

  const beforeInit = fs.readFileSync(filePath);
  const initResult = initRepository("base", { cwd: repoRoot, env, dryRun: true });
  assert.equal(initResult.changed, true);
  assert.equal(initResult.applied, false);
  assert.deepEqual(fs.readFileSync(filePath), beforeInit);
  assert.match(
    runCli(["init", "--profile", "base", "--cwd", repoRoot, "--dry-run"], env),
    /^would-initialize\tbase\t/
  );
  assert.deepEqual(fs.readFileSync(filePath), beforeInit);

  initRepository("base", { cwd: repoRoot, env });
  fs.writeFileSync(templatePath, "*.tmp\n*.cache\n");
  const beforeSync = fs.readFileSync(filePath);
  const syncResult = syncRepository({ cwd: repoRoot, env, dryRun: true });
  assert.equal(syncResult.changed, true);
  assert.equal(syncResult.applied, false);
  assert.deepEqual(fs.readFileSync(filePath), beforeSync);
  assert.match(
    runCli(["sync", "--cwd", repoRoot, "--dry-run"], env),
    /^would-update\tbase\t/
  );
  assert.deepEqual(fs.readFileSync(filePath), beforeSync);
});

test("repository discovery validates roots and returns traversal diagnostics", (t) => {
  const root = tempDir("discovery-diagnostics");
  const fileRoot = path.join(root, "file");
  fs.writeFileSync(fileRoot, "x");
  assert.throws(() => findGitRepositories(path.join(root, "missing")), /root does not exist/);
  assert.throws(() => findGitRepositories(fileRoot), /root is not a directory/);

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("permission diagnostics cannot be asserted as root");
    return;
  }

  const blocked = path.join(root, "blocked");
  fs.mkdirSync(blocked);
  fs.chmodSync(blocked, 0);
  t.after(() => fs.chmodSync(blocked, 0o700));
  const discovery = findGitRepositories(root);
  assert.deepEqual(discovery.repositories, []);
  assert.equal(discovery.diagnostics.length, 1);
  assert.equal(discovery.diagnostics[0].path, blocked);
  assert.match(discovery.diagnostics[0].error, /unable to read directory/);
});

test("repository discovery diagnoses invalid .git entries instead of skipping them", () => {
  const root = tempDir("fake-repository");
  const fakeRepo = path.join(root, "fake");
  fs.mkdirSync(fakeRepo);
  fs.writeFileSync(path.join(fakeRepo, ".git"), "not a gitdir\n");
  fs.writeFileSync(path.join(fakeRepo, ".gitignore"), "# unmanaged\n");

  const discovery = findGitRepositories(root);
  assert.deepEqual(discovery.repositories, []);
  assert.equal(discovery.diagnostics.length, 1);
  assert.equal(discovery.diagnostics[0].path, fakeRepo);
  assert.match(discovery.diagnostics[0].error, /invalid \.git entry/);

  const failure = expectCliFailure(["check-all", "--root", root], testEnv(root));
  assert.match(failure.stdout.toString(), /scan-error\t.*invalid \.git entry/);
});

test("sync-all dry-run writes nothing and reports planned updates", () => {
  const root = tempDir("batch-dry-run");
  const env = testEnv(root);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);
  initRepository("base", { cwd: repoRoot, env });
  fs.writeFileSync(templatePath, "*.tmp\n*.cache\n");
  const before = fs.readFileSync(path.join(repoRoot, ".gitignore"));

  const batch = syncAllRepositories({ root, env, dryRun: true });
  assert.equal(batch.aborted, false);
  assert.equal(batch.appliedCount, 0);
  assert.equal(batch.results.find((result) => result.repoRoot === fs.realpathSync(repoRoot)).changed, true);
  assert.deepEqual(fs.readFileSync(path.join(repoRoot, ".gitignore")), before);
  assert.match(runCli(["sync-all", "--root", root, "--dry-run"], env), /would-update\tbase\t/);
  assert.deepEqual(fs.readFileSync(path.join(repoRoot, ".gitignore")), before);
});

test("sync-all completes preflight and aborts all writes when any repo is invalid", () => {
  const root = tempDir("batch-abort");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);

  const goodRepo = path.join(root, "a-good");
  const badRepo = path.join(root, "z-bad");
  initGitRepo(goodRepo);
  initGitRepo(badRepo);
  initRepository("base", { cwd: goodRepo, env });
  fs.writeFileSync(
    path.join(badRepo, ".gitignore"),
    "### BEGIN SHAREDGITIGNORE profile=missing version=1 ###\n### END SHAREDGITIGNORE - PROJECT RULES BELOW ###\n"
  );
  fs.writeFileSync(templatePath, "*.tmp\n*.cache\n");
  const beforeGood = fs.readFileSync(path.join(goodRepo, ".gitignore"));

  const batch = syncAllRepositories({ root, env });
  assert.equal(batch.aborted, true);
  assert.equal(batch.appliedCount, 0);
  assert.match(batch.results.find((result) => result.repoRoot === fs.realpathSync(badRepo)).errors[0], /unknown profile/);
  assert.deepEqual(fs.readFileSync(path.join(goodRepo, ".gitignore")), beforeGood);

  const failure = expectCliFailure(["sync-all", "--root", root], env);
  assert.match(failure.stdout.toString(), /not-updated\tbase\t/);
  assert.match(failure.stdout.toString(), /aborted\t.*no repositories updated/);
  assert.deepEqual(fs.readFileSync(path.join(goodRepo, ".gitignore")), beforeGood);
});

test("sync-all rechecks each repository immediately before its write", () => {
  const root = tempDir("batch-write-race");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);

  const firstRepo = path.join(root, "a-first");
  const secondRepo = path.join(root, "b-second");
  initGitRepo(firstRepo);
  initGitRepo(secondRepo);
  initRepository("base", { cwd: firstRepo, env });
  initRepository("base", { cwd: secondRepo, env });
  fs.writeFileSync(templatePath, "*.tmp\n*.cache\n");

  const firstGitignore = path.join(fs.realpathSync(firstRepo), ".gitignore");
  const secondGitignore = path.join(fs.realpathSync(secondRepo), ".gitignore");
  const secondBefore = fs.readFileSync(secondGitignore);
  const concurrentEdit = Buffer.from("# concurrent project rule\n");
  const originalRenameSync = fs.renameSync;
  let editInjected = false;
  fs.renameSync = function patchedRenameSync(source, destination) {
    const result = Reflect.apply(originalRenameSync, fs, [source, destination]);
    if (!editInjected && destination === firstGitignore) {
      editInjected = true;
      fs.appendFileSync(secondGitignore, concurrentEdit);
    }
    return result;
  };

  let batch;
  try {
    batch = syncAllRepositories({ root, env });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(editInjected, true);
  assert.equal(batch.aborted, true);
  assert.equal(batch.appliedCount, 1);
  assert.equal(batch.results.find((result) => result.repoRoot === fs.realpathSync(firstRepo)).applied, true);
  assert.match(
    batch.results.find((result) => result.repoRoot === fs.realpathSync(secondRepo)).errors.join("\n"),
    /\.gitignore changed during batch update/
  );
  assert.deepEqual(
    fs.readFileSync(secondGitignore),
    Buffer.concat([secondBefore, concurrentEdit])
  );
});

test("sync-all aborts mutation when discovery reports an unreadable subtree", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("permission diagnostics cannot be asserted as root");
    return;
  }

  const root = tempDir("batch-scan-abort");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);
  const repoRoot = path.join(root, "repo");
  initGitRepo(repoRoot);
  initRepository("base", { cwd: repoRoot, env });
  fs.writeFileSync(templatePath, "*.tmp\n*.cache\n");
  const before = fs.readFileSync(path.join(repoRoot, ".gitignore"));
  const blocked = path.join(root, "blocked");
  fs.mkdirSync(blocked);
  fs.chmodSync(blocked, 0);
  t.after(() => fs.chmodSync(blocked, 0o700));

  const batch = syncAllRepositories({ root, env });
  assert.equal(batch.diagnostics.length, 1);
  assert.equal(batch.aborted, true);
  assert.equal(batch.appliedCount, 0);
  assert.deepEqual(fs.readFileSync(path.join(repoRoot, ".gitignore")), before);

  const checked = checkAllRepositories({ root, env });
  assert.equal(checked.diagnostics.length, 1);
  const failure = expectCliFailure(["check-all", "--root", root], env);
  assert.match(failure.stdout.toString(), /scan-error\t/);
});

test("profile status exits nonzero when a registered template is invalid", () => {
  const root = tempDir("status-exit");
  const env = testEnv(root);
  const templatePath = writeTemplate(root, "base.shared", "*.tmp\n");
  addProfile("base", templatePath, env);
  fs.rmSync(templatePath);

  const failure = expectCliFailure(["profile", "status"], env);
  assert.equal(failure.status, 1);
  assert.match(failure.stdout.toString(), /base\tinvalid: template file does not exist/);
});

test("zsh completion includes v2 flags and passes zsh syntax checking", () => {
  const script = zshCompletionScript();
  assert.match(script, /--help --version/);
  assert.match(script, /--profile --cwd --dry-run/);
  assert.match(script, /--root --no-recursive --dry-run/);
  execFileSync("zsh", ["-n"], { input: script, stdio: ["pipe", "pipe", "pipe"] });
});

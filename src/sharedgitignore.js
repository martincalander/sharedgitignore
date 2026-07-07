export {
  beginMarker,
  END_MARKER,
  parseGitignore,
  renderBlock,
  renderGitignore
} from "./block.js";

export {
  gitignorePath,
  PROFILE_ID_PATTERN,
  readJsonFile,
  registryPath,
  repoRootForCwd,
  sharedgitignoreHome,
  writeJsonFile
} from "./paths.js";

export {
  addProfile,
  getProfile,
  listProfiles,
  profileStatus,
  readProfileTemplate,
  readRegistry,
  removeProfile,
  validateProfileId,
  validateTemplateFile,
  writeRegistry
} from "./registry.js";

export {
  checkAllRepositories,
  checkRepository,
  detectRepository,
  findGitRepositories,
  initRepository,
  syncAllRepositories,
  syncRepository
} from "./repo.js";

export {
  main,
  parseArgs
} from "./cli.js";

/**
 * The data seam. §1, §3 and §5 of the schema, behind one interface.
 *
 * The backends are deliberately NOT re-exported here. Each backend is imported
 * only by its own caller — `memory.js` by the tests, `tauri.js`/`pwa.js` by
 * `data/session.js`'s dynamic `import()`s — so a build that never runs in Tauri
 * never pulls `@tauri-apps/plugin-sql` into its bundle, and vice versa. Both
 * `tauri.js` and `pwa.js` are genuine runtime dependencies of their own build
 * now; this file staying backend-agnostic is what keeps each build shipping
 * only the engine it actually uses.
 */

export { DataError, isConnection, assertConnection, CONNECTION_METHODS } from './connection.js';

export {
  identify,
  describe,
  SCHEMA_USER_VERSION,
  APPLICATION_ID,
  CONFIG_TABLES,
  GAME_TABLES
} from './identify.js';

export {
  readPreferences,
  readPreference,
  writePreference,
  readUiState,
  writeUiState,
  readLibraries,
  writeLibraryName,
  writeLibraryEnabled,
  readEngines,
  writeEngineName,
  writeEngineOption,
  writeEngineEnabled,
  readSubscriptions,
  PREFERENCE_KEYS
} from './config.js';

export {
  LIST_COLUMNS,
  INSERT_COLUMNS,
  insertGame,
  insertGames,
  countGames,
  countNewGamesForSubscription,
  latestGameDateForSource,
  gamePgnsForSourceOnDate,
  readGames,
  gameListWhere,
  readGameList,
  readGamesByIds,
  countGameList,
  readGameMarks,
  readLibraryCounts,
  ensureGameSearch,
  movetextFromRow,
  readMovetextFor,
  writeMovetextFor,
  readPgn,
  movetextOf,
  derivePlyCount,
  readFavoriteIds,
  readTrashedIds,
  setFavorite,
  setTrashed,
  readTags,
  readTagIdsForGame,
  readGameIdsForTag,
  readTagCounts,
  readTagIdsByGame,
  findOrCreateTag,
  addTagToGame,
  removeTagFromGame,
  readCollections,
  readGameIdsForCollection,
  readCollectionCounts,
  readCollectionIdsByGame,
  findOrCreateCollection,
  addGameToCollection,
  removeGameFromCollection
} from './games.js';

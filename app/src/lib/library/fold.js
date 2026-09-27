/**
 * Case- and diacritic-insensitive folding for Library search (§3.2.4.1), so
 * "polgar" finds "Polgár"; a database of chess names is unusable otherwise.
 *
 * Shared by the in-memory filter (`stores/library.js`'s `applySearch`) and the
 * derived `game_search` table (`data/games.js`), which stores text already
 * folded by this function — SQLite's own `LIKE` folds ASCII case only, and a
 * custom SQL function cannot be registered through `@tauri-apps/plugin-sql`.
 * Both sides must fold identically or the two sources disagree.
 */
export const fold = (s) =>
  String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * The fields search covers, folded into one string. `\u001f` (unit separator)
 * between them, so a term cannot match across two fields' boundary.
 */
export const searchText = (g) =>
  [g.white, g.black, g.event, g.date, g.result].map(fold).join('\u001f');

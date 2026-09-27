/**
 * A game database — the `games` table and what the Library Content Table needs
 * from it. §1 and §3 of the schema.
 *
 * Reads are query-shaped rather than array-shaped: the caller asks for a page
 * and gets a page. `master-games.db` is 1,026 games and a real one is larger, so
 * nothing here loads a table into memory to filter it in JavaScript.
 */

import { DataError } from './connection.js';
import { fold, searchText } from '../library/fold.js';

/** The eight columns of §3.2.4.2, in the order the table draws them. */
export const LIST_COLUMNS = [
  'id', 'date', 'white', 'white_elo', 'black', 'black_elo', 'event', 'result', 'ply_count'
];

/**
 * `created_at` is fetched alongside the eight list columns above rather than
 * added to them — it is not one of §3.2.4.2's eight and the Content Table
 * does not draw it — but `stores/library.js`'s `loadGames()` passes it
 * through as `createdAt`, which `recentlyAdded()` (§4.3.2) reads directly.
 */
const ROW_COLUMNS = [...LIST_COLUMNS, 'created_at'];

/** How many games the database holds. The Library status bar's count. §3.2.4.4 */
export const countGames = async (connection) =>
  Number(await connection.value('select count(*) from games')) || 0;

/**
 * How many games a subscription has newly found, per §8's own definition:
 * the rows in `subscription_games` for that subscription whose game's
 * `created_at` is later than the subscription's `last_viewed_at` — not a
 * stored count, and not `imported_at` (this table has none, deliberately;
 * see §8's own comment on that).
 *
 * `connection` is to the subscription's DESTINATION library — this table
 * lives in a game database, not in `config.db` alongside the subscription
 * itself (§8's whole point: `config.db` and a game database are different
 * files). `sinceIso` is the subscription's `lastViewedAt`; `null` (never
 * viewed) counts every row rather than none.
 *
 * A game database without `subscription_games` (§7's own caveat — a
 * database not built by this application may not have it) reports 0 rather
 * than throwing, the same degradation `readPositionStats` uses for a
 * database without `positions`.
 */
export const countNewGamesForSubscription = async (connection, subscriptionId, sinceIso) => {
  try {
    if (!sinceIso) {
      return Number(await connection.value(
        'select count(*) from subscription_games where subscription_id = ?',
        [subscriptionId]
      )) || 0;
    }
    return Number(await connection.value(
      'select count(*) from subscription_games sg join games g on g.id = sg.game_id ' +
        'where sg.subscription_id = ? and g.created_at > ?',
      [subscriptionId, sinceIso]
    )) || 0;
  } catch {
    return 0;
  }
};

/**
 * The latest `date` (§2.2's format, chronologically string-sortable)
 * already on record for one online source -- an Online import's cursor for
 * "have we already imported this account up to here" (`working/
 * EXPLORATION.md`, "Per-game source tracking"). Generic: nothing here is
 * Chess.com-specific, so any future source's adapter can use the same
 * query against its own `source_type`/`source_identifier` pair (§2.3).
 *
 * Plain SQL `max()` is enough because `date` is stored NULL-safe and
 * chronologically sortable as text; SQLite's `max()` already ignores NULL
 * rows, so a mix of dated and undated games for the same source pair still
 * answers correctly.
 *
 * @returns {Promise<string|null>} null when nothing from this source pair
 *   is on record yet -- a first import, nothing to skip.
 */
export const latestGameDateForSource = async (connection, sourceType, sourceIdentifier) => {
  const value = await connection.value(
    'select max(date) from games where source_type = ? and source_identifier = ?',
    [sourceType, sourceIdentifier]
  );
  return value ?? null;
};

/**
 * The stored `pgn` of every game from one online source dated exactly
 * `date` -- the one day an incremental re-import can't tell "already
 * imported" from "new" by date alone (`EXPLORATION.md`'s "same-day ties").
 * The caller re-parses these for whatever its own source-specific tie-break
 * needs (Chess.com: `import/sources/chesscom.js`'s `EndDate`/`EndTime`);
 * nothing here is Chess.com-specific.
 *
 * @returns {Promise<string[]>}
 */
export const gamePgnsForSourceOnDate = async (connection, sourceType, sourceIdentifier, date) => {
  const rows = await connection.all(
    'select pgn from games where source_type = ? and source_identifier = ? and date = ?',
    [sourceType, sourceIdentifier, date]
  );
  return rows.map((row) => row.pgn);
};

/**
 * A page of games, shaped for the Content Table.
 *
 * `plyCount` is very often null: `games.ply_count` is deliberately unfilled in
 * the sample databases, which is why the *Mvs* column has had nothing to show.
 * Whether it is filled at import, derived on read, or backfilled once is an open
 * decision — `derivePlyCount` below is what would do it, and nothing calls it.
 */
export const readGames = async (connection, { limit = 200, offset = 0, order = 'date' } = {}) => {
  const by = { date: 'date desc, id', white: 'white, id', black: 'black, id', event: 'event, id' };
  const rows = await connection.all(
    `select ${ROW_COLUMNS.join(', ')} from games order by ${by[order] ?? by.date} limit ? offset ?`,
    [limit, offset]
  );
  return rows.map(toRow);
};

/** One `games` row, as the Content Table's camelCase row shape. */
const toRow = (row) => ({
  id: row.id,
  date: row.date,
  white: row.white,
  whiteElo: row.white_elo,
  black: row.black,
  blackElo: row.black_elo,
  event: row.event,
  result: row.result,
  plyCount: row.ply_count,
  createdAt: row.created_at
});

/* ---------------- the Content Table's list, paged ------------------ */

const NOT_TRASHED = 'id not in (select game_id from trash)';

/**
 * The `where` clause for one Content Table query — a Sidebar selection, then
 * a search term within it (§3.2.4.1, §3.2.4.3). Must answer exactly what
 * `stores/library.js`'s `applySelection` + `applySearch` answer over an
 * in-memory array; `tests/data-gameList.test.js` holds the two side by side.
 *
 * `searchReady` says whether `game_search` is complete for this database (see
 * `ensureGameSearch`). Until it is, search falls back to `LIKE` over the raw
 * columns — ASCII-case-insensitive only, so "polgar" misses "Polgár" for that
 * moment, but it never returns nothing merely because the backfill has not
 * finished.
 *
 * @param {{ selection?: { kind: string, id?: number }, search?: string }} query
 * @param {{ searchReady?: boolean }} [options]
 * @returns {{ sql: string, params: unknown[] }}
 */
export const gameListWhere = ({ selection = { kind: 'all' }, search = '' } = {}, { searchReady = true } = {}) => {
  const clauses = [];
  const params = [];

  switch (selection.kind) {
    case 'trash':
      clauses.push('id in (select game_id from trash)');
      break;
    case 'favorites':
      clauses.push(NOT_TRASHED, 'id in (select game_id from favorites)');
      break;
    case 'recent':
      // §4.3.2: the last import — every live game sharing the latest
      // non-empty created_at among live games. Same rule as `recentlyAdded()`.
      clauses.push(
        NOT_TRASHED,
        "created_at = (select max(created_at) from games where created_at is not null and created_at <> '' and " +
          `${NOT_TRASHED})`
      );
      break;
    case 'subscription':
      clauses.push(NOT_TRASHED, 'id in (select game_id from subscription_games where subscription_id = ?)');
      params.push(selection.id);
      break;
    case 'collection':
      clauses.push(NOT_TRASHED, 'id in (select game_id from collection_games where collection_id = ?)');
      params.push(selection.id);
      break;
    case 'tag':
      clauses.push(NOT_TRASHED, 'id in (select game_id from tag_games where tag_id = ?)');
      params.push(selection.id);
      break;
    case 'all':
    default:
      clauses.push(NOT_TRASHED);
  }

  const term = fold(search.trim());
  if (term) {
    const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    if (searchReady) {
      clauses.push("id in (select game_id from game_search where text like ? escape '\\')");
      params.push(pattern);
    } else {
      const cols = ['white', 'black', 'event', 'date', 'result'];
      clauses.push(`(${cols.map((c) => `coalesce(${c}, '') like ? escape '\\'`).join(' or ')})`);
      params.push(...cols.map(() => pattern));
    }
  }

  return { sql: clauses.join(' and '), params };
};

/**
 * A database not built by this application may lack `subscription_games`
 * (§7's own caveat). A subscription selection against one is empty, not an
 * error — the same degradation `countNewGamesForSubscription` uses.
 */
const orEmptyForSubscription = async (query, read, empty) => {
  try {
    return await read();
  } catch (error) {
    if (query.selection?.kind === 'subscription') return empty;
    throw error;
  }
};

/**
 * One page of the Content Table's rows for `query`, in the table's order
 * (`date desc, id` — `readGames`'s own default).
 */
export const readGameList = async (connection, query, { limit = 200, offset = 0, searchReady = true } = {}) => {
  const { sql, params } = gameListWhere(query, { searchReady });
  return orEmptyForSubscription(query, async () =>
    (await connection.all(
      `select ${ROW_COLUMNS.join(', ')} from games where ${sql} order by date desc, id limit ? offset ?`,
      [...params, limit, offset]
    )).map(toRow), []);
};

/**
 * Specific games by id, in the Content Table's row shape. An id no longer in
 * the database is simply absent from the result. The caller bounds `ids` —
 * each is one SQL variable.
 */
export const readGamesByIds = async (connection, ids) => {
  if (!ids.length) return [];
  return (await connection.all(
    `select ${ROW_COLUMNS.join(', ')} from games where id in (${ids.map(() => '?').join(', ')})`,
    ids
  )).map(toRow);
};

/** How many rows `readGameList` would return for `query`, across every page. */
export const countGameList = async (connection, query, { searchReady = true } = {}) => {
  const { sql, params } = gameListWhere(query, { searchReady });
  return orEmptyForSubscription(query, async () =>
    Number(await connection.value(`select count(*) from games where ${sql}`, params)) || 0, 0);
};

/**
 * The per-user marks for just these games — one page's worth — rather than
 * every mark in the database. Keyed by game id.
 *
 * @returns {Promise<Record<number, { favorite: boolean, trashed: boolean, tags: number[], collections: number[] }>>}
 */
export const readGameMarks = async (connection, ids) => {
  const marks = Object.fromEntries(ids.map((id) => [id, { favorite: false, trashed: false, tags: [], collections: [] }]));
  if (!ids.length) return marks;
  const inList = `(${ids.map(() => '?').join(', ')})`;
  const [fav, trash, tagRows, collRows] = await Promise.all([
    connection.all(`select game_id from favorites where game_id in ${inList}`, ids),
    connection.all(`select game_id from trash where game_id in ${inList}`, ids),
    connection.all(`select game_id, tag_id from tag_games where game_id in ${inList}`, ids),
    connection.all(`select game_id, collection_id from collection_games where game_id in ${inList}`, ids)
  ]);
  for (const r of fav) marks[r.game_id].favorite = true;
  for (const r of trash) marks[r.game_id].trashed = true;
  for (const r of tagRows) marks[r.game_id].tags.push(r.tag_id);
  for (const r of collRows) marks[r.game_id].collections.push(r.collection_id);
  return marks;
};

/**
 * The Sidebar's trailing counts (§3.2.3), each one the size of the list its
 * row selects. Tag and Collection counts exclude trashed games here, unlike
 * `readTagCounts`/`readCollectionCounts`, because the Sidebar's row count must
 * match what selecting that row shows.
 */
export const readLibraryCounts = async (connection) => {
  const count = async (selection) => countGameList(connection, { selection });
  const grouped = async (table, key) => {
    const rows = await connection.all(
      `select ${key} as k, count(*) as n from ${table} where game_id not in (select game_id from trash) group by ${key}`
    );
    return Object.fromEntries(rows.map((r) => [r.k, r.n]));
  };
  const [all, favorites, recent, trash, collection, tag] = await Promise.all([
    count({ kind: 'all' }),
    count({ kind: 'favorites' }),
    count({ kind: 'recent' }),
    count({ kind: 'trash' }),
    grouped('collection_games', 'collection_id'),
    grouped('tag_games', 'tag_id')
  ]);
  return { all, favorites, recent, trash, collection, tag };
};

/* ---------------- game_search: derived search text ------------------ */

const GAME_SEARCH_DDL =
  'create table if not exists game_search (' +
  'game_id integer primary key references games(id) on delete cascade, text text not null)';

const SEARCH_CHUNK = 500;

/**
 * Make `game_search` complete for this database: create it if missing, then
 * add a row for every game without one. Derived data, reconstructible from
 * `games` (database-schema.md §6a) — it never writes to `games` itself, so a
 * library supplied by another application is not "imported" by opening it.
 *
 * Chunked, one single-statement insert per chunk, for the same pooling reason
 * `insertGames` gives.
 *
 * @returns {Promise<number>} how many rows were added.
 */
export const ensureGameSearch = async (connection) => {
  await connection.run(GAME_SEARCH_DDL);
  let added = 0;
  for (;;) {
    const missing = await connection.all(
      'select id, white, black, event, date, result from games ' +
        'where id not in (select game_id from game_search) limit ?',
      [SEARCH_CHUNK]
    );
    if (!missing.length) return added;
    await insertSearchRows(connection, missing);
    added += missing.length;
  }
};

const insertSearchRows = (connection, rows) =>
  connection.run(
    `insert or replace into game_search (game_id, text) values ${rows.map(() => '(?, ?)').join(', ')}`,
    rows.flatMap((g) => [g.id, searchText(g)])
  );

/**
 * The columns `insertGame` can supply, in the order database-schema.md's §1
 * lists them. Only `pgn` and `created_at` are always present -- the rest come
 * from whichever PGN tags the source actually wrote (§4: "Application fields
 * with no source value remain NULL unless they can be derived safely").
 */
export const INSERT_COLUMNS = [
  'pgn', 'event', 'site', 'date', 'round', 'white', 'black', 'result',
  'white_elo', 'black_elo', 'eco', 'time_control', 'fen', 'termination',
  'ply_count', 'created_at',
  // §4.1's own Chess.com mapping targets every one of these seven -- added
  // 23 Sep, found missing by a live Chess.com import that silently dropped
  // all of them on write (the schema and `data/backends/schema.js` already
  // had the columns; only this allowlist was stale).
  'tournament', 'current_position', 'variant', 'rated',
  'white_accuracy', 'black_accuracy', 'time_class',
  // §2.3, added 23 Sep for per-game source tracking: an Online import's
  // provenance. NULL for Paste/File, same allowlist gap as the row above
  // would otherwise repeat -- added here alongside the schema/DDL change,
  // not after a second silent-drop bug.
  'source_type', 'source_identifier'
];

/**
 * Insert one game. §1, §4 -- every import stores the source PGN verbatim,
 * lifts each PGN tag it recognises into its field, and leaves `movetext`
 * NULL (§3.1: NULL means "read `pgn`"). `movetext` is never written here.
 *
 * Only `pgn` is required (§1: "Only `id` and `pgn` are required"); every
 * other column in `INSERT_COLUMNS` is optional and stored NULL when
 * `fields` does not supply it. A key `fields` carries that is not in
 * `INSERT_COLUMNS` is ignored rather than inserted, so a caller that hands
 * this an object with extra bookkeeping on it (a parser's own scratch
 * fields, say) cannot corrupt the row by accident.
 *
 * @param {import('./connection.js').Connection} connection
 * @param {Record<string, unknown>} fields schema-spelled (snake_case) column
 *   values -- see `INSERT_COLUMNS`.
 * @returns {Promise<number>} the new row's id.
 */
export const insertGame = async (connection, fields) => {
  if (!fields || fields.pgn === undefined || fields.pgn === null) {
    throw new DataError('insertGame requires pgn');
  }
  const columns = INSERT_COLUMNS.filter((c) => fields[c] !== undefined);
  const sql =
    `insert into games (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`;
  await connection.run(sql, columns.map((c) => fields[c] ?? null));
  return Number(await connection.value('select last_insert_rowid()'));
};

/**
 * Insert several games, in order, and return each as `readGames`'s own row
 * shape -- the same fields, the same camelCase -- so a row just inserted and
 * a row just reloaded from the database are indistinguishable to a caller.
 *
 * ONE STATEMENT PER BATCH, not `begin` / one `insertGame` per row / `commit`
 * (what this used to do). That pattern sent four-plus separate calls to the
 * connection and relied on all of them sharing one physical connection to
 * behave as a single transaction. `@tauri-apps/plugin-sql` pools
 * connections -- each `run()`/`value()` call is its own IPC round trip that
 * can land on any connection in the pool -- so nothing guaranteed `begin`,
 * the inserts and `commit` ran on the same one; when they didn't, `commit`
 * (or the recovery `rollback`) failed with "no transaction is active" and
 * the whole batch silently never wrote (20 Sep 2026 -- caught live, via
 * Plyvio's own Add Games: pasting into a library whose `loadGames()` had
 * just run reliably triggered it, because that's exactly the kind of
 * concurrent connection demand that makes two calls land on different pooled
 * connections). A single multi-row INSERT can't have this problem: SQLite
 * commits one statement as an atomic unit on its own, and there is only one
 * call to route, so there's nothing left to split across connections. See
 * `data/backends/tauri.js`'s own header comment on `last_insert_rowid()`
 * for the earlier instance of this exact class of bug.
 *
 * BATCHED, not one statement for the whole import (what this used to do,
 * until 23 Sep). Every bound value is its own SQL variable, and SQLite
 * refuses a statement past its own limit (`SQLITE_MAX_VARIABLE_NUMBER`,
 * 32766 by default since 3.32.0) -- a real Chess.com import of ~10,000
 * games hit exactly this, live: "too many SQL variables", the whole write
 * silently lost because the caller (`stores/importer.js`'s `runRealWrite`)
 * only logs a write failure rather than surfacing it. `MAX_INSERT_VARIABLES`
 * keeps each chunk's statement well under that limit -- headroom against a
 * smaller compiled limit on either backend, and a reasonably sized IPC
 * round trip (Tauri) or worker message (PWA) per chunk. This does not
 * reintroduce the connection-pooling bug above: each chunk is still its own
 * single, complete INSERT, and its `last_insert_rowid()` is read
 * immediately after, from the SAME connection call that just wrote it (see
 * "Ids" below) -- there is no separate `begin`/`commit` for pooling to land
 * on different connections. What batching does give up is whole-import
 * atomicity: chunks are not wrapped in one enclosing transaction (doing so
 * would reintroduce that exact bug, an explicit `begin`/`commit` as their
 * own separate pooled calls), so a chunk that fails after earlier chunks
 * already committed leaves a partial write rather than none. Accepted: the
 * only way this now happens is a genuine per-chunk SQL failure, not
 * exceeding a limit -- sizing is what used to fail, and that's exactly what
 * this fixes.
 *
 * Every row in one INSERT must supply the same columns, so `columns` is the
 * union of whatever any row in the batch actually carries (in
 * `INSERT_COLUMNS`' own order) -- a row that doesn't carry one of them gets
 * an explicit NULL for it, the same value an omitted column would already
 * default to, so this changes nothing about what gets stored. Computed once
 * from every row across the whole import, not per chunk, so every chunk's
 * statement shares the same column list.
 *
 * Validated up front, before anything touches the connection: a batch with
 * a `pgn`-less row throws before the first INSERT is even built, so a bad
 * row still loses the whole import (nothing partial to roll back, because
 * nothing partial was ever sent).
 *
 * Ids: SQLite assigns a multi-row INSERT's own rowids sequentially, in the
 * order the rows were listed, when -- as here -- no row supplies its own
 * `id` (`INSERT_COLUMNS` never includes it). `last_insert_rowid()` reports
 * the LAST row's id, so each chunk's own ids run backward from it. This
 * depends on nothing else inserting into `games` between one chunk's
 * statement and reading its result, and on chunks themselves running
 * strictly in order -- both exactly what `stores/importer.js`'s own
 * single-lane rule ("EXACTLY ONE IMPORT AT A TIME") and this function's own
 * sequential `await`-per-chunk loop already guarantee.
 *
 * @param {import('./connection.js').Connection} connection
 * @param {Record<string, unknown>[]} rows one per game -- see `insertGame`.
 * @returns {Promise<object[]>}
 */
const MAX_INSERT_VARIABLES = 16000;

export const insertGames = async (connection, rows) => {
  if (!rows.length) return [];

  for (const fields of rows) {
    if (!fields || fields.pgn === undefined || fields.pgn === null) {
      throw new DataError('insertGame requires pgn');
    }
  }

  const columns = INSERT_COLUMNS.filter((c) => rows.some((fields) => fields[c] !== undefined));
  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  const rowsPerBatch = Math.max(1, Math.floor(MAX_INSERT_VARIABLES / columns.length));

  // game_search (§6a) is derived from exactly what this writes, so it is
  // written alongside rather than left for `ensureGameSearch` to backfill.
  // `if not exists` because a library from another application may lack it.
  await connection.run(GAME_SEARCH_DDL);

  const inserted = [];
  for (let start = 0; start < rows.length; start += rowsPerBatch) {
    const batch = rows.slice(start, start + rowsPerBatch);
    const sql =
      `insert into games (${columns.join(', ')}) values ${batch.map(() => placeholders).join(', ')}`;
    const params = batch.flatMap((fields) => columns.map((c) => fields[c] ?? null));

    await connection.run(sql, params);
    const lastId = Number(await connection.value('select last_insert_rowid()'));
    const firstId = lastId - (batch.length - 1);

    batch.forEach((fields, i) => {
      inserted.push({
        id: firstId + i,
        date: fields.date ?? null,
        white: fields.white ?? null,
        whiteElo: fields.white_elo ?? null,
        black: fields.black ?? null,
        blackElo: fields.black_elo ?? null,
        event: fields.event ?? null,
        result: fields.result ?? null,
        plyCount: fields.ply_count ?? null,
        createdAt: fields.created_at ?? null
      });
    });
    await insertSearchRows(connection, inserted.slice(-batch.length));
  }

  return inserted;
};

/**
 * Strip the tag pair section from a PGN document, leaving the movetext.
 *
 * A tag pair section is a run of `[Name "value"]` lines at the top, ended by a
 * blank line. Lives here rather than in `$lib/pgn` because it is about a PGN
 * *document*, and that module deals only in movetext, which §3.1 is careful to
 * say is what `games.movetext` holds.
 */
export const movetextOf = (pgn) => {
  if (!pgn) return '';
  const lines = String(pgn).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || /^\s*\[[^\]]*\]\s*$/.test(lines[i]))) i++;
  return lines.slice(i).join('\n').trim();
};

/**
 * The movetext of a `games` row, following §3.1's precedence exactly:
 *
 *   if games.movetext IS NOT NULL   use it
 *   else                            use the movetext inside games.pgn
 *
 * The second return value says which, because "the application is reading its
 * own copy" and "the application is reading the imported original" are different
 * states and a caller that edits needs to know which one it started from.
 *
 * Today every row in `samples/` takes the second branch: import writes `pgn` and
 * leaves `movetext` NULL (§4), so all 1,130 sample games resolve through their
 * PGN. The first branch is what a row looks like once something has written a
 * movetext back to it, which nothing yet does.
 *
 * Pure and row-shaped rather than query-shaped, so that a caller holding a row
 * already — mock data included — applies the same rule as one reading a database
 * instead of a second copy of it that can drift.
 *
 * @param {{movetext?: string|null, pgn?: string|null}|null} row
 * @returns {{movetext: string, source: 'movetext'|'pgn'|'none'}}
 */
export const movetextFromRow = (row) => {
  if (!row) return { movetext: '', source: 'none' };
  if (row.movetext !== null && row.movetext !== undefined) {
    return { movetext: row.movetext, source: 'movetext' };
  }
  if (row.pgn === null || row.pgn === undefined) return { movetext: '', source: 'none' };
  return { movetext: movetextOf(row.pgn), source: 'pgn' };
};

/**
 * The movetext for a game in a database. §3.1's precedence, applied to the row.
 *
 * @returns {Promise<{movetext: string, source: 'movetext'|'pgn'|'none'}>}
 */
export const readMovetextFor = async (connection, id) =>
  movetextFromRow(await connection.get('select movetext, pgn from games where id = ?', [id]));

/**
 * Store an edited movetext. §3.1: every write stores the complete resulting
 * document, `pgn` is never patched, and nothing is stored as a diff.
 *
 * Not yet called by the application; the read path lands first. The tests use
 * it, because a round trip through the database is the thing worth proving.
 */
export const writeMovetextFor = async (connection, id, movetext) => {
  await connection.run('update games set movetext = ? where id = ?', [movetext, id]);
};

/** The original PGN, byte for byte as imported. §1, field 2. */
export const readPgn = async (connection, id) =>
  (await connection.get('select pgn from games where id = ?', [id]))?.pgn ?? null;

/**
 * A game's `site` and `round` — §1's two record fields the Library's list
 * columns don't carry (§3.2.4.2 names eight, not these two), so a caller
 * that needs them for one game — the Info card — reads them on demand
 * rather than the Content Table paying for them on every row.
 *
 * Both are nullable in the schema and stay that way here: a game genuinely
 * without a Round is `{ round: null }`, not a reason to fall back to some
 * other row's value. Optional data reads as absent, never as someone else's.
 */
export const readRecordFields = async (connection, id) =>
  (await connection.get('select site, round from games where id = ?', [id])) ?? {
    site: null, round: null
  };

/**
 * Count the plies of a game's main line.
 *
 * Nothing calls this. It is what would fill `games.ply_count`, and where that
 * happens — at import, on read, or as a one-off backfill — has not been decided.
 * Parsing is not free: the whole 1,026-game sample takes a few hundred
 * milliseconds, which is nothing once and too much per keystroke.
 *
 * @param {(text: string) => number} count usually `plyCount(readMovetext(text))`
 */
export const derivePlyCount = async (connection, id, count) => {
  const { movetext } = await readMovetextFor(connection, id);
  return movetext ? count(movetext) : 0;
};

/* ============================================================================
 * §6 — the `positions` table. Derived data: every row in it is
 * reconstructible from `games`, built offline (`samples/build_positions.py`)
 * rather than aggregated by the application at read time.
 * ========================================================================= */

/**
 * A position's statistics — the Explorer Section's rows.
 *
 * One indexed lookup, not an aggregation: `positions` is `WITHOUT ROWID`,
 * clustered by `(pos, move)` (§6.1), so this is a single B-tree seek and a
 * short sequential run. `posKey` is what `game/explorer.js`'s `positionKey()`
 * already computes for the board — the first four FEN fields, per §6.2 —
 * and is passed in rather than recomputed here, so there is one function in
 * the application that knows what a position key is.
 *
 * Resolves to `[]` when `positions` doesn't exist, rather than throwing: §6
 * says plainly that "a game database without one is valid — it simply
 * cannot answer position queries, and any feature that needs them is
 * unavailable until the table is present." A library database nothing has
 * run `build_positions.py`-equivalent tooling against is exactly that case,
 * not an error.
 *
 * @returns {Promise<{move: string, games: number, white: number, draws: number, black: number}[]>}
 */
/**
 * TWO DIFFERENT EMPTIES, and the caller needs to tell them apart.
 *
 * `[]` means the table answered and holds nothing for this position — §6.3's
 * "absence is not evidence", the genuine out-of-book state the Section draws.
 * `null` means there was nothing to ask: the query threw, which for a game
 * database is §6's documented and valid case of carrying no `positions` table
 * at all ("a game database supplied by another application will not have
 * one"). A database that cannot answer and a database that answers "none" are
 * not the same fact, and collapsing both to `[]` — which this did — left the
 * Section unable to distinguish them.
 *
 * The distinction is what the Explorer's mock fallback keys off (`stores/
 * game.js`), so it is load-bearing rather than cosmetic. It stays correct
 * once every database carries the table: `null` simply stops occurring.
 *
 * @returns {Promise<Array|null>} rows, or `null` when the table cannot be
 *   queried.
 */
export const readPositionStats = async (connection, posKey) => {
  try {
    return await connection.all(
      'select move, games, white, draws, black from positions where pos = ?',
      [posKey]
    );
  } catch {
    return null;
  }
};

/* ============================================================================
 * Library features — §7. Favorites and Trash are presence tables (a row
 * means the game is a favorite / in the trash); Tags and Collections are
 * many-to-many through a membership table. None of these add a column to
 * `games` — see §7's own header for why.
 *
 * The tag membership table is `tag_games` (`tag_id, game_id`, per
 * database-schema.md §7.2) — samples/build_samples.py agrees. Sample .db
 * files built before that table was renamed still had the old `tag_games`
 * name; that was a stale-fixture problem, not a schema question, and it was
 * fixed by rebuilding the samples rather than by this file following the
 * old name.
 * ========================================================================= */

/** Every game id that is a favorite. §7.1 */
export const readFavoriteIds = async (connection) =>
  (await connection.all('select game_id from favorites')).map((r) => r.game_id);

/** Every game id in the Trash. §7.1 */
export const readTrashedIds = async (connection) =>
  (await connection.all('select game_id from trash')).map((r) => r.game_id);

/**
 * Mark a game as a favorite, or unmark it. Presence, not a flag: `on`
 * inserts the row if it is missing, `off` deletes it if it is there —
 * either way idempotent, so a caller never has to check first.
 */
export const setFavorite = async (connection, gameId, on) => {
  if (on) await connection.run('insert or ignore into favorites (game_id) values (?)', [gameId]);
  else await connection.run('delete from favorites where game_id = ?', [gameId]);
};

/** Move a game to the Trash, or restore it. Same presence-table shape as `setFavorite`. */
export const setTrashed = async (connection, gameId, on) => {
  if (on) await connection.run('insert or ignore into trash (game_id) values (?)', [gameId]);
  else await connection.run('delete from trash where game_id = ?', [gameId]);
};

/** Every Tag in this game database, in the order the Sidebar lists them. §7.2 */
export const readTags = async (connection) =>
  connection.all('select id, name from tags order by name collate nocase');

/** The tag ids a game carries. */
export const readTagIdsForGame = async (connection, gameId) =>
  (await connection.all('select tag_id from tag_games where game_id = ?', [gameId]))
    .map((r) => r.tag_id);

/** The game ids carrying a tag — what the Sidebar's Tag row filters to. */
export const readGameIdsForTag = async (connection, tagId) =>
  (await connection.all('select game_id from tag_games where tag_id = ?', [tagId]))
    .map((r) => r.game_id);

/**
 * Every game's tag ids, as a map keyed by game id. One query rather than one
 * per game — what a caller filling in a whole Content Table's worth of rows
 * needs, without an N+1 fetch.
 */
export const readTagIdsByGame = async (connection) => {
  const rows = await connection.all('select game_id, tag_id from tag_games');
  const byGame = {};
  for (const row of rows) (byGame[row.game_id] ??= []).push(row.tag_id);
  return byGame;
};

/** Every tag's game count in one query, for the Sidebar's trailing-count slots. */
export const readTagCounts = async (connection) => {
  const rows = await connection.all('select tag_id, count(*) as n from tag_games group by tag_id');
  return Object.fromEntries(rows.map((r) => [r.tag_id, r.n]));
};

/**
 * Find a Tag by name, or create it. `tags.name` is unique ignoring case
 * (§7.2), so applying "Blunder" when "blunder" already exists must reuse the
 * existing row rather than fail or fork the Sidebar into two rows for one tag.
 *
 * @returns {Promise<number>} the tag's id, existing or newly created.
 */
export const findOrCreateTag = async (connection, name) => {
  const clean = String(name ?? '').trim();
  const existing = await connection.get(
    'select id from tags where name = ? collate nocase',
    [clean]
  );
  if (existing) return existing.id;
  await connection.run('insert into tags (name) values (?)', [clean]);
  return connection.value('select id from tags where name = ? collate nocase', [clean]);
};

/** Apply a tag to a game. Idempotent — applying an already-carried tag is a no-op. */
export const addTagToGame = async (connection, tagId, gameId) => {
  await connection.run(
    'insert or ignore into tag_games (game_id, tag_id) values (?, ?)',
    [gameId, tagId]
  );
};

/** Remove a tag from a game. Idempotent in the same way `addTagToGame` is. */
export const removeTagFromGame = async (connection, tagId, gameId) => {
  await connection.run(
    'delete from tag_games where game_id = ? and tag_id = ?',
    [gameId, tagId]
  );
};

/**
 * Every Collection in this game database — regular and Smart alike, in the
 * order the Sidebar lists them. §7.3
 *
 * `smart` comes back as a boolean (the schema stores it as 0/1, per the
 * convention `database-schema.md` states once for every such column); a
 * Smart Collection's `criteria` is returned exactly as stored — parsing it is
 * not this function's job, since §7.3 leaves the format unspecified.
 */
export const readCollections = async (connection) =>
  (await connection.all(
    'select id, name, smart, criteria from collections order by name collate nocase'
  )).map((row) => ({ ...row, smart: row.smart === 1 }));

/**
 * The game ids in a regular Collection. Not meaningful for a Smart
 * Collection — §7.3 says its membership is computed from `criteria` at query
 * time, not stored in `collection_games` — so this returns `[]` for one
 * rather than silently answering a different question.
 */
export const readGameIdsForCollection = async (connection, collectionId) =>
  (await connection.all(
    'select game_id from collection_games where collection_id = ?',
    [collectionId]
  )).map((r) => r.game_id);

/**
 * Every regular Collection's game count in one query. A Smart Collection is
 * absent from the result (see `readGameIdsForCollection`) rather than
 * reported as zero, so a caller can tell "empty" apart from "not this kind
 * of count."
 */
export const readCollectionCounts = async (connection) => {
  const rows = await connection.all(
    'select collection_id, count(*) as n from collection_games group by collection_id'
  );
  return Object.fromEntries(rows.map((r) => [r.collection_id, r.n]));
};

/**
 * Every regular Collection's member game ids, as a map keyed by game id. Same
 * shape and reason as `readTagIdsByGame`; a Smart Collection contributes no
 * entries, for the reason given on `readGameIdsForCollection`.
 */
export const readCollectionIdsByGame = async (connection) => {
  const rows = await connection.all('select game_id, collection_id from collection_games');
  const byGame = {};
  for (const row of rows) (byGame[row.game_id] ??= []).push(row.collection_id);
  return byGame;
};

/**
 * Create a regular Collection. Smart Collections are not built here —
 * `criteria`'s format is unspecified (§7.3) and inventing one as a side
 * effect of this function would be the kind of decision this file avoids
 * making silently, same as the `tag_games`/`tag_games` naming above.
 *
 * `collections.name` is unique ignoring case, like `tags.name`; creating a
 * Collection that only differs in case reuses the existing row.
 *
 * @returns {Promise<number>} the collection's id, existing or newly created.
 */
export const findOrCreateCollection = async (connection, name) => {
  const clean = String(name ?? '').trim();
  const existing = await connection.get(
    'select id from collections where name = ? collate nocase',
    [clean]
  );
  if (existing) return existing.id;
  await connection.run('insert into collections (name, smart) values (?, 0)', [clean]);
  return connection.value('select id from collections where name = ? collate nocase', [clean]);
};

/** Add a game to a regular Collection. Idempotent, same shape as `addTagToGame`. */
export const addGameToCollection = async (connection, collectionId, gameId) => {
  await connection.run(
    'insert or ignore into collection_games (collection_id, game_id) values (?, ?)',
    [collectionId, gameId]
  );
};

/** Remove a game from a regular Collection. Idempotent, same shape as `removeTagFromGame`. */
export const removeGameFromCollection = async (connection, collectionId, gameId) => {
  await connection.run(
    'delete from collection_games where collection_id = ? and game_id = ?',
    [collectionId, gameId]
  );
};

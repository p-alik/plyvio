import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import { SUBSCRIPTIONS } from '$lib/library/mock.js';
import {
  readTags, readCollections, readGameList, countGameList, readGameMarks,
  readGamesByIds, readLibraryCounts, ensureGameSearch
} from '$lib/data/games.js';
import { fold } from '$lib/library/fold.js';
import { libraryConnection } from '$lib/data/session.js';
import { objects } from './settings.js';
import { activeLibraryId } from './libraries.js';

/**
 * Library Workspace state. §3.2
 *
 * The two filtering inputs — the Sidebar selection and the search term — are
 * composable and independent (§3.2.4.1, §3.2.4.3): search applies *within* the
 * current Sidebar selection, and changing the selection does not clear the
 * search. They are therefore separate stores combined in one derived view.
 */

/**
 * Library rows, by what the list's `mode` (below) makes them.
 *
 * In 'memory' mode, every row of the list — the mock/sandbox library, and
 * tests, which set it directly (`games.set(makeGames())`). In 'sql' mode, a
 * cache of the rows fetched so far from the real database, in no particular
 * order — the list's order lives in its pages (`rowAt()`), not here.
 *
 * Every per-user mark (`trashed`, `favorite`, `tags`, `collections`) is
 * filled alongside the row, from its own tables — `subscription` is the one
 * field still unfilled (see `withMarks`). `createdAt` comes straight off the
 * real `games.created_at` column and is what `recentlyAdded()` (below) uses.
 */
export const games = writable([]);
export const subscriptions = writable(SUBSCRIPTIONS);
/** Filled by `loadGames()`, from the real database's `collections` table (§7.3). */
export const collections = writable([]);
/** Filled by `loadGames()`, from the real database's `tags` table (§7.2). */
export const tags = writable([]);

/**
 * Whatever database backs library `id` — `null` when nothing matches, OR
 * when the row has no real database behind it — a still-mock/seeded row
 * (`'location' in db` is `false`: no key at all, not even `null`) that
 * predates a real library ever being created for it, e.g. the two sample
 * rows the PWA still seeds (`Master Games`, `Sample Games` — its `libraries`
 * table has no real counterpart for them; see `data/session.js`'s own
 * comment). Resolving one of those is deliberately inert for now: there is
 * nothing real to open, so this resolves `null` and every caller's own
 * null-connection handling takes over from there, same as it always has for
 * "no connection at all."
 */
export async function connectionForLibrary(id) {
  const db = get(objects).databases.find((d) => d.id === id);
  if (!db || !('location' in db)) return null;
  return libraryConnection(id);
}

/**
 * `connectionForLibrary()` for whichever library the switcher currently has
 * active (`stores/libraries.js`'s `activeLibraryId`) — the one connection
 * `loadGames()` below and a Game tab's own movetext fetch (`stores/
 * game.js`'s `loadRealGame`) both use, so switching libraries changes what
 * either of them reads. A real import's write path (`stores/importer.js`'s
 * `runRealWrite`) does NOT use this — it writes to the request's own chosen
 * `destination` via `connectionForLibrary()` directly, which may be a
 * different library than whichever one is active.
 */
export async function activeLibraryConnection() {
  return connectionForLibrary(get(activeLibraryId));
}

/* ---------------- the Content Table's list, paged -------------------- */

/**
 * Rows fetched per request. `readGames`'s own default page, and about seven
 * screens of the table at 30px a row.
 */
export const PAGE = 200;

/**
 * Where the Content Table's rows come from.
 *
 * 'memory' — `games` IS the list: every row is in it, and filtering, search
 *   and counts run over it in JavaScript (`applySelection`, `applySearch`,
 *   `memoryCounts`). The mock/sandbox library and the test suite use this;
 *   `tests/library.test.js` drives it directly with `games.set(...)`.
 *
 * 'sql' — a real game database is open. The list is paged: `ensureRange()`
 *   fetches pages of `PAGE` rows as the table's viewport needs them, filtered,
 *   searched and ordered by the database (`data/games.js`'s `gameListWhere`),
 *   so a library of any size costs one screen of rows, not all of them. The
 *   5,000-row single load this replaced silently truncated a larger library.
 *   `games` becomes a by-id cache of every row fetched so far — what
 *   `findGame()` and a Game tab's Info card (`stores/game.js`) read, and what
 *   their optimistic favourite/tag/collection edits write into.
 */
let mode = 'memory';
/** The connection the 'sql' list reads through; null in 'memory' mode. */
let listConnection = null;
/**
 * Whether `game_search` is complete for `listConnection` — see
 * `data/games.js`'s `ensureGameSearch`. Until it is, search runs on the raw
 * columns instead.
 */
let searchReady = false;
/** The library `loadGames()` last loaded, to tell a switch from a reload. */
let loadedLibraryId;

/** Page index -> the ids on that page, or the in-flight fetch of it. */
let pages = new Map();
/** Bumped whenever the list is invalidated; a page fetched under an older one is discarded. */
let listVersion = 0;
/** Bumped whenever the list changes OR a page lands — what the Content Table re-renders on. */
export const listTick = writable(0);
/** How many rows the current selection + search yields, across every page. */
export const visibleTotal = writable(0);

const EMPTY_COUNTS = { all: 0, favorites: 0, recent: 0, trash: 0, collection: {}, tag: {} };
/** Counts for the Sidebar trailing slots. */
export const counts = writable(EMPTY_COUNTS);

let rowsById = new Map();
games.subscribe((all) => { rowsById = new Map(all.map((g) => [g.id, g])); });

/** Put rows into the `games` cache, replacing any with the same id. */
function upsertRows(rows) {
  if (!rows.length) return;
  games.update((all) => {
    const byId = new Map(all.map((g) => [g.id, g]));
    for (const r of rows) byId.set(r.id, r);
    return [...byId.values()];
  });
}

/** A `games` row as the Content Table reads it, marks included. */
const withMarks = (row, marks) => ({
  ...row,
  ...(marks ?? { favorite: false, trashed: false, tags: [], collections: [] }),
  // subscription_games (§8) records which subscription a game arrived
  // through, in this same database — read path not added yet.
  subscription: null
  // games.created_at (§1) may legitimately be NULL — `recentlyAdded()`
  // already treats a falsy `createdAt` as ineligible.
});

const listQuery = () => ({ selection: get(selection), search: get(search) });

let refreshSequence = 0;

/**
 * Invalidate the list: drop every fetched page, recount the current
 * selection + search, and — `recount` — the Sidebar's counts too. The rows
 * already in `games` stay; only which ids sit at which index is forgotten.
 *
 * Runs on every selection or search change (`recount: false` — neither
 * changes a Sidebar count), from `loadGames()`, and after a write that can
 * move a game between lists (`stores/game.js`'s `persistFavourite`).
 */
export async function refreshList({ recount = true } = {}) {
  const sequence = ++refreshSequence;
  listVersion++;
  pages = new Map();
  listTick.update((n) => n + 1);

  if (mode === 'memory') {
    visibleTotal.set(get(visibleGames).length);
    if (recount) counts.set(memoryCounts(get(games)));
    return;
  }

  const connection = listConnection;
  try {
    const [total, fresh] = await Promise.all([
      countGameList(connection, listQuery(), { searchReady }),
      recount ? readLibraryCounts(connection) : null
    ]);
    if (sequence !== refreshSequence) return;
    visibleTotal.set(total);
    if (fresh) counts.set(fresh);
  } catch (err) {
    console.error('Plyvio: failed to count the library list', err);
  }
}

/**
 * Make sure rows `first`..`last` (inclusive, list indices) are fetched. The
 * Content Table calls this for its viewport; keyboard navigation calls it
 * before selecting a row it may not have yet. A page already fetched, or
 * already being fetched, is not fetched again. Nothing to do in 'memory'
 * mode, where every row already is.
 */
export function ensureRange(first, last) {
  if (mode !== 'sql' || last < first) return Promise.resolve();
  const jobs = [];
  for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) {
    if (!pages.has(p)) pages.set(p, fetchPage(p, listVersion));
    jobs.push(pages.get(p));
  }
  return Promise.all(jobs);
}

async function fetchPage(p, version) {
  const connection = listConnection;
  const current = pages;
  try {
    const rows = await readGameList(connection, listQuery(), { limit: PAGE, offset: p * PAGE, searchReady });
    const marks = await readGameMarks(connection, rows.map((r) => r.id));
    // The list moved on while this was in flight — a different selection,
    // search or library. Its rows answer a question nobody is asking.
    if (version !== listVersion) return;
    upsertRows(rows.map((r) => withMarks(r, marks[r.id])));
    current.set(p, rows.map((r) => r.id));
    listTick.update((n) => n + 1);
  } catch (err) {
    // Forget the attempt, so the next scroll past this page retries it.
    if (current.get(p) instanceof Promise) current.delete(p);
    console.error(`Plyvio: failed to read library page ${p}`, err);
  }
}

let visibleNow = [];

/** The row at list index `i`, or null while its page has not arrived. */
export function rowAt(i) {
  if (mode === 'memory') return visibleNow[i] ?? null;
  const ids = pages.get(Math.floor(i / PAGE));
  if (!Array.isArray(ids)) return null;
  const id = ids[i % PAGE];
  return id === undefined ? null : rowsById.get(id) ?? null;
}

/**
 * Make sure game `id`'s row is in the `games` cache, fetching it alone if it
 * is not. A Game tab's Info card reads its marks from that row
 * (`stores/game.js`), and in 'sql' mode a game can be open without its row
 * on any fetched page — after the list moved on, or a switch away and back.
 */
export async function ensureGameRow(id) {
  if (mode !== 'sql' || rowsById.has(id)) return;
  const connection = listConnection;
  try {
    const [row] = await rereadRows(connection, [id]);
    if (row && listConnection === connection && !rowsById.has(id)) upsertRows([row]);
  } catch (err) {
    console.error(`Plyvio: failed to read library row ${id}`, err);
  }
}

/** The list index of game `id`, or -1 when it is not in a fetched page. */
export function indexOfGame(id) {
  if (id == null) return -1;
  if (mode === 'memory') return visibleNow.findIndex((g) => g.id === id);
  for (const [p, ids] of pages) {
    if (!Array.isArray(ids)) continue;
    const at = ids.indexOf(id);
    if (at >= 0) return p * PAGE + at;
  }
  return -1;
}

/**
 * `loadGames()`'s own call sequence — bumped at the start of every call, so
 * a call can tell whether it is still the most recent one once its awaits
 * resolve. This is what makes it safe to call `loadGames()` from more than
 * one trigger (a library switch, or a write that lands on the active
 * library) without the two racing each other: whichever call started LAST
 * wins, regardless of which one's reads happen to resolve last. Module-level
 * rather than per-call state on purpose — every caller shares one sequence.
 */
let loadGamesSequence = 0;

/** How many ids one `readGamesByIds`/`readGameMarks` round trip carries. */
const REFRESH_CHUNK = 500;

/** Re-read rows already in the `games` cache, marks included; ids gone from the database drop out. */
async function rereadRows(connection, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += REFRESH_CHUNK) {
    const chunk = ids.slice(i, i + REFRESH_CHUNK);
    const [rows, marks] = await Promise.all([
      readGamesByIds(connection, chunk),
      readGameMarks(connection, chunk)
    ]);
    out.push(...rows.map((r) => withMarks(r, marks[r.id])));
  }
  return out;
}

/**
 * Point the Content Table at the active library's game database, through
 * the seam in `$lib/data`.
 *
 * Reads no page of rows itself: it picks the list's mode (see `mode`),
 * reloads `tags`, `collections` and the Sidebar `counts`, and invalidates the
 * list (`refreshList()`), after which the table's own `ensureRange()` calls
 * fetch whatever its viewport shows.
 *
 * A SWITCH to another library empties the `games` cache — its ids mean
 * nothing in the new database. A RELOAD of the same library re-reads the
 * rows already cached instead, so a Game tab's row (`stores/game.js`'s Info
 * card) picks up what the write changed — a newly created tag's real id in
 * place of its synthetic one, say — rather than vanishing.
 *
 * Runs on mount and again every time `activeLibraryId` changes (see the
 * subscribe below), and again whenever a write lands on a Library-view field
 * of the active library (`stores/importer.js`'s `runRealWrite` — a real
 * import's rows; `stores/game.js`'s `persistGameInfo` — tags, collections,
 * favourite). It deliberately does NOT run for a write that touches only
 * fields the list never reads — movetext, comments, engine data.
 *
 * STALE RESULTS ARE DISCARDED, NOT APPLIED. Two callers can legitimately
 * overlap — a switch's reload still in flight when an import's reload
 * starts, say — and without a guard, whichever one's reads happen to
 * resolve last would win even if it started first, silently reverting a
 * newer, correct write. `loadGamesSequence` (above) fixes that: each call
 * captures the sequence number current when IT started, and only applies
 * its result if nothing newer has started in the meantime. When
 * `activeLibraryConnection()` resolves `null` (no library selected, no real
 * backend available, or a still-mock row with nothing to open), `games` is
 * explicitly reset rather than left stale.
 */
export async function loadGames() {
  const sequence = ++loadGamesSequence;
  const libraryId = get(activeLibraryId);
  const switched = libraryId !== loadedLibraryId;

  const connection = await activeLibraryConnection();
  if (!connection) {
    if (sequence !== loadGamesSequence) return;
    // No real database behind the active library — Master Games in the PWA
    // (deliberately never given one; see `stores/settings.js`'s
    // `ensureSampleGamesLibrary()`), nothing selected yet, or a genuine
    // connection failure.
    mode = 'memory';
    listConnection = null;
    loadedLibraryId = libraryId;
    games.set([]);
    tags.set([]);
    collections.set([]);
    refreshList();
    return;
  }

  const known = switched ? [] : get(games).map((g) => g.id);
  const [tagRows, collectionRows, reread] = await Promise.all([
    readTags(connection),
    readCollections(connection),
    rereadRows(connection, known)
  ]);

  // A newer call has started since this one began — its result, once it
  // lands, is the authoritative one. Applying this older result now would
  // silently undo whatever the newer call already found or is about to.
  if (sequence !== loadGamesSequence) return;

  if (switched || listConnection !== connection) searchReady = false;
  mode = 'sql';
  listConnection = connection;
  loadedLibraryId = libraryId;
  games.set(reread);
  tags.set(tagRows);
  collections.set(collectionRows);
  await refreshList();

  if (!searchReady) completeSearch(connection);
}

/**
 * Backfill `game_search` for a database that lacks some of it — one built by
 * another application, or before the table existed — in the background.
 * Once complete, search switches from the raw columns to it, and a search
 * already showing is re-run so it gains its diacritic-insensitive matches.
 */
async function completeSearch(connection) {
  try {
    await ensureGameSearch(connection);
  } catch (err) {
    console.error('Plyvio: failed to build the search index', err);
    return;
  }
  if (listConnection !== connection) return;
  searchReady = true;
  if (get(search).trim()) refreshList({ recount: false });
}

/** { kind: 'all'|'favorites'|'recent'|'trash'|'subscription'|'collection'|'tag', id?: number } */
export const selection = writable({ kind: 'all' });
export const search = writable('');
export const selectedGameId = writable(null);
export const offline = writable(false);

/* ---------------- sidebar collapse (§3.2.3.8) ----------------------- */

const COLLAPSE_KEY = 'plyvio.library.sidebar';

function initialCollapsed() {
  if (!browser) return false;
  try { return localStorage.getItem(COLLAPSE_KEY) === 'collapsed'; } catch { return false; }
}

export const sidebarCollapsed = writable(initialCollapsed());

sidebarCollapsed.subscribe((v) => {
  if (!browser) return;
  try { localStorage.setItem(COLLAPSE_KEY, v ? 'collapsed' : 'expanded'); } catch { /* ignore */ }
});

export function toggleSidebar() {
  sidebarCollapsed.update((v) => !v);
}

/* ---------------- section collapse (§3.2.3.1) ----------------------- */

/**
 * The three unbounded groups fold away; the Library views do not.
 *
 * Subscriptions, Collections and Tags grow without bound, so a library with
 * forty tags pushes everything else off the panel. Folding is how the user
 * gets that space back. The Library views are three fixed rows that never
 * grow — folding them would save 78px and cost the one group that is always
 * worth seeing, which is why they lost their heading rather than gained a
 * disclosure (§3.2.3.1).
 *
 * Trash is not in this set either: it is anchored outside the scrolling flow.
 */
export const SECTIONS = ['subscriptions', 'collections', 'tags'];

const SECTIONS_KEY = 'plyvio.library.sections';

function initialSections() {
  const none = { subscriptions: false, collections: false, tags: false };
  if (!browser) return none;
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    if (!raw) return none;
    const saved = JSON.parse(raw);
    // Read defensively: a key added later must not inherit `undefined`, and a
    // key removed later must not linger.
    return Object.fromEntries(SECTIONS.map((s) => [s, saved[s] === true]));
  } catch { return none; }
}

/** { subscriptions: boolean, collections: boolean, tags: boolean } — true is folded. */
export const sectionCollapsed = writable(initialSections());

sectionCollapsed.subscribe((v) => {
  if (!browser) return;
  try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(v)); } catch { /* ignore */ }
});

export function toggleSection(name) {
  if (!SECTIONS.includes(name)) return;
  sectionCollapsed.update((v) => ({ ...v, [name]: !v[name] }));
}

export function expandSection(name) {
  if (!SECTIONS.includes(name)) return;
  sectionCollapsed.update((v) => (v[name] ? { ...v, [name]: false } : v));
}

/* ---------------- Recently Added (§4.3.2) ------------------------- */

/**
 * "Recently Added" means the last import, not a time window — revised
 * 20 Sep 2026, on request. Every row from one `gameRowsFromPgnText()` call
 * shares a single `created_at` (see `pgn/importPgn.js`), so the games from
 * the most recent import are exactly the ones whose `createdAt` equals the
 * library's max `createdAt`. A game with no `createdAt` (a database
 * populated outside the application's import process, per §1) is never
 * eligible.
 */
export function recentlyAdded(all) {
  const eligible = all.filter((g) => !g.trashed && g.createdAt);
  if (!eligible.length) return [];
  const latest = eligible.reduce(
    (max, g) => (g.createdAt > max ? g.createdAt : max),
    eligible[0].createdAt
  );
  return eligible.filter((g) => g.createdAt === latest);
}

/* ---------------- filtering ----------------------------------------- */

export function applySelection(all, sel) {
  switch (sel.kind) {
    case 'trash':        return all.filter((g) => g.trashed);
    case 'favorites':    return all.filter((g) => !g.trashed && g.favorite);
    case 'recent':       return recentlyAdded(all);
    case 'subscription': return all.filter((g) => !g.trashed && g.subscription === sel.id);
    case 'collection':   return all.filter((g) => !g.trashed && g.collections.includes(sel.id));
    case 'tag':          return all.filter((g) => !g.trashed && g.tags.includes(sel.id));
    case 'all':
    default:             return all.filter((g) => !g.trashed);
  }
}

/**
 * Search covers the indexed fields named in §3.2.4.1 — players, event, site
 * and other metadata. Case- and diacritic-insensitive, so "polgar" finds
 * "Polgár"; a database of chess names is unusable otherwise.
 */
// `fold` lives in $lib/library/fold.js — `game_search` (data/games.js) must fold identically.

export function applySearch(list, term) {
  const q = fold(term.trim());
  if (!q) return list;
  return list.filter((g) =>
    fold(g.white).includes(q) ||
    fold(g.black).includes(q) ||
    fold(g.event).includes(q) ||
    g.date.includes(q) ||
    g.result.includes(q)
  );
}

/** The rows the Content Table shows: Sidebar selection, then search within it. */
export const visibleGames = derived(
  [games, selection, search],
  ([$games, $sel, $q]) => applySearch(applySelection($games, $sel), $q)
);

/** The Sidebar counts, computed over an in-memory list ('memory' mode). */
export function memoryCounts(all) {
  const live = all.filter((g) => !g.trashed);
  const byCollection = {}, byTag = {};
  for (const g of live) {
    for (const c of g.collections ?? []) byCollection[c] = (byCollection[c] || 0) + 1;
    for (const t of g.tags ?? []) byTag[t] = (byTag[t] || 0) + 1;
  }
  return {
    all: live.length,
    favorites: live.filter((g) => g.favorite).length,
    recent: recentlyAdded(all).length,
    trash: all.filter((g) => g.trashed).length,
    collection: byCollection,
    tag: byTag
  };
}

/*
 * Keep the list current. In 'memory' mode everything is derived from `games`
 * synchronously, so a test's `games.set(...)` is visible through `counts`,
 * `visibleTotal` and `rowAt()` at once. In 'sql' mode a changed selection or
 * search re-asks the database; a change to the `games` cache (a page landing,
 * an optimistic edit) does not, since it moves no row between lists.
 */
visibleGames.subscribe((v) => {
  visibleNow = v;
  if (mode !== 'memory') return;
  visibleTotal.set(v.length);
  listTick.update((n) => n + 1);
});
games.subscribe((all) => {
  if (mode === 'memory') counts.set(memoryCounts(all));
});
let lastQuery = null;
derived([selection, search], (q) => q).subscribe(([sel, q]) => {
  const key = JSON.stringify([sel, q]);
  if (key === lastQuery) return;
  lastQuery = key;
  if (mode === 'sql') refreshList({ recount: false });
});

/* ---------------- selection and navigation --------------------------- */

/** Which foldable group a destination lives in, or null for the ungrouped ones. */
const SECTION_OF = {
  subscription: 'subscriptions',
  collection: 'collections',
  tag: 'tags'
};

export function selectSidebar(sel) {
  selection.set(sel);
  // A selection made from the rail flyout or the More… popover can land inside
  // a folded group. Unfolding it keeps the selected row visible, so the
  // Sidebar never shows a selection the user cannot see.
  const section = SECTION_OF[sel.kind];
  if (section) expandSection(section);
  // §3.2.4.3 — the search is NOT cleared; the two are independent.
}

export function selectGame(id) { selectedGameId.set(id); }
export function clearSearch() { search.set(''); }

/** A row by id — any row in the `games` cache, in either mode. */
export function findGame(id) {
  return rowsById.get(id) ?? null;
}

/** Label of the active Sidebar selection, for the scoped search placeholder. */
export function selectionLabel(sel, t, subs, colls, tgs) {
  switch (sel.kind) {
    case 'all':          return t('lib.allGames');
    case 'favorites':    return t('lib.favorites');
    case 'recent':       return t('lib.recentlyAdded');
    case 'trash':        return t('lib.trash');
    case 'subscription': return (subs.find((s) => s.id === sel.id) || {}).name || '';
    case 'collection':   return (colls.find((c) => c.id === sel.id) || {}).name || '';
    case 'tag':          return (tgs.find((x) => x.id === sel.id) || {}).name || '';
    default:             return '';
  }
}

/** §3.2.3.3 — the five shown are the most recently synchronized. */
export const SUBS_SHOWN = 5;

export const pinnedExtra = writable([]);   // ids surfaced from the More… popover

export const visibleSubscriptions = derived(
  [subscriptions, pinnedExtra],
  ([$subs, $pinned]) => {
    const byRecency = [...$subs].sort((a, b) => a.syncedDaysAgo - b.syncedDaysAgo);
    const top = byRecency.slice(0, SUBS_SHOWN);
    const extra = $pinned
      .map((id) => $subs.find((s) => s.id === id))
      .filter((s) => s && !top.includes(s));
    return [...top, ...extra];
  }
);

export const overflowSubscriptions = derived(
  [subscriptions, visibleSubscriptions],
  ([$subs, $vis]) => $subs.filter((s) => !$vis.includes(s))
);

/** Selecting from More… pins it into the visible set for this session. */
export function pinSubscription(id) {
  pinnedExtra.update((p) => (p.includes(id) ? p : [...p, id]));
  selectSidebar({ kind: 'subscription', id });
}

export function resetLibrary() {
  selection.set({ kind: 'all' });
  search.set('');
  selectedGameId.set(null);
  pinnedExtra.set([]);
  offline.set(false);
  sectionCollapsed.set({ subscriptions: false, collections: false, tags: false });
}

/*
 * Reload on every switch, not just on mount — 20 Sep 2026, the switcher's
 * first real wiring (`stores/libraries.js`'s own header comment previously
 * called this "presentational only, deliberately"; that was never an
 * approved decision, just a comment, and it undersold what was actually
 * built here — see that file). `activeLibraryId` starts at whatever
 * `firstSelectable()` picks from the seeded/mock rows before `config.db`'s
 * real ones have loaded (`stores/settings.js`'s `loadLibraries()`, called
 * separately on mount); `loadGames()` no-ops for those (no `location`), so
 * this fires again, harmlessly, once the real list replaces them and
 * `libraries.js`'s own fallback subscribe repicks a real id.
 *
 * Also runs `resetLibrary()` on every switch (added the same day, on
 * request) — a still-selected tag/collection filter, a search term, or a
 * highlighted row from the PREVIOUS library carries no meaning in the new
 * one, so the Sidebar returns to All, search clears, and the collapsed
 * Subscriptions/Collections/Tags sections re-expand. This has to be defined
 * down here, after `resetLibrary()` and every store it touches
 * (`selection`/`search`/`selectedGameId`/`offline`/`sectionCollapsed`/
 * `pinnedExtra`) — `subscribe()` fires its callback immediately and
 * synchronously, and those are `const` bindings still in their temporal
 * dead zone at the top of the file where this subscribe used to live.
 */
activeLibraryId.subscribe(() => { resetLibrary(); loadGames(); });

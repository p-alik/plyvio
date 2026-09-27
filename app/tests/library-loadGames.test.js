/**
 * `loadGames()` and the paged list behind the Library Content Table — the
 * read path onto the real game database. `loadGames()` reads no rows itself;
 * it points the list at the database, and `ensureRange()` fetches pages of
 * rows (with their favorite/trash/tag/collection marks) as the table's
 * viewport needs them. See stores/library.js.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const rows = [
  { id: 1, date: '2026.01.01', white: 'Alpha', whiteElo: 2400, black: 'Beta',
    blackElo: 2380, event: 'Test Open', result: '1-0', plyCount: null },
  { id: 2, date: '2026.01.02', white: 'Gamma', whiteElo: 2200, black: 'Delta',
    blackElo: 2210, event: 'Test Open', result: '0-1', plyCount: null }
];

const tagRows = [{ id: 10, name: 'Blunder' }];
const collectionRows = [{ id: 20, name: 'Opening Prep', smart: false, criteria: null }];

vi.mock('$lib/data/session.js', () => ({
  libraryConnection: vi.fn(),
  isTauri: () => false
}));
const marksFor = (ids) => Object.fromEntries(ids.map((id) => [id, {
  favorite: id === 1,
  trashed: false,
  tags: id === 1 ? [10] : [],
  // Game 2 belongs to two Collections at once, same as tags can be many.
  collections: id === 2 ? [20, 21] : []
}]));

const libraryCounts = { all: 2, favorites: 1, recent: 0, trash: 0, collection: { 20: 1, 21: 1 }, tag: { 10: 1 } };

vi.mock('$lib/data/games.js', () => ({
  readGameList: vi.fn(async (_c, _q, { limit, offset }) => rows.slice(offset, offset + limit)),
  readGamesByIds: vi.fn(async (_c, ids) => rows.filter((r) => ids.includes(r.id))),
  readGameMarks: vi.fn(async (_c, ids) => marksFor(ids)),
  countGameList: vi.fn(async () => rows.length),
  readLibraryCounts: vi.fn(async () => libraryCounts),
  ensureGameSearch: vi.fn(async () => 0),
  readTags: vi.fn(async () => tagRows),
  readCollections: vi.fn(async () => collectionRows)
}));

const {
  games, tags, collections, counts, visibleTotal, search, selection, loadGames,
  ensureRange, rowAt, indexOfGame, ensureGameRow, PAGE
} = await import('../src/lib/stores/library.js');
const { libraryConnection } = await import('$lib/data/session.js');
const { objects } = await import('../src/lib/stores/settings.js');
const { activeLibraryId } = await import('../src/lib/stores/libraries.js');
const dataGames = await import('$lib/data/games.js');

beforeEach(() => {
  games.set([]);
  tags.set([]);
  collections.set([]);
  libraryConnection.mockReset();
  for (const fn of Object.values(dataGames)) fn.mockClear?.();
  search.set('');
  selection.set({ kind: 'all' });
  // A real, selected library — `loadGames()` (via `activeLibraryConnection()`)
  // now checks this before calling `libraryConnection()` at all. A row with
  // no `location` key (a still-mock/seeded one) is skipped entirely — see
  // the dedicated tests for that below.
  objects.update((o) => ({
    ...o,
    databases: [{ id: 42, name: 'Test Library', location: '/tmp/test.db', enabled: true, status: 'indexed' }]
  }));
  activeLibraryId.set(42);
});

describe('loadGames', () => {
  it('clears games (not a no-op) when the active library has no real connection', async () => {
    libraryConnection.mockResolvedValue(null);
    games.set([{ id: 'placeholder' }]);
    await loadGames();
    // id 42 isn't the PWA's seeded Sample Games row (`db-2`), so there is
    // nothing to fall back to — `games` is reset rather than left stale.
    expect(get(games)).toEqual([]);
    expect(dataGames.countGameList).not.toHaveBeenCalled();
    expect(dataGames.readGameList).not.toHaveBeenCalled();
  });

  it('clears games when no library is selected', async () => {
    activeLibraryId.set(null);
    // `activeLibraryId` also drives a module-level subscribe in
    // `stores/library.js` that fires its own fire-and-forget `loadGames()`
    // on every set (that's the switcher wiring itself) — let that settle
    // before resetting the mock, so it doesn't leak a stray call into this
    // test's own assertion below.
    await Promise.resolve();
    libraryConnection.mockReset();
    games.set([{ id: 'placeholder' }]);
    await loadGames();
    expect(get(games)).toEqual([]);
    expect(dataGames.readGameList).not.toHaveBeenCalled();
    expect(libraryConnection).not.toHaveBeenCalled();
  });

  it('clears games for a still-mock/seeded row with no location (Master Games, on the PWA)', async () => {
    // A row with no `location` key is exactly the "nothing real to open"
    // case `connectionForLibrary()` already gates on, so this is really a
    // regression test for that gate rather than anything specific to
    // Master Games' name.
    objects.update((o) => ({
      ...o,
      databases: [{ id: 'db-1', name: 'Master Games', enabled: true, status: 'indexed' }]
    }));
    activeLibraryId.set('db-1');
    await Promise.resolve(); // see the comment above
    libraryConnection.mockReset();
    games.set([{ id: 'placeholder' }]);
    await loadGames();
    expect(get(games)).toEqual([]);
    expect(dataGames.readGameList).not.toHaveBeenCalled();
    expect(libraryConnection).not.toHaveBeenCalled();
  });

  it('reads a real database for a real, bootstrapped Sample Games row (numeric id, with a location)', async () => {
    // `ensureSampleGamesLibrary()` (`stores/settings.js`) registers Sample
    // Games as a genuine `config.db` library — a numeric id, `location: null`
    // ("Stored in this browser"), same shape as any other library.
    objects.update((o) => ({
      ...o,
      databases: [{ id: 7, name: 'Sample Games', enabled: true, status: 'indexed', location: null }]
    }));
    activeLibraryId.set(7);
    const connection = {};
    libraryConnection.mockResolvedValue(connection);
    await loadGames();
    expect(dataGames.countGameList).toHaveBeenCalledWith(connection, expect.anything(), expect.anything());
  });

  it('reads no rows itself — the list total and the Sidebar counts, from the database', async () => {
    libraryConnection.mockResolvedValue({});
    await loadGames();
    expect(dataGames.readGameList).not.toHaveBeenCalled();
    expect(get(games)).toEqual([]);
    expect(get(visibleTotal)).toBe(2);
    expect(get(counts)).toEqual(libraryCounts);
  });

  it('populates the tags and collections stores from the real database', async () => {
    libraryConnection.mockResolvedValue({});
    await loadGames();
    expect(get(tags)).toEqual(tagRows);
    expect(get(collections)).toEqual(collectionRows);
  });
});

describe('the paged list', () => {
  const load = async () => {
    libraryConnection.mockResolvedValue({});
    await loadGames();
  };

  it('fetches a page of rows through the seam when the table asks for it', async () => {

    await load();
    expect(rowAt(0)).toBeNull();
    await ensureRange(0, 1);
    expect(dataGames.readGameList).toHaveBeenCalledWith(
      expect.anything(), { selection: { kind: 'all' }, search: '' },
      expect.objectContaining({ limit: PAGE, offset: 0 })
    );
    expect(rowAt(0).white).toBe('Alpha');
    expect(rowAt(1).white).toBe('Gamma');
    expect(get(games)).toHaveLength(2);
  });

  it('marks favorites and trash from the real presence tables', async () => {
    await load();
    await ensureRange(0, 1);
    expect(rowAt(0).favorite).toBe(true);
    expect(rowAt(0).trashed).toBe(false);
    expect(rowAt(1).favorite).toBe(false);
  });

  it('attaches each game’s real tag ids, and every Collection it belongs to', async () => {
    await load();
    await ensureRange(0, 1);
    expect(rowAt(0).tags).toEqual([10]);
    expect(rowAt(1).tags).toEqual([]);
    expect(rowAt(0).collections).toEqual([]);
    expect(rowAt(1).collections).toEqual([20, 21]);
  });

  it('leaves subscription null, which has no read path yet, and passes created_at through as-is', async () => {
    await load();
    await ensureRange(0, 0);
    expect(rowAt(0).subscription).toBeNull();
    // This fixture's rows carry no `created_at` — a database populated
    // outside the application's import process may legitimately have none.
    expect(rowAt(0).createdAt).toBeUndefined();
  });

  it('fetches a page once, however many times it is asked for while in flight', async () => {
    await load();
    await Promise.all([ensureRange(0, 0), ensureRange(0, 1), ensureRange(1, 1)]);
    expect(dataGames.readGameList).toHaveBeenCalledTimes(1);
  });

  it('asks only for the page that holds a far row — past the old 5,000-row cap', async () => {
    dataGames.countGameList.mockResolvedValueOnce(6000);
    await load();
    expect(get(visibleTotal)).toBe(6000);
    await ensureRange(5999, 5999);
    expect(dataGames.readGameList).toHaveBeenCalledTimes(1);
    expect(dataGames.readGameList).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ limit: PAGE, offset: Math.floor(5999 / PAGE) * PAGE })
    );
  });

  it('discards a page that lands after the list moved on', async () => {
    await load();
    let resolve;
    dataGames.readGameList.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = ensureRange(0, 1);
    search.set('alpha');        // a new question — the in-flight page answers the old one
    resolve(rows);
    await pending;
    expect(rowAt(0)).toBeNull();
    expect(get(games)).toEqual([]);
  });

  it('re-asks the database when the selection or search changes, without recounting the Sidebar', async () => {
    await load();
    dataGames.countGameList.mockClear();
    dataGames.readLibraryCounts.mockClear();
    selection.set({ kind: 'tag', id: 10 });
    search.set('polgar');
    await Promise.resolve();
    expect(dataGames.countGameList).toHaveBeenLastCalledWith(
      expect.anything(), { selection: { kind: 'tag', id: 10 }, search: 'polgar' }, expect.anything()
    );
    expect(dataGames.readLibraryCounts).not.toHaveBeenCalled();
  });

  it('finds a fetched row’s index, and -1 for one not fetched', async () => {
    await load();
    await ensureRange(0, 1);
    expect(indexOfGame(2)).toBe(1);
    expect(indexOfGame(99)).toBe(-1);
  });

  it('a reload of the same library re-reads the rows already cached, rather than dropping them', async () => {
    await load();
    await ensureRange(0, 1);
    await loadGames();
    expect(dataGames.readGamesByIds).toHaveBeenCalledWith(expect.anything(), [1, 2]);
    expect(get(games)).toHaveLength(2);
  });

  it('a switch to another library empties the cache — its ids mean nothing there', async () => {
    await load();
    await ensureRange(0, 1);
    objects.update((o) => ({
      ...o,
      databases: [...o.databases, { id: 43, name: 'Other', location: '/tmp/other.db', enabled: true, status: 'indexed' }]
    }));
    activeLibraryId.set(43);
    await loadGames();
    expect(get(games)).toEqual([]);
  });

  it('ensureGameRow fetches one game’s row alone, for a Game tab whose row is not cached', async () => {
    await load();
    await ensureGameRow(2);
    expect(dataGames.readGamesByIds).toHaveBeenCalledWith(expect.anything(), [2]);
    expect(get(games).map((g) => g.id)).toEqual([2]);
    expect(get(games)[0].collections).toEqual([20, 21]);
  });

  it('searches the raw columns until game_search is complete, then switches to it', async () => {
    let finish;
    dataGames.ensureGameSearch.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    search.set('polgar');
    await load();
    expect(dataGames.countGameList).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), { searchReady: false }
    );
    finish(0);
    await vi.waitFor(() => expect(dataGames.countGameList).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), { searchReady: true }
    ));
  });
});

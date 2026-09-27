/**
 * Add Games, for real — the Online tab, Chess.com source. §3.2.4.5, §4.4.5.
 *
 * Mirrors `addGames-real.test.js`'s split (a `planImport`-level describe,
 * then a lane-level describe against the real store) for the online path
 * approved 23 Sep: fetch, PGN-first mapping + JSON overlay
 * (`import/sources/chesscom.js`, covered on its own in
 * `chesscom-adapter.test.js`), the variant-scope skip, the empty
 * processing-rules seam, and a real write through the existing
 * `insertGames` path. Lichess has no adapter yet and is covered here only
 * to the extent of proving it still falls back to the old simulated
 * behavior rather than trying (and failing) to fetch anything.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { planImport, resolveOutcome, outcomeMessage } from '../src/lib/library/importJob.js';

vi.mock('$lib/data/session.js', () => ({
  libraryConnection: vi.fn(), isTauri: () => false,
  requestPersistentStorage: vi.fn(() => Promise.resolve())
}));
vi.mock('$lib/data/games.js', () => ({
  insertGames: vi.fn(),
  readTags: vi.fn(async () => []),
  readCollections: vi.fn(async () => []),
  readGameList: vi.fn(async () => []),
  readGamesByIds: vi.fn(async () => []),
  readGameMarks: vi.fn(async () => ({})),
  countGameList: vi.fn(async () => 0),
  readLibraryCounts: vi.fn(async () => ({ all: 0, favorites: 0, recent: 0, trash: 0, collection: {}, tag: {} })),
  ensureGameSearch: vi.fn(async () => 0),
  // Stage 2 (incremental re-import) defaults every test to "first import,
  // nothing known yet" unless a test overrides them -- its own describe
  // block below does.
  latestGameDateForSource: vi.fn(async () => null),
  gamePgnsForSourceOnDate: vi.fn(async () => [])
}));
vi.mock('$lib/import/sources/chesscom.js', async () => {
  const actual = await vi.importActual('$lib/import/sources/chesscom.js');
  return { ...actual, fetchAllGames: vi.fn() };
});

const onlineDraft = (over = {}) => ({ files: [], text: '', source: 'chesscom', username: 'gothamchess', range: 'all', ...over });

const request = (over = {}) => ({
  tab: 'online', draft: onlineDraft(), outcome: 'real',
  destination: 'db-1', duplicates: 'skip', tags: [], collections: [],
  ...over
});

const CHESSCOM_GAME = (over = {}) => ({
  rules: 'chess', pgn: '[Event "Live Chess"]\n[White "GothamChess"]\n[Black "Opponent"]\n[Result "1-0"]\n\n1. e4 e5 1-0',
  rated: true, time_class: 'blitz', ...over
});

describe('resolveOutcome — real now applies to Online too', () => {
  it('resolves on Online, same as Paste', () => {
    expect(resolveOutcome('online', 'real')).toBe('real');
  });
  it('still falls back to no-games-found on File, which has no real path yet', () => {
    expect(resolveOutcome('file', 'real')).toBe('none');
  });
});

describe('planImport — real Online', () => {
  it('returns a fetch marker for Chess.com, rather than a finished plan', () => {
    const p = planImport(request());
    expect(p).toEqual({
      needsOnlineFetch: true,
      draft: onlineDraft(),
      destination: 'db-1', duplicates: 'skip', tags: [], collections: []
    });
  });

  it('falls back to the old simulated behavior for Lichess, which has no adapter yet', () => {
    const p = planImport(request({ draft: onlineDraft({ source: 'lichess' }) }));
    expect(p.needsOnlineFetch).toBeUndefined();
    expect(p.outcome).toBe('none');
    expect(p.tab).toBe('online');
  });
});

const { games, tags, collections } = await import('../src/lib/stores/library.js');
const { startImport, resetImporter, cancelImport, retryImport, phase, downloaded, notice, canRetry } = await import('../src/lib/stores/importer.js');
const { libraryConnection } = await import('$lib/data/session.js');
const { objects } = await import('../src/lib/stores/settings.js');
const { activeLibraryId } = await import('../src/lib/stores/libraries.js');
const { insertGames, readGameList, latestGameDateForSource, gamePgnsForSourceOnDate } = await import('$lib/data/games.js');
const { fetchAllGames, ChessComUserNotFoundError, endTimeFromPgn } = await import('$lib/import/sources/chesscom.js');

describe('the lane runs a real Chess.com import', () => {
  beforeEach(() => {
    games.set([]);
    tags.set([]);
    collections.set([]);
    resetImporter();
    libraryConnection.mockReset();
    insertGames.mockReset();
    readGameList.mockReset();
    readGameList.mockImplementation(async () => []);
    latestGameDateForSource.mockReset();
    latestGameDateForSource.mockImplementation(async () => null);
    gamePgnsForSourceOnDate.mockReset();
    gamePgnsForSourceOnDate.mockImplementation(async () => []);
    fetchAllGames.mockReset();
    objects.update((o) => ({
      ...o,
      databases: [{ id: 'db-1', name: 'Destination Library', location: '/tmp/db-1.db', enabled: true, status: 'indexed' }]
    }));
    activeLibraryId.set('db-1');
    libraryConnection.mockResolvedValue({});
  });
  afterEach(() => resetImporter());

  const flush = () => new Promise((resolve) => {
    const unsub = phase.subscribe((p) => { if (p === 'done') { unsub(); resolve(); } });
  });

  it('fetches, maps, and writes the account\'s games, reporting real progress while it downloads', async () => {
    fetchAllGames.mockImplementation(async (username, { onMonth }) => {
      expect(username).toBe('gothamchess');
      onMonth(1, 1);
      onMonth(1, 2);
      return [CHESSCOM_GAME(), CHESSCOM_GAME({ pgn: CHESSCOM_GAME().pgn })];
    });
    insertGames.mockImplementation(async (_conn, rows) => rows.map((r, i) => ({ id: i + 1, ...r })));

    expect(startImport(request())).toBe(true);
    expect(get(phase)).toBe('downloading');
    await flush();

    expect(get(downloaded)).toBe(2);
    expect(insertGames).toHaveBeenCalledTimes(1);
    const rows = insertGames.mock.calls[0][1];
    expect(rows).toHaveLength(2);
    expect(rows[0].white).toBe('GothamChess');
    expect(rows[0].rated).toBe(1);
    expect(rows[0].time_class).toBe('blitz');
    // §2.3 -- per-game source tracking, added 23 Sep: every row from a real
    // Online import carries its provenance, end to end through the lane.
    expect(rows[0].source_type).toBe('chess_com_player');
    expect(rows[0].source_identifier).toBe('gothamchess');
    expect(get(notice).kind).toBe('clean');
  });

  it('skips games in variants Plyvio cannot render, without failing the whole import', async () => {
    fetchAllGames.mockResolvedValue([CHESSCOM_GAME(), CHESSCOM_GAME({ rules: 'bughouse' })]);
    insertGames.mockImplementation(async (_conn, rows) => rows.map((r, i) => ({ id: i + 1, ...r })));

    expect(startImport(request())).toBe(true);
    await flush();

    expect(insertGames.mock.calls[0][1]).toHaveLength(1);
  });

  it('reports "no games found" for an account that does not exist, without touching the database', async () => {
    fetchAllGames.mockRejectedValue(new ChessComUserNotFoundError('no such account'));

    expect(startImport(request())).toBe(true);
    await flush();

    expect(insertGames).not.toHaveBeenCalled();
    expect(get(notice).kind).toBe('attention');
    expect(get(notice).plan.outcome).toBe('none');
    // Regression, 23 Sep: `planRealOnlineImport`'s empty-rows case used to
    // leave `sources: []`, which made the report fall back to its
    // Paste-only default ("Pasted text") and left `add.none.online`'s
    // `{name}` empty -- "No games found for" with nothing after it.
    expect(get(notice).plan.sources).toEqual([
      { kind: 'online', label: 'chess.com — gothamchess', detail: null, games: 0 }
    ]);
    expect(outcomeMessage(get(notice).plan)).toEqual({
      key: 'add.none.online', vars: { name: 'chess.com — gothamchess' }
    });
  });

  it('reports a network failure, with nothing written, when the fetch itself fails', async () => {
    fetchAllGames.mockRejectedValue(new Error('fetch failed'));

    expect(startImport(request())).toBe(true);
    await flush();

    expect(insertGames).not.toHaveBeenCalled();
    expect(get(notice).plan.outcome).toBe('network');
    expect(get(canRetry)).toBe(true);
  });

  it('lets a failed fetch be retried', async () => {
    fetchAllGames.mockRejectedValueOnce(new Error('fetch failed'));
    fetchAllGames.mockResolvedValueOnce([CHESSCOM_GAME()]);
    insertGames.mockImplementation(async (_conn, rows) => rows.map((r, i) => ({ id: i + 1, ...r })));

    expect(startImport(request())).toBe(true);
    await flush();
    expect(get(notice).plan.outcome).toBe('network');

    expect(retryImport()).toBe(true);
    await flush();
    expect(get(notice).kind).toBe('clean');
    expect(insertGames).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow fetch that resolves after a cancel overwrite the cancelled state', async () => {
    let resolveFetch;
    fetchAllGames.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

    expect(startImport(request())).toBe(true);
    // Stage 2 (`resolveCursor`) awaits the destination connection and a
    // cursor lookup before `fetchAllGames` is even called -- wait for that
    // to actually happen before racing it with a cancel.
    while (!resolveFetch) await Promise.resolve();

    expect(cancelImport()).toBe(true);
    expect(get(phase)).toBe('done');
    expect(get(notice).kind).toBe('cancelled');

    resolveFetch([CHESSCOM_GAME()]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(insertGames).not.toHaveBeenCalled();
    expect(get(notice).kind).toBe('cancelled');
  });
});

describe('stage 2 -- incremental re-import (EXPLORATION.md, "Per-game source tracking")', () => {
  const BOUNDARY_PGN = (endTime) => [
    '[Event "Live Chess"]', '[Date "2026.09.01"]', '[White "Already"]', '[Black "Known"]',
    '[Result "1-0"]', '[Timezone "UTC"]', '[EndDate "2026.09.01"]', `[EndTime "${endTime}"]`,
    '', '1. e4 e5 1-0'
  ].join('\n');
  const KNOWN_END_TIME = endTimeFromPgn(BOUNDARY_PGN('12:00:00'));

  const chessComGameOn = (date, over = {}) => ({
    rules: 'chess', pgn: `[Event "Live Chess"]\n[Date "${date}"]\n[White "X"]\n[Black "Y"]\n[Result "1-0"]\n\n1. e4 e5 1-0`,
    rated: true, time_class: 'blitz', ...over
  });

  beforeEach(() => {
    games.set([]);
    tags.set([]);
    collections.set([]);
    resetImporter();
    libraryConnection.mockReset();
    libraryConnection.mockResolvedValue({});
    insertGames.mockReset();
    readGameList.mockReset();
    readGameList.mockImplementation(async () => []);
    fetchAllGames.mockReset();
    latestGameDateForSource.mockReset();
    gamePgnsForSourceOnDate.mockReset();
    objects.update((o) => ({
      ...o,
      databases: [{ id: 'db-1', name: 'Destination Library', location: '/tmp/db-1.db', enabled: true, status: 'indexed' }]
    }));
    activeLibraryId.set('db-1');
  });
  afterEach(() => resetImporter());

  const flush = () => new Promise((resolve) => {
    const unsub = phase.subscribe((p) => { if (p === 'done') { unsub(); resolve(); } });
  });

  it('passes the destination\'s cursor to fetchAllGames, and writes only what\'s new since it', async () => {
    latestGameDateForSource.mockImplementation(async (_conn, sourceType, identifier) => {
      expect(sourceType).toBe('chess_com_player');
      expect(identifier).toBe('gothamchess');
      return '2026.09.01';
    });
    gamePgnsForSourceOnDate.mockImplementation(async (_conn, _type, _id, date) => {
      expect(date).toBe('2026.09.01');
      return [BOUNDARY_PGN('12:00:00')];
    });
    fetchAllGames.mockImplementation(async (username, { cursorDate }) => {
      expect(username).toBe('gothamchess');
      expect(cursorDate).toBe('2026.09.01');
      return [
        // Same day as the cursor, ended before what's already known -- drop.
        chessComGameOn('2026.09.01', { end_time: KNOWN_END_TIME - 60 }),
        // Same day, ended after what's already known -- keep.
        chessComGameOn('2026.09.01', { end_time: KNOWN_END_TIME + 60 }),
        // A later day entirely -- keep, no comparison needed.
        chessComGameOn('2026.09.02', { end_time: KNOWN_END_TIME + 3600 })
      ];
    });
    insertGames.mockImplementation(async (_conn, rows) => rows.map((r, i) => ({ id: i + 1, ...r })));

    expect(startImport(request())).toBe(true);
    await flush();

    expect(insertGames).toHaveBeenCalledTimes(1);
    const rows = insertGames.mock.calls[0][1];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.date)).toEqual(['2026.09.01', '2026.09.02']);
  });

  it('a first import (no cursor found) behaves exactly like before stage 2', async () => {
    latestGameDateForSource.mockImplementation(async () => null);
    fetchAllGames.mockImplementation(async (username, { cursorDate }) => {
      expect(cursorDate).toBeNull();
      return [chessComGameOn('2020.01.01', { end_time: 1 })];
    });
    insertGames.mockImplementation(async (_conn, rows) => rows.map((r, i) => ({ id: i + 1, ...r })));

    expect(startImport(request())).toBe(true);
    await flush();

    expect(gamePgnsForSourceOnDate).not.toHaveBeenCalled();
    expect(insertGames.mock.calls[0][1]).toHaveLength(1);
  });

  it('a cursor-lookup failure falls back to a full fetch rather than failing the import', async () => {
    // The connection itself is fine (write-time still uses it normally,
    // below) -- only the cursor query fails, e.g. a database predating
    // these columns.
    latestGameDateForSource.mockRejectedValue(new Error('no such column: source_type'));
    fetchAllGames.mockImplementation(async (username, { cursorDate }) => {
      expect(cursorDate).toBeNull();
      return [chessComGameOn('2020.01.01', { end_time: 1 })];
    });
    insertGames.mockImplementation(async (_conn, rows) => rows.map((r, i) => ({ id: i + 1, ...r })));

    expect(startImport(request())).toBe(true);
    await flush();

    expect(get(notice).kind).toBe('clean');
    expect(insertGames.mock.calls[0][1]).toHaveLength(1);
  });
});

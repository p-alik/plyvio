/**
 * The Content Table's paged list in SQL (`data/games.js`'s `gameListWhere`
 * and friends) against the in-memory filter it replaces for a real library
 * (`stores/library.js`'s `applySelection` + `applySearch`).
 *
 * The two must answer identically — the mock/sandbox library and the test
 * suite still use the in-memory one — so every selection kind and a spread of
 * search terms is run through both, over the same seeded corpus, in a real
 * SQLite database built from `GAME_DB_DDL`.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { openMemoryDatabase } from '../src/lib/data/backends/memory.js';
import { GAME_DB_DDL, splitSqlStatements } from '../src/lib/data/backends/schema.js';
import {
  readGameList, countGameList, readGameMarks, readLibraryCounts, readGamesByIds,
  ensureGameSearch, insertGames
} from '../src/lib/data/games.js';
import { makeGames } from '../src/lib/library/mock.js';
import { applySelection, applySearch, memoryCounts } from '../src/lib/stores/library.js';

const createGameDb = async ({ withSearch = true } = {}) => {
  const connection = await openMemoryDatabase();
  for (const sql of splitSqlStatements(GAME_DB_DDL)) {
    if (!withSearch && /game_search/i.test(sql)) continue;
    await connection.run(sql);
  }
  return connection;
};

/** Write mock rows, and every mark they carry, into a real game database. */
const seed = async (connection, rows) => {
  for (const g of rows) {
    await connection.run(
      'insert into games (id, pgn, date, white, black, event, result, white_elo, black_elo, ply_count, created_at) ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [g.id, '*', g.date, g.white, g.black, g.event, g.result,
        g.white_elo ?? null, g.black_elo ?? null, g.ply_count ?? null, g.createdAt ?? null]
    );
    if (g.favorite) await connection.run('insert into favorites (game_id) values (?)', [g.id]);
    if (g.trashed) await connection.run('insert into trash (game_id) values (?)', [g.id]);
    for (const t of g.tags) await connection.run('insert into tag_games (tag_id, game_id) values (?, ?)', [t, g.id]);
    for (const c of g.collections) {
      await connection.run('insert into collection_games (collection_id, game_id) values (?, ?)', [c, g.id]);
    }
    if (g.subscription != null) {
      await connection.run('insert into subscription_games (subscription_id, game_id) values (?, ?)', [g.subscription, g.id]);
    }
  }
  for (const id of [0, 1, 2, 3]) {
    await connection.run('insert into tags (id, name) values (?, ?)', [id, `tag ${id}`]);
    await connection.run('insert into collections (id, name) values (?, ?)', [id, `collection ${id}`]);
  }
};

const corpus = () => {
  const rows = makeGames(600, 77).map((g) => ({
    ...g,
    // The generator's own rows are complete; `applySelection` never reads
    // anything else.
    trashed: !!g.trashed
  }));
  // The cases search exists for: a diacritic, and a LIKE wildcard in the data.
  rows.push({ ...rows[0], id: 9001, white: 'Polgár, Judit', event: '100% Open', trashed: false, favorite: true });
  // Recently Added: the latest import is several games sharing one createdAt,
  // one of them trashed — which must not count.
  const latest = '2099-01-01T00:00:00.000Z';
  for (const id of [9002, 9003, 9004]) {
    rows.push({ ...rows[1], id, createdAt: latest, trashed: id === 9004, subscription: null });
  }
  return rows;
};

const SELECTIONS = [
  { kind: 'all' }, { kind: 'trash' }, { kind: 'favorites' }, { kind: 'recent' },
  { kind: 'tag', id: 1 }, { kind: 'collection', id: 2 }, { kind: 'subscription', id: 3 }
];
const SEARCHES = ['', 'polgar', 'POLGÁR', 'carlsen', '1-0', '½', 'open', '100%', '_', '1985'];

const ids = (list) => list.map((g) => g.id).sort((a, b) => a - b);

let connection;
let rows;

beforeAll(async () => {
  connection = await createGameDb();
  rows = corpus();
  await seed(connection, rows);
  await ensureGameSearch(connection);
});

describe('gameListWhere answers what applySelection + applySearch answer', () => {
  // Parity over empty lists would prove nothing.
  it('the corpus puts games in every selection, and every search term finds some', () => {
    const empty = [
      ...SELECTIONS.filter((sel) => !applySelection(rows, sel).length).map((sel) => JSON.stringify(sel)),
      // '_' is there to find nothing: nothing in the corpus contains one, so a
      // hit would mean it was read as LIKE's single-character wildcard.
      ...SEARCHES.filter((q) => q !== '_' && !applySearch(rows, q).length)
    ];
    expect(empty).toEqual([]);
  });

  for (const selection of SELECTIONS) {
    for (const search of SEARCHES) {
      it(`${JSON.stringify(selection)} × ${JSON.stringify(search)}`, async () => {
        const expected = ids(applySearch(applySelection(rows, selection), search));
        const query = { selection, search };
        const got = await readGameList(connection, query, { limit: 10_000, offset: 0 });
        expect(ids(got)).toEqual(expected);
        expect(await countGameList(connection, query)).toBe(expected.length);
      });
    }
  }
});

describe('search', () => {
  it('ignores diacritics, so "polgar" finds "Polgár"', async () => {
    const got = await readGameList(connection, { search: 'polgar' }, { limit: 50 });
    expect(got.map((g) => g.white)).toContain('Polgár, Judit');
  });

  it('before game_search is complete, falls back to the raw columns rather than finding nothing', async () => {
    const got = await readGameList(connection, { search: 'judit' }, { limit: 50, searchReady: false });
    expect(got.map((g) => g.id)).toContain(9001);
  });

  it('treats % and _ in a term as themselves, not as wildcards', async () => {
    const got = await readGameList(connection, { search: '100%' }, { limit: 50 });
    expect(got.map((g) => g.id)).toEqual([9001]);
  });
});

describe('paging', () => {
  it('pages concatenate to the whole list, in date-descending order', async () => {
    const whole = await readGameList(connection, {}, { limit: 10_000 });
    const paged = [];
    for (let offset = 0; offset < whole.length; offset += 100) {
      paged.push(...await readGameList(connection, {}, { limit: 100, offset }));
    }
    expect(paged.map((g) => g.id)).toEqual(whole.map((g) => g.id));
    const dates = whole.map((g) => g.date ?? '');
    expect(dates).toEqual([...dates].sort().reverse());
  });
});

describe('readGameMarks', () => {
  it('returns the same marks the rows were seeded with, for just the ids asked', async () => {
    const sample = rows.filter((g) => g.favorite || g.tags.length || g.collections.length).slice(0, 20);
    const marks = await readGameMarks(connection, sample.map((g) => g.id));
    expect(Object.keys(marks)).toHaveLength(sample.length);
    for (const g of sample) {
      expect(marks[g.id]).toEqual({
        favorite: !!g.favorite, trashed: !!g.trashed, tags: g.tags, collections: g.collections
      });
    }
  });
});

describe('readLibraryCounts', () => {
  it('matches memoryCounts over the same rows', async () => {
    const { subscription: _s, ...expected } = { ...memoryCounts(rows), subscription: null };
    expect(await readLibraryCounts(connection)).toEqual(expected);
  });
});

describe('readGamesByIds', () => {
  it('returns rows for ids that exist and skips ids that do not', async () => {
    const got = await readGamesByIds(connection, [9001, 123456]);
    expect(got.map((g) => g.id)).toEqual([9001]);
  });
});

describe('game_search is derived data', () => {
  it('insertGames writes a row for every game it inserts', async () => {
    const db = await createGameDb();
    const [g] = await insertGames(db, [{ pgn: '*', white: 'Nakamura, Hikaru', black: 'Caruana, Fabiano', event: 'Côte' }]);
    expect(await db.value('select text from game_search where game_id = ?', [g.id])).toContain('cote');
    expect(ids(await readGameList(db, { search: 'COTE' }, { limit: 5 }))).toEqual([g.id]);
  });

  it('ensureGameSearch builds the table for a database without it, and leaves games untouched', async () => {
    const db = await createGameDb({ withSearch: false });
    await seed(db, rows.slice(0, 50));
    const before = await db.all('select * from games order by id');
    expect(await ensureGameSearch(db)).toBe(50);
    expect(await db.all('select * from games order by id')).toEqual(before);
    expect(Number(await db.value('select count(*) from game_search'))).toBe(50);
    // Complete now: a second call adds nothing.
    expect(await ensureGameSearch(db)).toBe(0);
  });

  it('a subscription selection on a database without subscription_games is empty, not an error', async () => {
    const db = await openMemoryDatabase();
    for (const sql of splitSqlStatements(GAME_DB_DDL)) {
      if (!/subscription_games/i.test(sql)) await db.run(sql);
    }
    const query = { selection: { kind: 'subscription', id: 1 } };
    expect(await readGameList(db, query, { limit: 5 })).toEqual([]);
    expect(await countGameList(db, query)).toBe(0);
  });
});

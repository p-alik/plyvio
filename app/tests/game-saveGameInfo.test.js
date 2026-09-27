/**
 * `stores/game.js`'s `saveGameInfo`/`toggleFavourite` — real write round
 * trip. See the working notes' `tag-collection-writes-plan.md`.
 *
 * A real connection through the in-process PWA backend, not a mocked seam — the same
 * approach `settings-pwaBootstrap.test.js` and
 * `session-explorerConnection.test.js` take, and for the same reason: the
 * whole point of this pass is what actually reaches the database, which a
 * mock can't tell us. `data/session.js`/`stores/library.js` cache state at
 * module scope, so every test calls `freshModules()` to start clean.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { resetPool } from './helpers/pwa-in-process.js';

vi.mock('../src/lib/data/backends/sqlite-worker-port.js', async () =>
  (await import('./helpers/pwa-in-process.js')).workerPortMock());


async function freshModules() {
  vi.resetModules();
  const settings = await import('../src/lib/stores/settings.js');
  const libraries = await import('../src/lib/stores/libraries.js');
  const library = await import('../src/lib/stores/library.js');
  const tabs = await import('../src/lib/stores/tabs.js');
  const game = await import('../src/lib/stores/game.js');
  const session = await import('../src/lib/data/session.js');
  const gamesData = await import('../src/lib/data/games.js');
  const sampleGames = await import('../src/lib/mock-data/sample-games.js');
  return { settings, libraries, library, tabs, game, session, gamesData, sampleGames };
}

/** Bootstrap Sample Games, activate it, and load its rows for real. */
async function setUpRealLibrary(mods) {
  const { settings, libraries, library } = mods;
  await settings.loadLibraries();
  const id = get(settings.objects).databases[0].id;
  libraries.activeLibraryId.set(id);
  await library.loadGames();
  return id;
}

beforeEach(() => {
  resetPool();
});

describe('saveGameInfo — real write round trip', () => {
  it('creates new tags/collections for real, applies them to the game, and reloads', async () => {
    const mods = await freshModules();
    const { game, library, tabs, gamesData, sampleGames } = mods;
    await setUpRealLibrary(mods);

    const gameId = sampleGames.GAMES[0].id;
    game.ensureGameState('t1', gameId);
    await library.ensureGameRow(gameId);
    tabs.activeId.set('t1');

    game.saveGameInfo('t1', {
      white: sampleGames.GAMES[0].white, white_elo: sampleGames.GAMES[0].white_elo,
      black: sampleGames.GAMES[0].black, black_elo: sampleGames.GAMES[0].black_elo,
      result: sampleGames.GAMES[0].result, event: sampleGames.GAMES[0].event,
      site: null, date: sampleGames.GAMES[0].date, round: sampleGames.GAMES[0].round,
      favorite: true,
      tags: [{ id: -1, name: 'Blunder', isNew: true }],
      collections: [{ id: -2, name: 'Favourites', isNew: true }]
    });

    // The write is fire-and-forget; poll rather than assume one flush is enough.
    await vi.waitFor(async () => {
      expect(get(library.tags).map((t) => t.name)).toContain('Blunder');
      expect(get(library.collections).map((c) => c.name)).toContain('Favourites');
    }, { timeout: 2000 });

    // Reached the real database, not just the reloaded store: read it back
    // through the repository layer directly, against a fresh connection.
    const connection = await library.activeLibraryConnection();
    const tagIds = await gamesData.readTagIdsForGame(connection, gameId);
    const tagNames = (await gamesData.readTags(connection))
      .filter((t) => tagIds.includes(t.id)).map((t) => t.name);
    expect(tagNames).toEqual(['Blunder']);

    const favoriteIds = await gamesData.readFavoriteIds(connection);
    expect(favoriteIds).toContain(gameId);

    // And the reloaded store agrees.
    const row = get(library.games).find((g) => g.id === gameId);
    expect(row.favorite).toBe(true);
    const tagName = get(library.tags).find((t) => t.id === row.tags[0])?.name;
    expect(tagName).toBe('Blunder');
  });

  it('removing a tag in the dialog removes it from the game on save', async () => {
    const mods = await freshModules();
    const { game, library, tabs, sampleGames } = mods;
    await setUpRealLibrary(mods);
    const gameId = sampleGames.GAMES[1].id;
    game.ensureGameState('t1', gameId);
    await library.ensureGameRow(gameId);
    tabs.activeId.set('t1');

    const base = {
      white: sampleGames.GAMES[1].white, white_elo: sampleGames.GAMES[1].white_elo,
      black: sampleGames.GAMES[1].black, black_elo: sampleGames.GAMES[1].black_elo,
      result: sampleGames.GAMES[1].result, event: sampleGames.GAMES[1].event,
      site: null, date: sampleGames.GAMES[1].date, round: sampleGames.GAMES[1].round,
      favorite: false
    };

    game.saveGameInfo('t1', { ...base, tags: [{ id: -1, name: 'Study', isNew: true }], collections: [] });
    await vi.waitFor(() => {
      expect(get(library.tags).map((t) => t.name)).toContain('Study');
    }, { timeout: 2000 });

    const createdId = get(library.tags).find((t) => t.name === 'Study').id;
    game.saveGameInfo('t1', { ...base, tags: [], collections: [] });

    await vi.waitFor(() => {
      const row = get(library.games).find((g) => g.id === gameId);
      expect(row.tags).toEqual([]);
    }, { timeout: 2000 });

    // The Tag itself still exists (removing it from one game doesn't delete
    // the Tag row) — only the membership is gone.
    expect(get(library.tags).some((t) => t.id === createdId)).toBe(true);
  });
});

describe('toggleFavourite — real write round trip', () => {
  it('persists the flip to the real database', async () => {
    const mods = await freshModules();
    const { game, library, tabs, gamesData, sampleGames } = mods;
    const id = await setUpRealLibrary(mods);
    const gameId = sampleGames.GAMES[2].id;
    game.ensureGameState('t1', gameId);
    await library.ensureGameRow(gameId);
    tabs.activeId.set('t1');

    game.toggleFavourite('t1');
    expect(get(library.games).find((g) => g.id === gameId).favorite).toBe(true);

    const { libraryConnection } = await import('../src/lib/data/session.js');
    await vi.waitFor(async () => {
      const connection = await libraryConnection(id);
      const favoriteIds = await gamesData.readFavoriteIds(connection);
      expect(favoriteIds).toContain(gameId);
    }, { timeout: 2000 });
  });
});

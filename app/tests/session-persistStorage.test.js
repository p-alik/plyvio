/**
 * `data/session.js`'s `requestPersistentStorage()`: asks the browser once,
 * after the user's first write, to keep this origin's storage (ADR 0005,
 * `docs/decisions/0005-pwa-storage-on-opfs-sahpool.md`).
 *
 * jsdom has no `navigator.storage`, so each test installs a stub. The PWA
 * backend runs in-process (`tests/helpers/pwa-in-process.js`), so the
 * once-only flag is really written to and read from `config.db`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPool } from './helpers/pwa-in-process.js';

vi.mock('../src/lib/data/backends/sqlite-worker-port.js', async () =>
  (await import('./helpers/pwa-in-process.js')).workerPortMock());

const stubStorage = ({ persisted = false } = {}) => {
  const storage = {
    persisted: vi.fn(async () => persisted),
    persist: vi.fn(async () => true)
  };
  Object.defineProperty(navigator, 'storage', { value: storage, configurable: true });
  return storage;
};

const freshSession = async () => {
  vi.resetModules();
  return import('../src/lib/data/session.js');
};

beforeEach(() => resetPool());
afterEach(() => { delete navigator.storage; });

describe('requestPersistentStorage', () => {
  it('asks once when storage is not yet persisted, however often it is called', async () => {
    const storage = stubStorage();
    const session = await freshSession();
    await Promise.all([session.requestPersistentStorage(), session.requestPersistentStorage()]);
    await session.requestPersistentStorage();
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });

  it('does not ask when storage is already persisted', async () => {
    const storage = stubStorage({ persisted: true });
    const session = await freshSession();
    await session.requestPersistentStorage();
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it('does not ask again in a later session: the attempt is recorded in config.db', async () => {
    stubStorage();
    await (await freshSession()).requestPersistentStorage();

    const later = stubStorage();
    await (await freshSession()).requestPersistentStorage();
    expect(later.persist).not.toHaveBeenCalled();

    const { configConnection } = await import('../src/lib/data/session.js');
    const { readUiState } = await import('../src/lib/data/config.js');
    expect((await readUiState(await configConnection())).pwaPersistRequested).toBe(true);
  });

  it('does nothing, and does not throw, where the Storage API is missing', async () => {
    const session = await freshSession();
    await expect(session.requestPersistentStorage()).resolves.toBeUndefined();
  });

  it('never rejects when the request itself fails', async () => {
    const storage = stubStorage();
    storage.persist.mockRejectedValue(new Error('denied'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = await freshSession();
    await expect(session.requestPersistentStorage()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('it follows a write the user made', () => {
  it('toggling a favourite asks for persistence after the write succeeds', async () => {
    const storage = stubStorage();
    vi.resetModules();
    const settings = await import('../src/lib/stores/settings.js');
    const libraries = await import('../src/lib/stores/libraries.js');
    const library = await import('../src/lib/stores/library.js');
    const game = await import('../src/lib/stores/game.js');
    const { GAMES } = await import('../src/lib/mock-data/sample-games.js');
    const { get } = await import('svelte/store');

    await settings.loadLibraries();
    libraries.activeLibraryId.set(get(settings.objects).databases[0].id);
    await library.loadGames();
    // Loading and the Sample Games bootstrap are not the user's writes.
    expect(storage.persist).not.toHaveBeenCalled();

    game.ensureGameState('t1', GAMES[0].id);
    await library.ensureGameRow(GAMES[0].id);
    game.toggleFavourite('t1');
    await vi.waitFor(() => expect(storage.persist).toHaveBeenCalledTimes(1));
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import AppShell from '../src/lib/components/AppShell.svelte';
import { stripTabs, activeId, workspaceState } from '../src/lib/stores/tabs.js';
import { locale } from '../src/lib/stores/i18n.js';
import {
  games, selection, search, selectedGameId, sidebarCollapsed, offline,
  visibleGames, counts, pinnedExtra, subscriptions,
  selectSidebar, selectGame, clearSearch, resetLibrary,
  applySelection, applySearch, recentlyAdded,
  visibleSubscriptions, overflowSubscriptions, SUBS_SHOWN,
  sectionCollapsed, toggleSection, expandSection, SECTIONS, collections, tags
} from '../src/lib/stores/library.js';
import { layoutColumns, widths, COLUMNS, TABLE_MIN, FIXED_TOTAL, NAME_MIN, NAME_MAX, EVENT_MIN, cellValue } from '../src/lib/library/columns.js';
import { makeGames, realRows, SUBSCRIPTIONS, COLLECTIONS, TAGS } from '../src/lib/library/mock.js';
import { GAMES } from '../src/lib/mock-data/sample-games.js';
import { readFileSync } from 'node:fs';

const readSrc = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  stripTabs.set([]);
  activeId.set('library');
  workspaceState.set({ library: { scratch: '' } });
  locale.set('en');
  games.set(makeGames());
  subscriptions.set(SUBSCRIPTIONS);
  // tags/collections now start empty (loadGames() fills them from the real
  // database — see stores/library.js); tests seed the mock data explicitly,
  // the same way tests/addGames.test.js already does.
  collections.set(COLLECTIONS);
  tags.set(TAGS);
  sidebarCollapsed.set(false);
  resetLibrary();
});
afterEach(cleanup);

/* ========================= rows for real games ========================= */

/*
 * The Library used to list 1,248 fabricated rows and nothing else, so no row in it named
 * a game the Game Workspace could open — searching for an annotated game found nothing,
 * because no row had ever carried its name. These rows are built from the game data
 * itself, which is what makes the list and the games one thing rather than two.
 */
describe('library rows for games that exist', () => {
  it('draws one row per shipped game, from the game itself', () => {
    const rows = realRows();
    expect(rows).toHaveLength(GAMES.length);
    for (const row of rows) {
      const game = GAMES.find((g) => g.id === row.id);
      expect(game, row.id).toBeTruthy();
      expect(row.white).toBe(game.white);
      expect(row.black).toBe(game.black);
      expect(row.date).toBe(game.date);
      expect(row.result).toBe(game.result);
      expect(row.white_elo).toBe(game.white_elo);
      expect(row.black_elo).toBe(game.black_elo);
      // NULL as imported, exactly as the game row leaves it (§4).
      expect(row.ply_count).toBeNull();
    }
  });

  it('puts them in the library the user sees', () => {
    const all = makeGames();
    for (const g of GAMES) expect(all.some((r) => r.id === g.id), g.id).toBe(true);
  });

  it('sorts them to the top by date without being pinned there', () => {
    // Generated games stop at 2025; most real ones are 2026, so date order is enough --
    // except the ten curated historical games (1858-2017), which sink below the 2025
    // cutoff on their own real dates and are excluded from "the top" on that basis.
    const all = makeGames();
    const newest = [...all].sort((a, b) => b.sortDate - a.sortDate).slice(0, GAMES.length - 10);
    for (const row of newest) expect(GAMES.some((g) => g.id === row.id), row.id).toBe(true);
  });

  it('still generates the stress rows the table was designed against', () => {
    // Ids are integers throughout (§1); the generated rows are the ones past the real games.
    const generated = makeGames().filter((r) => !GAMES.some((g) => g.id === r.id));
    expect(generated.length).toBeGreaterThan(1200);
    expect(generated.some((r) => r.date === '????.??.??')).toBe(true);
    expect(generated.some((r) => r.ply_count === null)).toBe(true);
  });
});

/* ============================ column model ============================ */

describe('§3.2.4.2 column sizing', () => {
  it('the eight columns are in the specified order', () => {
    expect(COLUMNS.map((c) => c.key)).toEqual([
      'date', 'white', 'white_elo', 'black', 'black_elo', 'event', 'result', 'moves'
    ]);
  });

  it('fixed columns total 246px and the table minimum is 516px', () => {
    expect(FIXED_TOTAL).toBe(246);
    expect(TABLE_MIN).toBe(516);
  });

  it('a drawn result is drawn as ½-½, whatever spelling the data holds', () => {
    const col = COLUMNS.find((c) => c.key === 'result');
    expect(cellValue({ result: '1/2-1/2' }, col)).toBe('\u00bd-\u00bd');
    expect(cellValue({ result: '\u00bd-\u00bd' }, col)).toBe('\u00bd-\u00bd');
    expect(cellValue({ result: '1-0' }, col)).toBe('1-0');
    expect(cellValue({ result: '*' }, col)).toBe('*');
  });

  it('condensed headers are Res and Mvs', () => {
    expect(COLUMNS.find((c) => c.key === 'result').header).toBe('Res');
    expect(COLUMNS.find((c) => c.key === 'moves').header).toBe('Mvs');
  });

  it('columns always sum exactly to the available width', () => {
    for (let a = TABLE_MIN; a <= 4000; a++) {
      expect(widths(a).total).toBe(a);
    }
  });

  it('White always equals Black, at every width', () => {
    for (let a = TABLE_MIN; a <= 3000; a += 7) {
      const cols = layoutColumns(a);
      const white = cols.find((c) => c.key === 'white').w;
      const black = cols.find((c) => c.key === 'black').w;
      expect(white).toBe(black);
    }
  });

  it('names never breach their 90–180 bounds', () => {
    for (let a = TABLE_MIN; a <= 4000; a += 3) {
      const w = widths(a);
      expect(w.name).toBeGreaterThanOrEqual(NAME_MIN);
      expect(w.name).toBeLessThanOrEqual(NAME_MAX);
    }
  });

  it('Event never falls below its minimum and is never capped', () => {
    expect(widths(TABLE_MIN).event).toBe(EVENT_MIN);
    expect(widths(4000).event).toBeGreaterThan(1000);
  });

  it('names absorb growth first, then Event', () => {
    expect(widths(580).name).toBe(122);        // 800px window
    expect(widths(580).event).toBe(90);
    expect(widths(696).name).toBe(180);        // 916px — names hit maximum
    expect(widths(696).event).toBe(90);
    expect(widths(780).name).toBe(180);        // 1000px — Event now growing
    expect(widths(780).event).toBe(174);
  });

  it('trailing whitespace cannot occur', () => {
    for (let a = TABLE_MIN; a <= 4000; a += 11) {
      const cols = layoutColumns(a);
      expect(cols.reduce((s, c) => s + c.w, 0)).toBe(a);
    }
  });

  it('fits the 800×600 window with the sidebar expanded', () => {
    expect(800 - 220).toBeGreaterThanOrEqual(TABLE_MIN);
    expect(widths(800 - 220).total).toBe(580);
  });

  it('the two Elo columns carry distinct accessible names', () => {
    const elos = COLUMNS.filter((c) => c.key.endsWith('_elo'));
    expect(elos.length).toBe(2);
    expect(elos[0].a11yKey).toBe('col.whiteElo');
    expect(elos[1].a11yKey).toBe('col.blackElo');
  });
});

/* ============================ mock data ============================== */

describe('mock library data', () => {
  it('is deterministic', () => {
    expect(JSON.stringify(makeGames())).toBe(JSON.stringify(makeGames()));
  });

  it('is large enough to exercise virtualisation', () => {
    expect(get(games).length).toBeGreaterThan(1000);
  });

  it('includes the awkward values the table must render', () => {
    const all = get(games);
    expect(all.some((g) => g.result === '*')).toBe(true);
    // §2.2 — an unrated player is NULL, not a placeholder, and the cell draws empty.
    expect(all.some((g) => g.white_elo === null)).toBe(true);
    expect(all.some((g) => g.white_elo === '?')).toBe(false);
    expect(all.some((g) => g.date === '????.??.??')).toBe(true);
    expect(all.some((g) => /[^\x00-\x7F]/.test(g.white + g.black))).toBe(true);
  });

  it('keeps unfinished games plausible in number', () => {
    const all = get(games);
    const share = all.filter((g) => g.result === '*').length / all.length;
    expect(share).toBeLessThan(0.05);
  });

  it('stores ply_count and no move count of its own', () => {
    const all = get(games);
    expect(all.every((g) => g.moves === undefined)).toBe(true);
    expect(all.filter((g) => g.ply_count !== null).every((g) => g.ply_count > 0)).toBe(true);
  });

  it('leaves ply_count empty on some rows, because the column is optional', () => {
    expect(get(games).some((g) => g.ply_count === null)).toBe(true);
  });

  it('displays moves derived from plies, and nothing when there are none', () => {
    const moves = COLUMNS.find((c) => c.key === 'moves');
    expect(moves.field).toBe('ply_count');
    expect(cellValue({ ply_count: 49 }, moves)).toBe('25');
    expect(cellValue({ ply_count: 50 }, moves)).toBe('25');
    expect(cellValue({ ply_count: null }, moves)).toBe('');
    expect(cellValue({ white_elo: '2800' }, COLUMNS.find((c) => c.key === 'white_elo'))).toBe('2800');
  });

  it('also reads a real row\'s camelCase fields, not only mock data\'s snake_case (regression, 23 Sep)', () => {
    // `data/games.js`'s real reads return `whiteElo`/`blackElo`/`plyCount`;
    // `library/mock.js`'s simulated rows return `white_elo`/`black_elo`/
    // `ply_count`. A real Chess.com import showed this live: every row had
    // the data, but Elo and Moves rendered blank because COLUMNS is keyed
    // on the schema's (mock's) snake_case spelling.
    const moves = COLUMNS.find((c) => c.key === 'moves');
    const whiteElo = COLUMNS.find((c) => c.key === 'white_elo');
    const blackElo = COLUMNS.find((c) => c.key === 'black_elo');
    expect(cellValue({ plyCount: 49 }, moves)).toBe('25');
    expect(cellValue({ whiteElo: 1429 }, whiteElo)).toBe(1429);
    expect(cellValue({ blackElo: 1026 }, blackElo)).toBe(1026);
    // A snake_case row's own explicit null still wins -- it's a real "no
    // rating" value, not a shape mismatch to paper over.
    expect(cellValue({ white_elo: null }, whiteElo)).toBeFalsy();
  });

  it('has more subscriptions than the sidebar shows, so More… is live', () => {
    expect(SUBSCRIPTIONS.length).toBeGreaterThan(SUBS_SHOWN);
  });
});

/* ============================ filtering =============================== */

describe('§3.2.3 sidebar filtering', () => {
  it('All Games excludes trashed games', () => {
    const all = get(games);
    expect(applySelection(all, { kind: 'all' }).every((g) => !g.trashed)).toBe(true);
  });

  it('Trash contains only trashed games', () => {
    const all = get(games);
    const t = applySelection(all, { kind: 'trash' });
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((g) => g.trashed)).toBe(true);
  });

  it('Favorites contains only favorites', () => {
    const all = get(games);
    expect(applySelection(all, { kind: 'favorites' }).every((g) => g.favorite)).toBe(true);
  });

  it('Recently Added is the last import -- every game sharing the latest createdAt', () => {
    const all = get(games);
    const r = recentlyAdded(all);
    const eligible = all.filter((g) => !g.trashed && g.createdAt);
    const latest = eligible.reduce(
      (max, g) => (g.createdAt > max ? g.createdAt : max), eligible[0].createdAt
    );
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((g) => g.createdAt === latest)).toBe(true);
    expect(eligible.filter((g) => g.createdAt === latest).length).toBe(r.length);
  });

  it('a subscription filter returns only its games', () => {
    const r = applySelection(get(games), { kind: 'subscription', id: 2 });
    expect(r.every((g) => g.subscription === 2)).toBe(true);
  });
});

/* ============================ search ================================= */

describe('§3.2.4.1 search', () => {
  it('matches player, event and result fields', () => {
    const all = applySelection(get(games), { kind: 'all' });
    expect(applySearch(all, 'carlsen').every(
      (g) => /carlsen/i.test(g.white + g.black)
    )).toBe(true);
    expect(applySearch(all, 'tata').length).toBeGreaterThan(0);
  });

  it('ignores diacritics, so "polgar" finds "Polgár"', () => {
    const all = applySelection(get(games), { kind: 'all' });
    const hits = applySearch(all, 'polgar');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((g) => /Polgár/.test(g.white + g.black))).toBe(true);
  });

  it('an empty search returns the list unchanged', () => {
    const all = applySelection(get(games), { kind: 'all' });
    expect(applySearch(all, '   ').length).toBe(all.length);
  });

  it('composes with the sidebar selection rather than replacing it', () => {
    selectSidebar({ kind: 'favorites' });
    search.set('a');
    const rows = get(visibleGames);
    expect(rows.every((g) => g.favorite)).toBe(true);
  });

  it('changing the sidebar selection does NOT clear the search', () => {
    search.set('carlsen');
    selectSidebar({ kind: 'favorites' });
    expect(get(search)).toBe('carlsen');
  });
});

/* ============================ sidebar UI ============================== */

describe('§3.2.3 sidebar rendering', () => {
  /*
    "Library" was removed as a heading (5 Sep). It named its own container —
    the tab, the switcher and the panel all already said it — so the three
    views it covered now open the panel unlabelled.
  */
  it('renders the three foldable groups, and no "Library" heading', () => {
    const { container } = render(AppShell);
    const groups = [...container.querySelectorAll('.side .grp .gl')].map((e) => e.textContent.trim());
    expect(groups).toEqual(['Subscriptions', 'Collections', 'Tags']);
    expect(container.querySelector('.side .body').textContent).not.toMatch(/^\s*Library/);
  });

  it('puts All Games first, with nothing above it', () => {
    const { container } = render(AppShell);
    const first = container.querySelector('.side .body').firstElementChild;
    expect(first.classList.contains('it')).toBe(true);
    expect(first.textContent).toContain('All Games');
  });

  it('shows at most five subscriptions, then More…', () => {
    render(AppShell);
    expect(get(visibleSubscriptions).length).toBe(SUBS_SHOWN);
    expect(get(overflowSubscriptions).length).toBe(SUBSCRIPTIONS.length - SUBS_SHOWN);
  });

  it('the five shown are the most recently synchronised', () => {
    const shown = get(visibleSubscriptions);
    const maxShown = Math.max(...shown.map((s) => s.syncedDaysAgo));
    const minHidden = Math.min(...get(overflowSubscriptions).map((s) => s.syncedDaysAgo));
    expect(maxShown).toBeLessThanOrEqual(minHidden);
  });

  it('Trash sits in the footer, outside the scrolling flow', () => {
    const { container } = render(AppShell);
    const foot = container.querySelector('.side .foot');
    expect(foot.textContent).toContain('Trash');
    expect(container.querySelector('.side .body').textContent).not.toContain('Trash');
  });

  it('marks exactly one destination active', async () => {
    const { container } = render(AppShell);
    selectSidebar({ kind: 'favorites' });
    await tick();
    const on = container.querySelectorAll('.side .it.on');
    expect(on.length).toBe(1);
    expect(on[0].textContent).toContain('Favorites');
  });

  it('renders trailing counts, grouped and unabbreviated at four digits', async () => {
    const { container } = render(AppShell);
    await tick();
    const slots = [...container.querySelectorAll('.side .it .slot')].map((e) => e.textContent.trim());
    // All Games excludes trashed games, so the total is slightly under 1,248
    const all = get(counts).all;
    expect(all).toBeGreaterThan(999);
    expect(slots).toContain(all.toLocaleString('en'));
    expect(slots.every((s) => s !== '9k+')).toBe(true);
  });

  it('abbreviates a five-digit count rather than widening the slot', async () => {
    games.set(makeGames(12000));
    const { container } = render(AppShell);
    await tick();
    const slots = [...container.querySelectorAll('.side .it .slot')].map((e) => e.textContent.trim());
    expect(slots).toContain('9k+');
  });
});

describe('§3.2.3.3 subscription trailing slot priority', () => {
  const slotFor = (container, name) => {
    const row = [...container.querySelectorAll('.side .it')]
      .find((b) => b.textContent.includes(name));
    return row?.querySelector('.slot');
  };

  it('error outranks everything', () => {
    const { container } = render(AppShell);
    expect(slotFor(container, 'DrNykterstein').querySelector('.lucide-triangle-alert')).toBeTruthy();
  });

  it('syncing outranks a new-game count', () => {
    const { container } = render(AppShell);
    expect(slotFor(container, 'Broadcasts').querySelector('.lucide-refresh-cw')).toBeTruthy();
  });

  it('a new-game count shows when nothing outranks it', () => {
    const { container } = render(AppShell);
    expect(slotFor(container, 'magnuscarlsen').textContent.trim()).toBe('12');
  });

  it('an idle subscription shows nothing', () => {
    const { container } = render(AppShell);
    expect(slotFor(container, 'Titled Tuesday').textContent.trim()).toBe('');
  });

  it('offline retains prior state and does not invent errors', async () => {
    const { container } = render(AppShell);
    offline.set(true);
    await tick();
    // the count established while online survives
    expect(slotFor(container, 'magnuscarlsen').textContent.trim()).toBe('12');
    // a genuine error is still shown
    expect(slotFor(container, 'DrNykterstein').querySelector('.lucide-triangle-alert')).toBeTruthy();
    // but an idle subscription does not acquire one
    expect(slotFor(container, 'Titled Tuesday').textContent.trim()).toBe('');
    offline.set(false);
  });
});

describe('§3.2.3.7 collapsed rail', () => {
  it('collapses and expands', async () => {
    const { container } = render(AppShell);
    expect(container.querySelector('.side.rail')).toBeNull();
    await fireEvent.click(container.querySelector('.side .tog'));
    expect(container.querySelector('.side.rail')).toBeTruthy();
  });

  it('the collapse control reports its state', async () => {
    const { container } = render(AppShell);
    const tog = container.querySelector('.side .tog');
    expect(tog.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.click(tog);
    expect(container.querySelector('.side .tog').getAttribute('aria-expanded')).toBe('false');
  });

  it('bounded destinations keep individual icons; groups collapse to one', async () => {
    const { container } = render(AppShell);
    sidebarCollapsed.set(true);
    await tick();
    const labels = [...container.querySelectorAll('.side .rail-it')]
      .map((b) => b.getAttribute('aria-label'));
    // §3.2.3.10 — NO library entry point in the rail. The rail is filters
    // within the current library; a single database glyph is the same glyph
    // for every library and could not say which one is open.
    expect(labels).toEqual([
      'All Games', 'Favorites', 'Recently Added',
      'Subscriptions', 'Collections', 'Tags', 'Trash'
    ]);
    expect(labels.some((l) => /^Library: /.test(l))).toBe(false);
  });

  it('shows no counts in the rail', async () => {
    const { container } = render(AppShell);
    sidebarCollapsed.set(true);
    await tick();
    expect(container.querySelector('.side .rail-it .slot')).toBeNull();
  });

  /*
    The flyout markup was correct all along and still invisible: `.side` had
    overflow:hidden, and the flyout is positioned at left:60px — outside the
    56px rail — so it was clipped away entirely. jsdom performs no layout, so
    every existing test passed while nothing appeared on screen. These assert
    the containing block instead of the markup.
  */
  describe('the rail flyout is not clipped away', () => {
    // Comments are stripped: the rule below is documented in prose that names
    // the very declaration it must not contain.
    const css = () => readSrc('../src/lib/components/library/LibrarySidebar.svelte')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    it('the sidebar does not clip its own overflow', () => {
      expect(css()).toMatch(/\.side\s*\{[^}]*overflow:\s*visible/s);
      expect(css()).not.toMatch(/\.side\s*\{[^}]*overflow:\s*hidden/s);
    });

    it('the flyout is positioned outside the rail, so clipping would hide it', () => {
      const m = css().match(/\.fly\.rail-fly\s*\{([^}]*)\}/s);
      expect(m).toBeTruthy();
      expect(m[1]).toMatch(/left:\s*calc\(var\(--rail-w\)\s*\+/);
    });

    it('scrolling still belongs to .body, which does clip', () => {
      expect(css()).toMatch(/\.body\s*\{[^}]*overflow-y:\s*auto/s);
      expect(css()).toMatch(/\.body\s*\{[^}]*overflow-x:\s*hidden/s);
    });
  });

  it('a group icon opens a flyout on click', async () => {
    const { container } = render(AppShell);
    sidebarCollapsed.set(true);
    await tick();
    const subs = [...container.querySelectorAll('.rail-it')]
      .find((b) => b.getAttribute('aria-label') === 'Subscriptions');
    await fireEvent.click(subs);
    const fly = container.querySelector('.fly');
    expect(fly).toBeTruthy();
    // the flyout carries the whole group, not just the visible five
    expect(fly.textContent).toContain('hikaru');
  });

  it('selecting from a flyout applies the filter and closes it', async () => {
    const { container } = render(AppShell);
    sidebarCollapsed.set(true);
    await tick();
    await fireEvent.click([...container.querySelectorAll('.rail-it')]
      .find((b) => b.getAttribute('aria-label') === 'Collections'));
    const row = [...container.querySelectorAll('.fly .it')]
      .find((b) => b.textContent.includes('Opening Prep'));
    await fireEvent.click(row);
    expect(get(selection)).toEqual({ kind: 'collection', id: 0 });
    expect(container.querySelector('.fly')).toBeNull();
    // it does NOT expand the sidebar
    expect(get(sidebarCollapsed)).toBe(true);
  });

  it('the subscriptions rail icon shows a presence dot, not a count', async () => {
    const { container } = render(AppShell);
    sidebarCollapsed.set(true);
    await tick();
    const subs = [...container.querySelectorAll('.rail-it')]
      .find((b) => b.getAttribute('aria-label') === 'Subscriptions');
    expect(subs.querySelector('.dot')).toBeTruthy();
    expect(subs.textContent.trim()).toBe('');
  });
});

describe('§3.2.3.3 More… popover', () => {
  it('reveals the remaining subscriptions', async () => {
    const { container } = render(AppShell);
    const more = [...container.querySelectorAll('.side .it')]
      .find((b) => b.textContent.includes('More…'));
    await fireEvent.click(more);
    const pop = container.querySelector('.fly.more');
    expect(pop).toBeTruthy();
    expect(pop.textContent).toContain('hikaru');
  });

  it('selecting one pins it into the visible set for the session', async () => {
    const { container } = render(AppShell);
    await fireEvent.click([...container.querySelectorAll('.side .it')]
      .find((b) => b.textContent.includes('More…')));
    const hidden = get(overflowSubscriptions)[0];
    await fireEvent.click([...container.querySelectorAll('.fly.more .it')]
      .find((b) => b.textContent.includes(hidden.name)));
    expect(get(selection)).toEqual({ kind: 'subscription', id: hidden.id });
    expect(get(visibleSubscriptions).some((s) => s.id === hidden.id)).toBe(true);
  });
});

/* ============================ content area ============================ */

describe('§3.2.4.1 content toolbar', () => {
  it('the placeholder names the scope when a filter is active', async () => {
    const { container } = render(AppShell);
    let input = container.querySelector('.tbar input');
    expect(input.placeholder).toBe('Search players, games, events, sites…');

    selectSidebar({ kind: 'favorites' });
    await tick();
    input = container.querySelector('.tbar input');
    expect(input.placeholder).toBe('Search in Favorites…');
  });

  it('a clear control appears only once there is text', async () => {
    const { container } = render(AppShell);
    expect(container.querySelector('.tbar .clear')).toBeNull();
    await fireEvent.input(container.querySelector('.tbar input'), { target: { value: 'tal' } });
    await tick();
    expect(container.querySelector('.tbar .clear')).toBeTruthy();
  });

  it('clearing empties the search', async () => {
    const { container } = render(AppShell);
    await fireEvent.input(container.querySelector('.tbar input'), { target: { value: 'tal' } });
    await new Promise((r) => setTimeout(r, 200));
    expect(get(search)).toBe('tal');
    await fireEvent.click(container.querySelector('.tbar .clear'));
    expect(get(search)).toBe('');
  });

  it('debounces rather than querying on every keystroke', async () => {
    const { container } = render(AppShell);
    const input = container.querySelector('.tbar input');
    await fireEvent.input(input, { target: { value: 'c' } });
    await fireEvent.input(input, { target: { value: 'ca' } });
    expect(get(search)).toBe('');                 // nothing committed yet
    await new Promise((r) => setTimeout(r, 200));
    expect(get(search)).toBe('ca');
  });

  it('Add Games is present and does not truncate', () => {
    const { container } = render(AppShell);
    const add = container.querySelector('.tbar .add');
    expect(add.textContent.trim()).toBe('Add Games');
  });
});

describe('§3.2.4.2 content table', () => {
  it('renders the eight headers, with Res and Mvs condensed', () => {
    const { container } = render(AppShell);
    const heads = [...container.querySelectorAll('.thead .hd')].map((e) => e.textContent.trim());
    expect(heads.length).toBe(8);
    expect(heads[0]).toContain('Date');
    expect(heads[6]).toContain('Res');      // condensed label, full name for assistive technology
    expect(heads[6]).toContain('Result');
    expect(heads[7]).toContain('Mvs');
    expect(heads[7]).toContain('Moves');
  });

  it('exposes the grid with the true total row count', async () => {
    const { container } = render(AppShell);
    await tick();
    const grid = container.querySelector('[role="grid"]');
    expect(grid.getAttribute('aria-rowcount')).toBe(String(get(visibleGames).length));
  });

  it('virtualises — far fewer rows in the DOM than in the data', async () => {
    const { container } = render(AppShell);
    await tick();
    const rendered = container.querySelectorAll('.row').length;
    expect(get(visibleGames).length).toBeGreaterThan(1000);
    expect(rendered).toBeLessThan(200);
  });

  it('headers are labels, not sortable controls', () => {
    const { container } = render(AppShell);
    expect(container.querySelector('.thead button')).toBeNull();
  });
});

describe('§3.2.4.3 selection and opening', () => {
  it('a click selects one row', async () => {
    const { container } = render(AppShell);
    await tick();
    const rows = container.querySelectorAll('.row');
    await fireEvent.click(rows[2]);
    // The store holds the row's own id; `dataset` is always a string.
    expect(String(get(selectedGameId))).toBe(rows[2].dataset.gameId);
    expect(container.querySelectorAll('.row.sel').length).toBe(1);
  });

  it('selecting another replaces the selection — there is no multi-select', async () => {
    const { container } = render(AppShell);
    await tick();
    const rows = container.querySelectorAll('.row');
    await fireEvent.click(rows[1]);
    await fireEvent.click(rows[4]);
    await tick();
    expect(container.querySelectorAll('.row.sel').length).toBe(1);
    expect(String(get(selectedGameId))).toBe(rows[4].dataset.gameId);
  });

  it('a double-click opens a Game tab', async () => {
    const { container } = render(AppShell);
    await tick();
    await fireEvent.dblClick(container.querySelectorAll('.row')[0]);
    expect(get(stripTabs).filter((t) => t.kind === 'game').length).toBe(1);
  });

  it('re-opening the same game activates the existing tab', async () => {
    const { container } = render(AppShell);
    await tick();
    const row = container.querySelectorAll('.row')[0];
    await fireEvent.dblClick(row);
    const firstId = get(stripTabs)[0].id;

    activeId.set('library');
    await tick();
    await fireEvent.dblClick(container.querySelectorAll('.row')[0]);

    expect(get(stripTabs).filter((t) => t.kind === 'game').length).toBe(1);
    expect(get(activeId)).toBe(firstId);
  });

  it('opening a different game does create a second tab', async () => {
    const { container } = render(AppShell);
    await tick();
    const rows = container.querySelectorAll('.row');
    await fireEvent.dblClick(rows[0]);
    activeId.set('library');
    await tick();
    await fireEvent.dblClick(container.querySelectorAll('.row')[3]);
    expect(get(stripTabs).filter((t) => t.kind === 'game').length).toBe(2);
  });

  /* Keyboard navigation goes through the paged list's own API (`rowAt`,
     `ensureRange`, `indexOfGame`) in either mode, and each move is async —
     the target row may be on a page not fetched yet. */
  const press = async (key) => {
    await fireEvent.keyDown(window, { key });
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  };

  it('arrow keys, Home, End and PageDown move the selection through the whole list', async () => {
    render(AppShell);
    await tick();
    const rows = get(visibleGames);

    await press('ArrowDown');
    expect(get(selectedGameId)).toBe(rows[0].id);
    await press('ArrowDown');
    expect(get(selectedGameId)).toBe(rows[1].id);
    await press('End');
    expect(get(selectedGameId)).toBe(rows[rows.length - 1].id);
    await press('Home');
    expect(get(selectedGameId)).toBe(rows[0].id);
    await press('PageDown');
    expect(get(selectedGameId)).toBe(rows[20].id);
    await press('ArrowUp');
    expect(get(selectedGameId)).toBe(rows[19].id);
  });

  it('keys pressed in quick succession each count, rather than aiming at the same row', async () => {
    render(AppShell);
    await tick();
    const rows = get(visibleGames);
    await press('Home');
    for (let i = 0; i < 3; i++) fireEvent.keyDown(window, { key: 'PageDown' });
    await new Promise((r) => setTimeout(r, 0));
    expect(get(selectedGameId)).toBe(rows[60].id);
  });

  it('Enter opens the selected game', async () => {
    render(AppShell);
    await tick();
    await press('ArrowDown');
    await press('Enter');
    expect(get(stripTabs).filter((t) => t.kind === 'game').length).toBe(1);
  });

  it('opening a game leaves the Library filter, search and selection alone', async () => {
    const { container } = render(AppShell);
    selectSidebar({ kind: 'favorites' });
    search.set('a');
    await tick();
    const row = container.querySelector('.row');
    await fireEvent.click(row);
    const sel = get(selectedGameId);
    await fireEvent.dblClick(row);
    expect(get(selection)).toEqual({ kind: 'favorites' });
    expect(get(search)).toBe('a');
    expect(get(selectedGameId)).toBe(sel);
  });
});

/* ============================ empty states ============================ */

describe('§3.2.4.2 empty states', () => {
  it('an empty search names the term and offers a way out', async () => {
    const { container } = render(AppShell);
    search.set('zugzwang');
    await tick();
    const empty = container.querySelector('.empty');
    expect(empty.textContent).toContain('zugzwang');
    expect(empty.textContent).toContain('Search all games');
    expect(empty.textContent).toContain('Clear search');
  });

  it('“Search all games” escapes the filter in one click', async () => {
    const { container } = render(AppShell);
    selectSidebar({ kind: 'favorites' });
    search.set('zzzznotfound');
    await tick();
    const link = [...container.querySelectorAll('.empty .link')]
      .find((b) => b.textContent.includes('Search all games'));
    await fireEvent.click(link);
    expect(get(selection)).toEqual({ kind: 'all' });
  });

  it('an empty collection explains rather than showing a blank table', async () => {
    games.set(get(games).map((g) => ({ ...g, collections: [] })));
    selectSidebar({ kind: 'collection', id: 0 });
    const { container } = render(AppShell);
    await tick();
    expect(container.querySelector('.empty').textContent).toContain('No games in Opening Prep');
  });

  it('an empty library offers Add Games', async () => {
    games.set([]);
    const { container } = render(AppShell);
    await tick();
    const empty = container.querySelector('.empty');
    expect(empty.textContent).toContain('No games in your library');
    expect(empty.querySelector('.add')).toBeTruthy();
  });

  it('an empty trash gets its own line', async () => {
    games.set(get(games).map((g) => ({ ...g, trashed: false })));
    selectSidebar({ kind: 'trash' });
    const { container } = render(AppShell);
    await tick();
    expect(container.querySelector('.empty').textContent).toContain('Trash is empty');
  });

  it('the toolbar and status bar survive an empty table', async () => {
    games.set([]);
    const { container } = render(AppShell);
    await tick();
    expect(container.querySelector('.tbar')).toBeTruthy();
    expect(container.querySelector('.sbar')).toBeTruthy();
  });
});

/* ============================ status bar ============================== */

describe('§3.2.4.4 status bar', () => {
  it('states the number of games displayed, and nothing else', async () => {
    const { container } = render(AppShell);
    await tick();
    const left = container.querySelector('.sbar span').textContent.trim();
    expect(left).toMatch(/^[\d,]+ games$/);
    expect(left).not.toContain('Favorites');
    expect(left).not.toContain('of');
  });

  it('the count follows the filter', async () => {
    const { container } = render(AppShell);
    selectSidebar({ kind: 'favorites' });
    await tick();
    const n = get(visibleGames).length;
    expect(container.querySelector('.sbar span').textContent).toContain(String(n));
  });

  it('shows selection state on the right, only while selected', async () => {
    const { container } = render(AppShell);
    await tick();
    const right = () => container.querySelectorAll('.sbar span')[1].textContent.trim();
    expect(right()).toBe('');
    selectGame(get(visibleGames)[0].id);
    await tick();
    expect(right()).toBe('1 selected');
  });

  it('reports the offline condition once, at workspace level', async () => {
    const { container } = render(AppShell);
    offline.set(true);
    await tick();
    expect(container.querySelector('.sbar').textContent).toContain('Offline — sync paused');
    offline.set(false);
  });

  it('offline sits in the right slot, and the count stays on the left', async () => {
    const { container } = render(AppShell);
    offline.set(true);
    await tick();
    const [left, right] = container.querySelectorAll('.sbar span');
    expect(left.textContent.trim()).toMatch(/^[\d,]+ games$/);
    expect(right.textContent).toContain('Offline — sync paused');
    offline.set(false);
  });

  it('offline outranks a row selection', async () => {
    const { container } = render(AppShell);
    selectGame(get(visibleGames)[0].id);
    offline.set(true);
    await tick();
    const right = () => container.querySelectorAll('.sbar span')[1].textContent;
    expect(right()).toContain('Offline — sync paused');
    expect(right()).not.toContain('1 selected');
    offline.set(false);
    await tick();
    expect(right().trim()).toBe('1 selected');
  });
});

/* ============================ localization ============================ */

describe('localization', () => {
  it('translates the whole workspace', async () => {
    const { container } = render(AppShell);
    locale.set('fr');
    await tick();
    const groups = [...container.querySelectorAll('.side .grp .gl')].map((e) => e.textContent.trim());
    expect(groups).toEqual(['Abonnements', 'Collections', 'Étiquettes']);
    expect(container.querySelector('.tbar .add').textContent.trim()).toBe('Ajouter des parties');
    // the heading tooltips are translated too, not left in English
    expect(container.querySelector('.side .grp').getAttribute('title'))
      .toBe('Réduire la section');
  });
});

/* ===================== §3.2.3.8 sidebar header ======================== */

describe('§3.2.3.8 the sidebar header', () => {
  const css = () => readSrc('../src/lib/components/library/LibrarySidebar.svelte')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('matches the Content Toolbar height, so the rail aligns with the content', () => {
    const head = css().match(/\.head\s*\{([^}]*)\}/s)[1];
    const tbar = readSrc('../src/lib/components/library/LibraryWorkspace.svelte')
      .match(/\.tbar\s*\{([^}]*)\}/s)[1];
    expect(head).toMatch(/height:\s*40px/);
    expect(tbar).toMatch(/height:\s*40px/);
  });

  it('carries no title of its own — the switcher names the library', () => {
    render(AppShell);
    expect(document.querySelector('.side .head .ttl')).toBeNull();
    const headings = [...document.querySelectorAll('.side .grp')]
      .map((e) => e.textContent.trim());
    expect(headings.some((h) => /^Library/.test(h))).toBe(false);
  });

  it('still holds the collapse control in both states', async () => {
    render(AppShell);
    expect(document.querySelector('.side .head .tog')).toBeTruthy();
    sidebarCollapsed.set(true);
    await tick();
    expect(document.querySelector('.side .head .tog')).toBeTruthy();
  });
});

/* ================= §3.2.3.1 foldable sidebar groups ================= */

describe('§3.2.3.1 foldable groups', () => {
  const headFor = (container, label) =>
    [...container.querySelectorAll('.side .grp')]
      .find((b) => b.querySelector('.gl').textContent.trim() === label);

  it('folds only the three unbounded groups', () => {
    expect(SECTIONS).toEqual(['subscriptions', 'collections', 'tags']);
  });

  /*
    The Library views are three fixed rows that never grow, so folding them
    would buy 78px and cost the group most likely to be wanted. They lost
    their heading instead of gaining a disclosure.
  */
  it('leaves the Library views permanently open', () => {
    const { container } = render(AppShell);
    const names = [...container.querySelectorAll('.side .body .it .nm')].map((e) => e.textContent);
    expect(names).toContain('All Games');
    expect(names).toContain('Favorites');
    expect(names).toContain('Recently Added');
    expect(headFor(container, 'All Games')).toBeUndefined();
  });

  it('every heading is a button that reports its state', () => {
    const { container } = render(AppShell);
    for (const label of ['Subscriptions', 'Collections', 'Tags']) {
      const h = headFor(container, label);
      expect(h.tagName).toBe('BUTTON');
      expect(h.getAttribute('aria-expanded')).toBe('true');
      expect(h.getAttribute('aria-controls')).toBeTruthy();
    }
  });

  it('hides a group’s rows when folded and brings them back', async () => {
    const { container } = render(AppShell);
    const before = container.querySelectorAll('#grp-tags .it').length;
    expect(before).toBeGreaterThan(0);

    toggleSection('tags');
    await tick();
    expect(container.querySelectorAll('#grp-tags .it').length).toBe(0);
    expect(headFor(container, 'Tags').getAttribute('aria-expanded')).toBe('false');
    // and the group beside it is untouched
    expect(container.querySelectorAll('#grp-collections .it').length).toBeGreaterThan(0);

    toggleSection('tags');
    await tick();
    expect(container.querySelectorAll('#grp-tags .it').length).toBe(before);
  });

  it('folds each group independently', () => {
    toggleSection('collections');
    expect(get(sectionCollapsed)).toEqual({
      subscriptions: false, collections: true, tags: false
    });
  });

  it('ignores a name that is not a group', () => {
    const before = get(sectionCollapsed);
    toggleSection('trash');
    toggleSection('library');
    expect(get(sectionCollapsed)).toEqual(before);
  });

  /*
    A folded Subscriptions group would otherwise be the only place a sync
    error is reported, and swallow it. The heading inherits the row
    precedence: error ▸ syncing ▸ count.
  */
  it('shows a count in the heading only while folded', async () => {
    const { container } = render(AppShell);
    const slot = () => headFor(container, 'Collections').querySelector('.slot').textContent.trim();
    expect(slot()).toBe('');
    toggleSection('collections');
    await tick();
    expect(slot()).toBe(String(get(collections).length));
  });

  it('escalates a folded Subscriptions heading to the worst state below it', async () => {
    subscriptions.update((subs) =>
      subs.map((s, i) => (i === 0 ? { ...s, state: 'error' } : s)));
    const { container } = render(AppShell);
    toggleSection('subscriptions');
    await tick();
    const slot = headFor(container, 'Subscriptions').querySelector('.slot');
    expect(slot.classList.contains('err')).toBe(true);
    expect(slot.querySelector('svg')).toBeTruthy();
  });

  /*
    The rail flyout and the More… popover can both select a row inside a
    folded group. A selection the user cannot see is worse than an open group.
  */
  it('unfolds a group when something inside it is selected', async () => {
    toggleSection('tags');
    expect(get(sectionCollapsed).tags).toBe(true);
    selectSidebar({ kind: 'tag', id: get(tags)[0].id });
    expect(get(sectionCollapsed).tags).toBe(false);
  });

  it('leaves the other groups alone when it does', () => {
    toggleSection('tags');
    toggleSection('collections');
    selectSidebar({ kind: 'tag', id: get(tags)[0].id });
    expect(get(sectionCollapsed).collections).toBe(true);
  });

  it('does not unfold for a selection that belongs to no group', () => {
    toggleSection('tags');
    selectSidebar({ kind: 'favorites' });
    expect(get(sectionCollapsed).tags).toBe(true);
  });

  it('expandSection is idempotent and ignores unknown names', () => {
    expandSection('tags');
    expect(get(sectionCollapsed).tags).toBe(false);
    expandSection('nope');
    expect(get(sectionCollapsed)).toEqual({
      subscriptions: false, collections: false, tags: false
    });
  });

  it('keeps the chevron sized in both states, so headings do not shift', () => {
    const css = readSrc('../src/lib/components/library/LibrarySidebar.svelte');
    const block = css.match(/\.grp :global\(svg\)\s*\{([^}]*)\}/s)[1];
    expect(block).toMatch(/opacity/);
    expect(block).not.toMatch(/display:\s*none/);
    expect(block).not.toMatch(/visibility/);
  });
});

/* =============== §3.2.3.10 the switcher carries no frame =============== */

describe('§3.2.3.10 the switcher is frameless', () => {
  const trigger = () => readSrc('../src/lib/components/library/LibrarySwitcher.svelte')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/\.trigger\s*\{([^}]*)\}/s)[1];

  it('draws no border and no fill at rest', () => {
    const t = trigger();
    expect(t).toMatch(/border:\s*0/);
    expect(t).toMatch(/background:\s*none/);
    expect(t).not.toMatch(/border:\s*1px/);
  });

  it('keeps a hover and an open state, so it still reads as a control', () => {
    const css = readSrc('../src/lib/components/library/LibrarySwitcher.svelte');
    expect(css).toMatch(/\.trigger:hover\s*\{[^}]*background/);
    expect(css).toMatch(/\.trigger\[aria-expanded="true"\]\s*\{[^}]*background/);
  });

  it('still opens the menu', async () => {
    const { container } = render(AppShell);
    await fireEvent.click(container.querySelector('.side .head .trigger'));
    expect(container.querySelector('.side .menu')).toBeTruthy();
  });
});

<script>
  /**
   * Library Workspace — §3.2
   *
   * Two regions: the Sidebar, and a Content Area of toolbar / table / status
   * bar. The workspace fills the Workspace Area and owns all of its own
   * scrolling; the shell contributes none (§3.2.5).
   *
   * Adding games (§3.2.4.5) lives entirely inside this workspace. The dialog
   * opens over it, the import runs behind it in one lane, and the Status Bar
   * reports — there is no Import tab, no queue and no result banner, because a
   * banner between the toolbar and the table would shift the table twice in a
   * region the user may be scrolled in.
   */
  import { t, locale } from '$lib/stores/i18n.js';
  import Icon from '$lib/components/Icon.svelte';
  import {
    SearchIcon, ClearIcon, AddGames, ImportingIcon, DownloadIcon,
    Checked, ProblemIcon, NetworkErrorIcon, Offline
  } from '$lib/icons.js';
  import { openGame, activateGameFor } from '$lib/stores/tabs.js';
  import LibrarySidebar from './LibrarySidebar.svelte';
  import ContentTable from './ContentTable.svelte';
  import AddGamesDialog from './AddGamesDialog.svelte';
  import ImportReport from './ImportReport.svelte';
  import {
    visibleTotal, listTick, rowAt, ensureRange, indexOfGame, counts,
    selection, search, selectedGameId, selectGame,
    selectSidebar, clearSearch, selectionLabel, toggleSidebar,
    subscriptions, collections, tags, offline, findGame
  } from '$lib/stores/library.js';
  import {
    statusSlot, canStart, notice, plan, reportOpen, canRetry,
    cancelImport, clearNotice, openReport, closeReport, retryImport
  } from '$lib/stores/importer.js';

  let draft = $state('');
  let debounce;
  let tableRef = $state(null);
  let searchEl = $state(null);
  let addOpen = $state(false);
  let addButton = $state(null);

  const scope = $derived(selectionLabel($selection, $t, $subscriptions, $collections, $tags));
  const scoped = $derived($selection.kind !== 'all');

  /* §3.2.4.1 — the placeholder names the scope, because the scope is usually
     why a search returns nothing. */
  const placeholder = $derived(
    scoped ? $t('lib.searchIn', { scope }) : $t('lib.search')
  );

  // Keep the field in step when the store changes from elsewhere.
  $effect(() => { draft = $search; });

  /* ~150ms debounce: re-querying on every keystroke does not scale to
     thousands of games (§3.2.4.1). */
  function onInput(e) {
    const v = e.currentTarget.value;
    draft = v;
    clearTimeout(debounce);
    debounce = setTimeout(() => search.set(v), 150);
  }

  function doClear() {
    clearTimeout(debounce);
    draft = '';
    clearSearch();
    searchEl?.focus();
  }

  /* §3.2.4.3 — double-click opens the game; if it is already open, that tab
     is activated rather than a second one created. */
  function open(id) {
    const g = findGame(id);
    if (!g) return;
    const title = `${g.white.split(',')[0]}–${g.black.split(',')[0]}`;
    activateGameFor(id, title);
  }

  /* §3.2.4.5 — one lane, so the entry point is closed while an import runs.
     The Status Bar's running line is the explanation, on the same strip. */
  function openAdd() {
    if (!$canStart) return;
    addOpen = true;
  }

  function closeAdd() {
    addOpen = false;
    addButton?.focus();          // focus returns to what opened the dialog
  }

  /**
   * A finished import navigates to Recently Added.
   *
   * That view IS the result — with no banner, the table filling, the counts
   * climbing and the Sidebar moving are what tell the user it worked, and they
   * say more than a sentence would.
   */
  $effect(() => {
    if ($notice?.kind === 'clean' || ($notice?.kind === 'attention' && $notice.plan.added > 0)) {
      selectSidebar({ kind: 'recent' });
    }
  });

  /** Where keyboard navigation is headed while the target row's page loads. */
  let pendingIndex = null;

  function onKeydown(e) {
    const mod = e.metaKey || e.ctrlKey;

    // The dialog owns the keyboard while it is open.
    if (addOpen || $reportOpen) return;

    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); searchEl?.select(); return; }
    if (mod && e.key === '\\') { e.preventDefault(); toggleSidebar(); return; }
    if (e.key === 'Escape' && document.activeElement === searchEl) { doClear(); return; }
    if (mod) return;

    const total = $visibleTotal;
    if (!total) return;
    // A key pressed while an earlier one's page is still arriving moves on
    // from where that one is going, not from where the selection still is —
    // otherwise holding PageDown stalls at every page boundary.
    const i = pendingIndex ?? indexOfGame($selectedGameId);

    /* The target row may be on a page not fetched yet — End on a library of
       thousands, say — so it is fetched first, then selected. */
    const go = async (n) => {
      e.preventDefault();
      const clamped = Math.max(0, Math.min(total - 1, n));
      pendingIndex = clamped;
      await ensureRange(clamped, clamped);
      if (pendingIndex !== clamped) return;   // a later key superseded this one
      pendingIndex = null;
      const g = rowAt(clamped);
      if (!g) return;
      selectGame(g.id);
      tableRef?.scrollTo(clamped);
    };

    if (e.key === 'ArrowDown') go(i < 0 ? 0 : i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(total - 1);
    else if (e.key === 'PageDown') go((i < 0 ? 0 : i) + 20);
    else if (e.key === 'PageUp') go((i < 0 ? 0 : i) - 20);
    else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); open($selectedGameId); }
  }

  const n = (v) => v.toLocaleString($locale);

  /* §3.2.4.4 — one count of what is displayed. The Sidebar already shows the
     filter and the field already shows the term; restating them here makes the
     status bar unscannable. */
  const status = $derived(
    $visibleTotal === 1
      ? $t('lib.oneGame')
      : $t('lib.games', { n: n($visibleTotal) })
  );

  const emptyKind = $derived(
    $visibleTotal > 0 ? null
      : $search.trim() ? 'search'
      : $selection.kind === 'trash' ? 'trash'
      : $counts.all === 0 ? 'library'
      : 'filter'
  );
</script>

<svelte:window onkeydown={onKeydown} />

<div class="ws">
  <LibrarySidebar />

  <div class="ca">
    <!-- Content Toolbar (§3.2.4.1) -->
    <div class="tbar">
      <div class="search">
        <Icon icon={SearchIcon} size={14} />
        <input
          bind:this={searchEl}
          type="search"
          value={draft}
          oninput={onInput}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        {#if draft}
          <button class="clear" type="button" onclick={doClear} aria-label={$t('lib.clearSearch')}><Icon icon={ClearIcon} size={13} /></button>
        {/if}
      </div>
      <button
        class="add"
        type="button"
        bind:this={addButton}
        disabled={!$canStart}
        title={$canStart ? null : $t('add.importing')}
        onclick={openAdd}
      >
        <Icon icon={AddGames} size={13} />{$t('lib.addGames')}
      </button>
    </div>

    <!-- Content Table (§3.2.4.2) -->
    {#if emptyKind}
      <div class="empty">
        {#if emptyKind === 'library'}
          <div class="et">{$t('empty.libraryTitle')}</div>
          <div class="eb">{$t('empty.libraryBody')}</div>
          <button class="add" type="button" disabled={!$canStart} onclick={openAdd}>
            <Icon icon={AddGames} size={13} />{$t('lib.addGames')}
          </button>
        {:else if emptyKind === 'search'}
          <div class="et">{$t('empty.searchTitle', { term: $search.trim() })}</div>
          <div class="eb">
            {#if scoped}<span>{$t('empty.searchScope', { scope })}</span> · {/if}
            <button class="link" type="button"
                    onclick={() => selectSidebar({ kind: 'all' })}>{$t('empty.searchAll')}</button>
            · <button class="link" type="button" onclick={doClear}>{$t('lib.clearSearch')}</button>
          </div>
        {:else if emptyKind === 'trash'}
          <div class="et">{$t('empty.trashTitle')}</div>
        {:else}
          <div class="et">{$t('empty.filterTitle', { scope })}</div>
          <div class="eb">{$t('empty.filterBody')}</div>
        {/if}
      </div>
    {:else}
      <ContentTable
        bind:this={tableRef}
        total={$visibleTotal}
        version={$listTick}
        {rowAt}
        {ensureRange}
        selectedId={$selectedGameId}
        onselect={selectGame}
        onopen={open}
      />
    {/if}

    <!--
      Status Bar (§3.2.4.4).

      The count never leaves the left. The right slot holds at most one more
      fact, in the precedence §3.2.4.4 specifies:

        1  import running      nothing else on screen represents it
        2  unanswered outcome  the user has not seen it yet
        3  offline             a standing condition; nothing is waiting
        4  row selected        already visible as a highlighted row
    -->
    <div class="sbar">
      <span>{status}</span>

      <span class="slot">
        {#if $statusSlot?.kind === 'downloading'}
          <Icon icon={DownloadIcon} size={12} />
          <span>{$t('add.status.downloading', { n: n($statusSlot.count) })}</span>
          <button type="button" class="mini" onclick={cancelImport} aria-label={$t('add.cancelImport')}>
            <Icon icon={ClearIcon} size={11} />
          </button>

        {:else if $statusSlot?.kind === 'writing'}
          <Icon icon={ImportingIcon} size={12} />
          <span>{$t('add.status.writing', { n: n($statusSlot.count), total: n($statusSlot.total) })}</span>
          <span class="prog"><i style="width:{Math.round($statusSlot.fraction * 100)}%"></i></span>
          <button type="button" class="mini" onclick={cancelImport} aria-label={$t('add.cancelImport')}>
            <Icon icon={ClearIcon} size={11} />
          </button>

        {:else if $statusSlot?.kind === 'added'}
          <!-- About eight seconds, then it removes itself. Nothing is lost if
               it is missed: the table and the counts already say it. -->
          <Icon icon={Checked} size={12} />
          <span>{$t('add.status.added', { n: n($statusSlot.count) })}</span>

        {:else if $statusSlot?.kind === 'cancelled'}
          <span>{$t('add.status.cancelled', { n: n($statusSlot.count) })}</span>
          <button type="button" class="mini" onclick={clearNotice} aria-label={$t('add.dismiss')}>
            <Icon icon={ClearIcon} size={11} />
          </button>

        {:else if $statusSlot?.kind === 'attention'}
          <!-- Persists until answered: it survives Sidebar changes, searches,
               and switching tabs and back. -->
          {#if $canRetry}
            <!-- Network error: nothing was written and the request was sound,
                 so the remedy is the action, not a report. -->
            <Icon icon={NetworkErrorIcon} size={12} />
            <span class="msg">{$t($statusSlot.message.key, $statusSlot.message.vars)}</span>
            <button type="button" class="act" onclick={retryImport}>{$t('add.tryAgain')}</button>
          {:else if $statusSlot.message}
            <Icon icon={ProblemIcon} size={12} />
            <button type="button" class="act msg" onclick={openReport}>
              {$t($statusSlot.message.key, $statusSlot.message.vars)}
            </button>
          {:else}
            <Icon icon={ProblemIcon} size={12} />
            <button type="button" class="act" onclick={openReport}>
              {$t('add.status.attention', { n: n($statusSlot.count) })}
            </button>
          {/if}
          <button type="button" class="mini" onclick={clearNotice} aria-label={$t('add.dismiss')}>
            <Icon icon={ClearIcon} size={11} />
          </button>

        {:else if $offline}
          <Icon icon={Offline} size={12} />
          <span>{$t('lib.offline')}</span>

        {:else if $selectedGameId}
          {$t('lib.selected')}
        {/if}
      </span>
    </div>
  </div>

  {#if addOpen}
    <AddGamesDialog onclose={closeAdd} />
  {/if}

  {#if $reportOpen && $plan}
    <ImportReport plan={$plan} onclose={closeReport} />
  {/if}
</div>

<style>
  .ws {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--surface);
    overflow: hidden;
    /* The dialog's scrim is positioned against this box, so it covers the
       workspace and nothing else — the same containment ConfirmRemove uses. */
    position: relative;
  }

  .ca { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }

  .tbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 10px;
    border-bottom: 1px solid var(--rule);
    background: var(--chrome);
  }

  /* min-width:0 so the field can shrink below its placeholder rather than
     pushing the Content Area past the window (§3.2.5). */
  .search {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 8px;
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-radius: 4px;
  }
  .search:focus-within { border-color: var(--focus); }
  .search :global(svg) { flex: none; color: var(--muted); }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    color: var(--ink);
    font: 12.5px var(--sans);
    outline: none;
    appearance: none;
  }
  .search input::-webkit-search-cancel-button { display: none; }
  .clear {
    flex: none;
    width: 17px; height: 17px;
    display: grid; place-items: center;
    border-radius: 3px;
    color: var(--faint);
    font-size: 13px;
  }
  .clear:hover { background: var(--chrome-2); color: var(--ink); }

  /* A primary action never truncates (§3.2.4.1). */
  .add {
    flex: none;
    height: 26px;
    padding: 0 11px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-radius: 4px;
    color: var(--ink);
    font: 12.5px var(--sans);
    white-space: nowrap;
  }
  .add :global(svg) { color: var(--muted); }
  .add:hover:not(:disabled) { background: var(--chrome-2); }
  .add:disabled { opacity: .45; cursor: default; }

  .empty {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    text-align: center;
    background: var(--surface);
  }
  .et { font-size: 13.5px; color: var(--ink); }
  .eb { font-size: 12.5px; color: var(--muted); max-width: 48ch; }
  .link {
    font: inherit;
    color: var(--focus);
    text-decoration: underline;
  }

  .sbar {
    flex: none;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 10px;
    border-top: 1px solid var(--rule);
    background: var(--chrome);
    font: 10.5px var(--mono);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .slot { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .slot :global(svg) { flex: none; }
  .slot .msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .slot .act {
    font: inherit;
    color: var(--ink);
    text-decoration: underline;
    white-space: nowrap;
  }
  .mini {
    width: 15px; height: 15px;
    display: grid; place-items: center;
    border-radius: 2px;
    color: var(--faint);
  }
  .mini:hover { background: var(--chrome-2); color: var(--ink); }

  .prog {
    flex: none;
    width: 64px; height: 3px;
    border-radius: 2px;
    background: var(--chrome-3);
    overflow: hidden;
  }
  .prog i { display: block; height: 100%; background: var(--ink-2); }
</style>

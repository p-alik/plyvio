<script>
  /**
   * Content Table — §3.2.4.2, §3.2.4.3
   *
   * Dense, vertically scrolling, no column sorting, single selection.
   * Rows are virtualised: a library of thousands cannot put every row in the
   * DOM, so `aria-rowcount` states the true total while only a window exists.
   *
   * The data is virtualised too. The table gets a `total` and a `rowAt(i)`
   * rather than an array, and asks `ensureRange(first, last)` for whatever its
   * window shows; a row whose page has not arrived yet draws as an empty,
   * busy row of the same height, so the scroll geometry never shifts.
   * `version` changes whenever the list or a fetched page does — the only signal
   * the table has that `rowAt` would now answer differently.
   *
   * Column widths come from $lib/library/columns.js, which is pure so the
   * model is testable — vitest applies no stylesheets, so measured widths
   * could not be verified any other way.
   */
  import { tick } from 'svelte';
  import { t } from '$lib/stores/i18n.js';
  import { layoutColumns, TABLE_MIN, cellValue } from '$lib/library/columns.js';

  let { total = 0, version = 0, rowAt, ensureRange, selectedId = null, onselect, onopen } = $props();

  const ROW_H = 30;
  const OVERSCAN = 8;

  let viewport = $state(null);
  let width = $state(0);
  let height = $state(0);
  let scrollTop = $state(0);

  const cols = $derived(layoutColumns(Math.max(width, TABLE_MIN)));
  const tableWidth = $derived(cols.reduce((a, c) => a + c.w, 0));

  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN));
  const visibleCount = $derived(Math.ceil((height || 400) / ROW_H) + OVERSCAN * 2);
  const last = $derived(Math.min(total, first + visibleCount));
  const slice = $derived.by(() => {
    version;
    const out = [];
    for (let i = first; i < last; i++) out.push({ i, g: rowAt(i) });
    return out;
  });

  $effect(() => {
    version;
    if (last > first) ensureRange?.(first, last - 1);
  });

  function onScroll() {
    if (viewport) scrollTop = viewport.scrollTop;
  }

  // Selecting a row from elsewhere (keyboard) scrolls it into view.
  export async function scrollTo(index) {
    await tick();
    if (!viewport) return;
    const top = index * ROW_H;
    const bottom = top + ROW_H;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = bottom - viewport.clientHeight;
    }
  }

  function rowClick(g) { onselect?.(g.id); }
  function rowDbl(g) { onopen?.(g.id); }

  /* Enter and Space act on the focused row. Arrow navigation is handled at
     workspace level, where the full row list lives; this keeps the row itself
     operable by keyboard rather than click-only. */
  function rowKey(e, g) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onselect?.(g.id);
      if (e.key === 'Enter') onopen?.(g.id);
    }
  }
</script>

<div class="wrap" bind:clientWidth={width} bind:clientHeight={height}>
  <div class="thead" style="width:{tableWidth}px">
    {#each cols as c (c.key)}
      <div class="cell hd" class:m={c.mono} style="width:{c.w}px">
        <!-- A column with a condensed or ambiguous header (Elo, Res, Mvs) is
             named in full for assistive technology, and the short label is
             hidden from it so the name is not read twice. -->
        <span aria-hidden={c.a11yKey ? 'true' : undefined}>{$t(c.labelKey)}</span>
        {#if c.a11yKey}<span class="vh">{$t(c.a11yKey)}</span>{/if}
      </div>
    {/each}
  </div>

  <div
    class="viewport"
    bind:this={viewport}
    onscroll={onScroll}
    role="grid"
    aria-rowcount={total}
    aria-label={$t('lib.allGames')}
    tabindex="-1"
  >
    <div class="spacer" style="height:{total * ROW_H}px; width:{tableWidth}px">
      <div class="rows" style="transform:translateY({first * ROW_H}px)">
        {#each slice as { i, g } (i)}
          {#if g}
          <div
            class="row"
            class:sel={g.id === selectedId}
            role="row"
            aria-rowindex={i + 1}
            aria-selected={g.id === selectedId}
            tabindex={g.id === selectedId ? 0 : -1}
            data-game-id={g.id}
            onclick={() => rowClick(g)}
            ondblclick={() => rowDbl(g)}
            onkeydown={(e) => rowKey(e, g)}
          >
            {#each cols as c (c.key)}
              <div class="cell" class:m={c.mono} role="gridcell" style="width:{c.w}px">{cellValue(g, c)}</div>
            {/each}
          </div>
          {:else}
          <div class="row" role="row" aria-rowindex={i + 1} aria-busy="true">
            {#each cols as c (c.key)}
              <div class="cell" role="gridcell" style="width:{c.w}px"></div>
            {/each}
          </div>
          {/if}
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .wrap {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    overflow: hidden;
  }

  .thead {
    flex: none;
    display: flex;
    height: 28px;
    background: var(--chrome);
    border-bottom: 1px solid var(--rule-strong);
  }

  .viewport {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* Columns always sum to the available width, so the table never scrolls
       sideways (§3.2.4.2). */
    overflow-x: hidden;
  }
  .spacer { position: relative; }
  .rows { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }

  .row {
    display: flex;
    height: 30px;
    border-bottom: 1px solid var(--rule);
    cursor: default;
    user-select: none;
  }
  .row:hover { background: var(--paper); }
  .row.sel { background: var(--chrome-2); }
  .row.sel .cell { font-weight: 600; color: var(--ink); }
  .row.sel .cell:first-child { box-shadow: inset 3px 0 0 var(--ink); }

  .cell {
    flex: none;
    display: flex;
    align-items: center;
    padding: 0 6px;
    font-size: 12px;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The table's outer edges — see EDGE_EXTRA in columns.js. Shared by header
     and rows, so labels stay over their values. */
  .cell:first-child { padding-left: 12px; }
  .cell:last-child { padding-right: 12px; }

  .cell.m {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
  }

  /* Headers are labels, not controls — no sorting (§3.2.4.2). */
  .hd {
    font-weight: 600;
    color: var(--muted);
    font-size: 12px;
  }

  .vh {
    position: absolute;
    width: 1px; height: 1px;
    margin: -1px; padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>

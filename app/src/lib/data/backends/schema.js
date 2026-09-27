/**
 * DDL for a fresh database — what `pwa.js` runs when it creates a new file.
 *
 * Ported from `samples/build_samples.py`'s `GAME_DB_DDL`/`CONFIG_DB_DDL`, which is the
 * schema's other implementation (Python, for building the desktop sample `.db` files).
 * Keep the two in step by hand — there's no single source both languages generate from.
 *
 * `GAME_DB_DDL` covers everything from `database-schema.md` §1–§4 and §7 the
 * application's repository layer (`data/games.js`) reads or writes, plus §6's
 * `positions` table (added 22 Sep 2026 — `data/games.js`'s `readPositionStats` has
 * had a real read path since 21 Sep, and the PWA's own Sample Games seed
 * (`backends/pwa.js`) needs somewhere to write the rows `game/buildPositions.js`
 * computes). §6 still says plainly a game database without the table is valid —
 * `createDatabase()`'s "create new, empty Library" path deliberately does not run
 * this DDL's `positions` statement's equivalent on the desktop side
 * (`samples/build_positions.py` is a separate, later pass there); a brand-new
 * empty database legitimately has no games to derive stats from yet.
 *
 * `CONFIG_DB_DDL` covers `preferences`, `ui_state`, `subscriptions`, plus `libraries`
 * and `engines` — the last two exist here only so `subscriptions.library_id`'s foreign
 * key resolves and so a query against either table (`identify()`'s `CONFIG_TABLES`
 * check, `explorerConnection`'s `readLibraries` call) finds a real, empty table rather
 * than failing. Deliberately NOT wired to real reads/writes from the PWA yet — see
 * `session.js`'s `configConnection` and `stores/settings.js`'s `loadLibraries`/
 * `loadEngines` guards. A `libraries.game_db_path`/filesystem-path row and an
 * `engines.binary_path`/UCI-binary row don't map onto this interim architecture's
 * single in-browser database; both need their own PWA-shaped design before either
 * table gets real content, not a mechanical copy of the desktop shape. It leaves out
 * `catalog_databases`/`catalog_engines` — nothing in `data/config.js` reads them; the
 * download catalogues are a static file today (`settings/databases.js`,
 * `settings/engines.js`), unrelated to this seam.
 */

/** The schema revision a fresh database is created at. Matches `identify.js`'s
 *  `SCHEMA_USER_VERSION` and `samples/build_samples.py`'s `SCHEMA_USER_VERSION`. */
export const SCHEMA_USER_VERSION = 10;

export const GAME_DB_DDL = `
CREATE TABLE games (
    id                 INTEGER PRIMARY KEY,
    pgn                TEXT NOT NULL,
    event              TEXT,
    site               TEXT,
    date               TEXT,
    round              TEXT,
    white              TEXT,
    black              TEXT,
    result             TEXT,
    white_elo          INTEGER,
    black_elo          INTEGER,
    eco                TEXT,
    time_control       TEXT,
    fen                TEXT,
    termination        TEXT,
    ply_count          INTEGER,
    tournament         TEXT,
    current_position   TEXT,
    variant            TEXT,
    rated              INTEGER,
    white_accuracy     REAL,
    black_accuracy     REAL,
    time_class         TEXT,
    created_at         TEXT,
    movetext           TEXT,
    -- database-schema.md §1, added 23 Sep for per-game source tracking (§2.3):
    -- provenance of an Online import. NULL for Paste/File.
    source_type        TEXT,
    source_identifier  TEXT
);

-- Derived data (database-schema.md §6) -- reconstructible from games, never a
-- source of truth. A fresh database is created WITHOUT rows in it; only the PWA's
-- Sample Games seed (backends/pwa.js, via game/buildPositions.js) populates it
-- today, mirroring what samples/build_positions.py does for the desktop .db
-- files. That PWA population is a STOPGAP until indexing has a UI trigger
-- (see game/buildPositions.js); the table itself stays. Column order matches section 6.1 exactly, pos+move primary key included.
CREATE TABLE positions (
    pos    TEXT    NOT NULL,
    move   TEXT    NOT NULL,
    games  INTEGER NOT NULL,
    white  INTEGER NOT NULL,
    draws  INTEGER NOT NULL,
    black  INTEGER NOT NULL,
    PRIMARY KEY (pos, move)
) WITHOUT ROWID;

-- Derived search text (database-schema.md §6a) -- white, black, event, date
-- and result, case- and diacritic-folded by library/fold.js's searchText().
-- Reconstructible from games; data/games.js's ensureGameSearch() creates and
-- backfills it for a database that lacks it, and insertGames() keeps it current.
CREATE TABLE game_search (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    text    TEXT NOT NULL
);

-- A row means the game is a favorite.
CREATE TABLE favorites (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE
);

-- A row means the game is in the Trash.
CREATE TABLE trash (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE tags (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE tag_games (
    tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    PRIMARY KEY (tag_id, game_id)
) WITHOUT ROWID;
CREATE INDEX tag_games_by_game ON tag_games (game_id);

CREATE TABLE collections (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    smart    INTEGER NOT NULL DEFAULT 0 CHECK (smart IN (0, 1)),
    criteria TEXT,
    CHECK (smart = 1 OR criteria IS NULL)
);

-- Membership of regular Collections only; a Smart Collection computes its own.
CREATE TABLE collection_games (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    game_id       INTEGER NOT NULL REFERENCES games(id)       ON DELETE CASCADE,
    PRIMARY KEY (collection_id, game_id)
) WITHOUT ROWID;
CREATE INDEX collection_games_by_game ON collection_games (game_id);

-- Which games arrived through which subscription. subscription_id is
-- config.db subscriptions.id; SQLite cannot enforce a key in another file.
CREATE TABLE subscription_games (
    subscription_id INTEGER NOT NULL,
    game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    PRIMARY KEY (subscription_id, game_id)
) WITHOUT ROWID;
CREATE INDEX subscription_games_by_game ON subscription_games (game_id);
`;

export const CONFIG_DB_DDL = `
CREATE TABLE libraries (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    game_db_path   TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    last_opened_at TEXT,
    enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version        TEXT
);

CREATE TABLE subscriptions (
    id                  INTEGER PRIMARY KEY,
    name                TEXT NOT NULL,
    source_type         TEXT NOT NULL,
    source_identifier   TEXT NOT NULL,
    library_id          INTEGER NOT NULL REFERENCES libraries(id),
    enabled             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL,
    last_checked_at     TEXT,
    last_status         TEXT NOT NULL DEFAULT 'not_checked',
    last_status_message TEXT,
    sync_interval       TEXT NOT NULL DEFAULT 'daily'
                        CHECK (sync_interval IN ('hourly', 'daily', 'weekly', 'manual')),
    last_synced_at      TEXT,
    last_viewed_at      TEXT
);

CREATE TABLE engines (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    version     TEXT,
    url         TEXT,
    binary_path TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    threads     INTEGER NOT NULL DEFAULT 1 CHECK (threads >= 1),
    hash_mb     INTEGER NOT NULL DEFAULT 256 CHECK (hash_mb >= 1)
);

-- What the user chose in Settings.
CREATE TABLE preferences (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL
);

-- Where the user left off. Not a setting.
CREATE TABLE ui_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL
);
`;

/**
 * `GAME_DB_DDL`/`CONFIG_DB_DDL` as a list of individual statements, no
 * trailing empties, comments and blank lines dropped.
 *
 * `pwa.js`'s `sqlite-wasm` `exec()` runs a whole multi-statement string in
 * one call, but `backends/tauri.js`'s `run()` goes over `@tauri-apps/
 * plugin-sql`'s `execute`, which (like sqlx's query preparation generally)
 * expects one statement per call — so creating a brand-new Library's game
 * database file on the Tauri side (`stores/settings.js`'s `createDatabase()`)
 * runs `GAME_DB_DDL` one statement at a time through this split rather than
 * as one string. A plain split on `;` is safe here because neither DDL
 * string contains a semicolon inside a string literal, a trigger body, or
 * anything else that would make a naive split wrong.
 */
export function splitSqlStatements(ddl) {
  return String(ddl ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

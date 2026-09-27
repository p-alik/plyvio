# Plyvio — Database Schema Reference (v012)

SQLite 3 · target schema

This document defines two kinds of SQLite database:

- A **game database** stores chess games (§1–§4); carries Library features such as Favorites, Tags and Collections (§7) and subscription tracking (§8); and may carry a derived table of position statistics (§6). It is any SQLite file conforming to that schema, of any name, whether created by Plyvio, supplied by another application, or populated independently.
- **`config.db`** stores Plyvio configuration: Libraries, subscriptions to online chess sources, and chess engines (§5).

A game database is independent of `config.db` and remains usable without it.

---

## Conventions

These apply throughout and are not repeated per field.

- **Naming.** All database fields use `snake_case`. PGN tag names keep their standard spelling when referring to the source format; the tag each field is lifted from is listed in §1.
- **Primary keys.** Every `id` column is an INTEGER primary key and an alias for SQLite's rowid, assigned on insert. It has no meaning outside its own database.
- **Booleans.** SQLite has no boolean type. Boolean fields are INTEGER with permitted values `1` and `0`.
- **Timestamps.** Timestamp fields hold an ISO 8601 UTC timestamp, for example `2026-08-31T14:23:17Z`.
- **PGN references.** Section references §8.x and §9.x, including those in §1's PGN tag column, refer to the PGN standard (§9). This document has no sections with those numbers.

---

## 1. The `games` table

One row per game.

| #   | Column             | Type    | PGN tag                   | Description                                                    |
| --- | ------------------ | ------- | ------------------------- | -------------------------------------------------------------- |
| 1   | `id`               | INTEGER | —                         | Primary key                                                    |
| 2   | `pgn`              | TEXT    | —                         | The game's original PGN text, byte for byte                    |
| 3   | `event`            | TEXT    | `Event` (§8.1.1.1)        | Name of the tournament or match event                          |
| 4   | `site`             | TEXT    | `Site` (§8.1.1.2)         | Location of the event                                          |
| 5   | `date`             | TEXT    | `Date` (§8.1.1.3)         | Starting date of the game                                      |
| 6   | `round`            | TEXT    | `Round` (§8.1.1.4)        | Playing round within the event                                 |
| 7   | `white`            | TEXT    | `White` (§8.1.1.5)        | Player of the white pieces                                     |
| 8   | `black`            | TEXT    | `Black` (§8.1.1.6)        | Player of the black pieces                                     |
| 9   | `result`           | TEXT    | `Result` (§8.1.1.7)       | Game result                                                    |
| 10  | `white_elo`        | INTEGER | `WhiteElo` (§9.1.2)       | White's rating                                                 |
| 11  | `black_elo`        | INTEGER | `BlackElo` (§9.1.2)       | Black's rating                                                 |
| 12  | `eco`              | TEXT    | `ECO` (§9.4.1)            | Opening code                                                   |
| 13  | `time_control`     | TEXT    | `TimeControl` (§9.6.1)    | Time control used for the game                                 |
| 14  | `fen`              | TEXT    | `FEN` (§9.7.2)            | Starting position, when not the standard initial position      |
| 15  | `termination`      | TEXT    | `Termination` (§9.8.1)    | How the game ended                                             |
| 16  | `ply_count`        | INTEGER | `PlyCount` (§9.9.3)       | Half-moves played                                              |
| 17  | `tournament`       | TEXT    | —                         | Tournament the game belongs to                                 |
| 18  | `current_position` | TEXT    | —                         | Position after the final move                                  |
| 19  | `variant`          | TEXT    | —                         | Variant of chess played                                        |
| 20  | `rated`            | INTEGER | —                         | Whether the game affected ratings                              |
| 21  | `white_accuracy`   | REAL    | —                         | White's post-game accuracy score                               |
| 22  | `black_accuracy`   | REAL    | —                         | Black's post-game accuracy score                               |
| 23  | `time_class`       | TEXT    | —                         | Speed category                                                 |
| 24  | `created_at`       | TEXT    | —                         | When this game row was added to the database                   |
| 25  | `movetext`         | TEXT    | —                         | Application-owned movetext containing user edits and annotations |
| 26  | `source_type`      | TEXT    | —                         | Kind of online source this game was imported from                |
| 27  | `source_identifier` | TEXT   | —                         | Identifier of the source within that source type                 |

**Only `id` and `pgn` are required.** Every other field may be NULL.

A required field is a rejection rule: if a field is `NOT NULL` and an import cannot supply it, the insert fails and the whole game is not stored. The schema therefore does not require metadata that a legitimate PGN may not contain.

---

## 2. Field definitions

### 2.1 Structural fields

#### `id` · INTEGER

Identifies a row, not a game. It carries no meaning derived from the game and is not stable across a re-import.

#### `pgn` · TEXT

The game's PGN text exactly as received, byte for byte. It holds both the tag pair section and the movetext, including comments, annotations, variations, and tags this schema does not promote to fields.

`pgn` is immutable after import and is the authoritative record of the original game. Every other field is either a value lifted out of this text, so it can be queried and displayed without reparsing, or a value attached alongside it. Where a lifted field and `pgn` disagree, `pgn` is authoritative.

Application edits are never written back to `pgn`; they are stored in `movetext` (§3).

### 2.2 PGN tag fields

Fields 3–16 are defined by the PGN standard and are not redefined here. Each is stored as written, including the standard's `?` placeholders, except where the table below states otherwise.

| Field                    | Rule                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site`                   | Online sources commonly write a URL or site name in place of the standard's `City, Region COUNTRY` form. Both are accepted.                                                             |
| `date`                   | The standard's `YYYY.MM.DD` form, with `?` for unknown digits (`1993.??.??`). A value is always ten characters, most significant first, so plain string comparison orders chronologically; `?` sorts after digits. |
| `round`                  | Text, not a number. The standard permits multipart ordinals and single-character placeholders.                                                                                          |
| `white`, `black`         | Online sources may use account handles rather than the standard's `Lastname, Firstname` form. Both are accepted.                                                                        |
| `result`                 | The standard's notation. The application may render `1/2-1/2` as `½-½`.                                                                                                                 |
| `white_elo`, `black_elo` | Cast to INTEGER. The standard's `-` for an unrated player becomes NULL, so an unrated player and an unrecorded rating are treated alike.                                                 |
| `eco`                    | The classification code only, not an opening name.                                                                                                                                      |
| `time_control`           | Text, never numeric. Some of the standard's forms contain more than one numeric component.                                                                                              |
| `fen`                    | The position from which the game started. NULL means the standard initial position (§2.4).                                                                                              |
| `ply_count`              | Cast to INTEGER. Stored in plies, as the standard defines it; the application displays full moves.                                                                                      |

### 2.3 Application fields

Fields 17–24, 26–27 are not PGN standard fields. (Field 25, `movetext`, is also
application-owned but documented separately, §3, for its own precedence rules.)

#### `tournament` · TEXT

The tournament a game belongs to, where the source identifies one. Free text.

The standard's nearest equivalents are `Section`, `Stage`, and `EventDate`, none of which this schema stores.

#### `current_position` · TEXT

The position after the final move, as a complete FEN.

#### `variant` · TEXT

The variant of chess played.

| Value       | Also known as            |
| ----------- | ------------------------ |
| `standard`  | —                        |
| `freestyle` | Fischer Random, Chess960 |

NULL means `standard`, so a source that records no variant is treated as an ordinary game and only `freestyle` needs to be written. The field exists so a freestyle game is not silently treated as standard; its starting position, one of 960, is carried by `fen`.

The PGN standard defines no tag for the variant played. `Variant` is an extension tag commonly written by sources, and this field represents that concept. It is deliberately named `variant`, not `variation`, which has an unrelated PGN meaning (PGN §9.3.2).

#### `rated` · INTEGER

Whether the game counted toward the players' ratings. Boolean.

#### `white_accuracy`, `black_accuracy` · REAL

Post-game accuracy scores, where a source supplies them. They are the product of engine analysis performed elsewhere, not by this application, and are NULL for a game the source never analyzed.

#### `time_class` · TEXT

Speed category. The application may classify a game as one of:

| Value       | Game length            |
| ----------- | ---------------------- |
| `bullet`    | Under 3 minutes        |
| `blitz`     | 3 to under 10 minutes  |
| `rapid`     | 10 to under 25 minutes |
| `classical` | 25 minutes or longer   |
| `daily`     | Over 24 hours per move |

This is a classification of `time_control`, not an independent fact. `daily` is measured per move; the other four categories measure the game as a whole.

#### `created_at` · TEXT

When this game row was added to this particular game database. Timestamp.

`created_at` and `date` answer different questions and must not be substituted for one another: `date` is when the game was played; `created_at` is when the row was added.

The value belongs to the row, not to the game or the file:

- The same game may have different `created_at` values in different game databases.
- Copying a game database file does not change it.
- It does not attempt to reconstruct the provenance or age of an existing record.

NULL is valid when the database was populated outside the application's import process. Opening a pre-populated game database does not constitute importing its games, so its rows may have no `created_at`.

#### `source_type` · TEXT

Which kind of online source produced this row, using the exact vocabulary `subscriptions.source_type` already defines (§5.2) — for example `chess_com_player`. NULL for a game added by Paste or File; always populated by an Online import, whether or not a Subscription exists for that account. Every game in a game database imported the same way from the same account carries the same value.

#### `source_identifier` · TEXT

The particular source within `source_type`, meaning what `subscriptions.source_identifier` means for the same `source_type` (§5.2) — for example a Chess.com username. NULL exactly when `source_type` is NULL.

These two columns record provenance per game, independent of whether a Subscription produced the row: a Subscription-driven import and a plain manual Online import of the same account are indistinguishable by source, since both tag by account identity rather than by which mechanism fetched the game. They imply no de-duplication, which is a separate, later feature and not specified here.

### 2.4 Fields not stored

A field is not stored when another field's absence already says it.

`SetUp` (PGN §9.7.1) is a 0/1 flag whose purpose is to say whether `FEN` is meaningful:

| State                                | `fen`        | `SetUp`        |
| ------------------------------------ | ------------ | -------------- |
| Started from the usual initial array | NULL         | `0`, or absent |
| Started from a set-up position       | the position | `1`            |

Nullable `fen` alone distinguishes the two states. The flag is needed in PGN because a tag section has no NULL; the database would otherwise maintain two fields that must agree.

---

## 3. `movetext`

### 3.1 Purpose and precedence

`movetext` is an application-owned, mutable copy of the game's movetext. It preserves the user's edits and annotations without modifying `pgn`.

It contains the movetext only, never the tag pair section, so it does not duplicate the game's metadata.

**Precedence.** When `movetext` is non-NULL, it is the application's source of movetext. When it is NULL, no application-owned movetext has been persisted and the application uses the movetext contained in `pgn`:

```text
if games.movetext IS NOT NULL
    use games.movetext
else
    use movetext from games.pgn
```

A game with no edits or annotations therefore relies entirely on `pgn`, and existing games need no migration.

**Creation.** Import does not populate `movetext`, even when the source PGN contains annotations; the original movetext remains in `pgn`. The field is created when the application first needs to persist an edited or annotated representation.

**Complete replacement.** Every write stores the complete resulting movetext. The application does not store a patch, edit log, or list of changes, and does not patch `pgn`. Loading a game therefore parses one complete movetext document.

For example, if `pgn` contains:

```text
1. e4 e5 2. Nf3 Nc6 3. Bb5 a6
```

and the user adds a comment, `movetext` becomes:

```text
1. e4 e5 2. Nf3 Nc6 {A common developing move.} 3. Bb5 a6
```

and `pgn` is unchanged.

### 3.2 Syntax

`movetext` uses ordinary PGN movetext notation and does not redefine it. It is intended to be parsed by PGN-compatible software such as chessops.

| Element                            | Notation     | Example                              |
| ---------------------------------- | ------------ | ------------------------------------ |
| Move                               | SAN          | `2. Nf3`                             |
| Comment                            | `{…}`        | `2. Nf3 {Developing the knight.}`    |
| Numeric Annotation Glyph (NAG)     | `$n`         | `2. Nf3 $1`                          |
| Recursive Annotation Variation (RAV) | `(…)`, nestable | `2. Nf3 (2. f4 exf4 (2... d5)) 2... Nc6` |

NAGs, comments, and variations are preserved on every read and write. They need no database columns of their own, and no proprietary move-tree representation is required. Variations are part of the move tree, not independent games; the user may add, modify, or remove them without modifying `pgn`.

**Comment commands.** Structured data is written inside comments using the bracketed command convention common to chess annotation, `[%command value]`. A PGN viewer that does not recognize a command still sees an ordinary comment. Each command is either adopted from common usage or defined by an extension cited in §9; this specification does not redefine them.

### 3.3 Comment commands

| Command     | Records                                                                     | Placement                     | Example                                    |
| ----------- | --------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------ |
| `%engine`   | Engine and analysis settings for the evaluations and best moves that follow | Comment before the first move | `[%engine name="Stockfish 18.1" depth=24]` |
| `%eval`     | Engine evaluation of the position the move led to                           | After the move                | `[%eval +0.20,24]`, `[%eval #3]`           |
| `%bestmove` | Engine's move in the position the move was played from, in UCI              | After the move                | `[%bestmove e2e4]`                         |
| `%clk`      | Clock time, where available                                                 | After the move                | `[%clk 0:09:57]`                           |
| `%emt`      | Elapsed move time, where available                                          | After the move                | `[%emt 0:00:03]`                           |
| `%csl`      | Colored square highlights, where supported                                  | After the move                | `[%csl Gc4,Rf7]`                           |
| `%cal`      | Colored arrows, where supported                                             | After the move                | `[%cal Gc4c7,Rf7f8]`                       |

"After the move" means in a comment that follows the move and precedes the next move. It describes where the command is written, not which position it is about: `%eval` and `%bestmove` sit in the same place and describe opposite sides of the move it follows (Best move, below).

`%eval`, `%clk`, `%emt`, `%csl`, and `%cal` are adopted from common usage and are not defined by this specification. None of these values is a searchable database field.

#### Engine context

`%engine` follows the PGN Extension: Evaluation Context v1.0 (§9), which defines its syntax, attributes, and parsing rules. They are not restated here. Its attributes are `name` (engine name and version), `timestamp` (when the analysis was performed, not when the game was played), `depth`, `hash`, `threads`, `multipv`, and `options`; all are optional.

```text
{[%engine name="Stockfish 18.1" timestamp="2026-09-08T13:49:00Z" depth=24 hash=4096 threads=8 multipv=1]}
1. e4 {[%eval +0.20,24]} e5 {[%eval +0.15,24]}
```

A game's `movetext` carries one engine context, in the comment before the first move. Plyvio writes `timestamp` in UTC with the `Z` designator (Conventions).

Because every write replaces the whole of `movetext` (§3.1), the extension's rule that unrecognized attributes are preserved applies to every write.

#### Best move

`%bestmove` follows the PGN Extension: Best Move v1.1 (§9). It applies from the first move onward.

The value is the engine's best move **in the position the move was played from** — the move the engine would have chosen instead, and so a move for the side that played the move the comment follows. A `%bestmove` and a `%eval` in the same comment therefore describe two different positions: the evaluation is of the position the move led to, the recommendation is for the position it was played from. Neither is the other's principal variation.

The application converts it to display notation and interprets castling according to the game's `variant` (§2.3). A one-move variation must not be manufactured to represent it.

The persisted engine result assumes a single principal variation, so multiple PVs are not represented. A later revision may extend `movetext` if Plyvio persists multiple engine variations.

### 3.4 Example

A `movetext` value after several edits:

```text
{[%engine name="Stockfish 18.1" timestamp="2026-09-08T13:49:00Z" depth=24 hash=4096 threads=8 multipv=1]}
1. e4 {Good choice. [%eval +0.20,24] [%bestmove e2e4]} e5
2. Nf3 $1 (2. f4 exf4) 2... Nc6
3. Bb5 {[%csl Gc4] [%cal Gc4c7]}
```

The entire text is the value of `games.movetext`.

---

## 4. Data mapping

How a source's data becomes the fields defined in §1–§3. This is an import concern, deliberately separate from the schema: a field means the same thing regardless of what produced it.

Every import:

- stores the source PGN verbatim in `pgn`;
- lifts each PGN tag listed in §1 into its field, applying the rules in §2.2;
- sets `created_at` to the time the application adds the game;
- leaves `movetext` NULL (§3.1).

Tags with no corresponding field remain in `pgn` only. Application fields with no source value remain NULL unless they can be derived safely.

### 4.1 Chess.com

Games can be imported from Chess.com directly or from PGN files downloaded from the site. The direct route supplies JSON containing the complete PGN plus additional properties; the file route supplies the PGN alone.

#### From the JSON

| Chess.com JSON property | →   | `games` field      | Normalization                                             |
| ----------------------- | --- | ------------------ | --------------------------------------------------------- |
| `rated`                 | →   | `rated`            | JSON boolean → `1` / `0`                                  |
| `time_class`            | →   | `time_class`       | Map the source vocabulary onto the values in §2.3         |
| `rules`                 | →   | `variant`          | Map the source vocabulary onto the values in §2.3         |
| `accuracies.white`      | →   | `white_accuracy`   | Conditional; absent when the game was not analyzed        |
| `accuracies.black`      | →   | `black_accuracy`   | Conditional; absent when the game was not analyzed        |
| `tournament`            | →   | `tournament`       | Conditional                                               |
| `initial_setup`         | →   | `fen`              | Starting position; standard initial position becomes NULL |
| `fen`                   | →   | `current_position` | Final position                                            |

Mapping either position property by name would store the wrong position. Chess.com's `fen` is the position after the last move, so it maps to `current_position`. Its `initial_setup` is the starting position, so it maps to `fen`; the importer compares it with the standard initial position and stores NULL when they match.

#### From the PGN

Chess.com PGN also carries two extension tags:

| Chess.com PGN tag | →   | `games` field      | Normalization  |
| ----------------- | --- | ------------------ | -------------- |
| `CurrentPosition` | →   | `current_position` | Final position |
| `Tournament`      | →   | `tournament`       | Conditional    |

#### Provenance

The direct route also sets `source_type` (always `chess_com_player`) and `source_identifier` (the Chess.com username of the account being imported) on every row, per §2.3. Neither comes from a JSON property or a PGN tag; both are properties of the import itself, not of the game. A Chess.com PGN file downloaded and imported through §4.3 (Plain PGN files) is a File import, not the direct route, and leaves both NULL like any other File import.

### 4.2 Lichess

Source mapping is to be defined when the importer is implemented.

The source's speed vocabulary requires attention because it may include `correspondence`, which is not one of the `time_class` values.

### 4.3 Plain PGN files

A `.pgn` file from any program can be imported. Only fields represented by PGN tags can be populated, so a file carrying only the Seven Tag Roster is still a valid import.

---

## 5. Configuration database

`config.db` is a separate SQLite database for Plyvio configuration. It contains no games. Its three concepts are:

- **Libraries** — game collections the user has added to Plyvio.
- **Subscriptions** — online sources the user wants Plyvio to monitor.
- **Engines** — chess engines configured for use by the application.

The relationship between `config.db` and game databases is one-way:

```text
config.db
    │
    ├── libraries
    │      └── game_db_path ──────> game database
    │
    ├── subscriptions
    │      └── library_id ────────> libraries
    │
    └── engines
           └── binary_path ───────> UCI engine
```

- `config.db` stores references to game databases; it does not embed or attach them.
- A game database contains no reference to `config.db` or to any subscription, and remains valid and usable without it.
- `config.db` may reference a game database that is currently unavailable, moved, disconnected, or deleted. That affects Plyvio's ability to open the Library or import into it, including for a subscription whose destination cannot be reached, but does not alter the game database schema.

### 5.1 `libraries` table

**Library** is the user-facing term for a collection of games. Each Library is represented by a game database file. A user might have:

```text
My Games
AwesomeAtti
Master Games
Opening Studies
```

A Library need not have been created or populated by Plyvio. Adding a pre-existing game database as a Library neither imports nor modifies its games.

| #   | Column           | Type    | Description                               |
| --- | ---------------- | ------- | ----------------------------------------- |
| 1   | `id`             | INTEGER | Primary key                               |
| 2   | `name`           | TEXT    | User-facing Library name                  |
| 3   | `game_db_path`   | TEXT    | Path to the game database file            |
| 4   | `created_at`     | TEXT    | When the Library was added to Plyvio    |
| 5   | `last_opened_at` | TEXT    | When the Library was most recently opened |

Suggested DDL:

```sql
CREATE TABLE libraries (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    game_db_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_opened_at TEXT
);
```

#### `name`

Presentation metadata, independent of the filename, so a database file can be renamed without changing the Library's displayed name.

#### `game_db_path`

The filesystem path to the game database implementing the Library. It is not a foreign key, because game databases are independent SQLite files. The file must conform to the game database schema when the application uses it, and the path must be updated if the file is moved. The column carries no uniqueness constraint.

#### `created_at`

When the Library was added to Plyvio. Timestamp. It is distinct from `games.created_at`: a Library added today may contain games imported years earlier.

#### `last_opened_at`

When Plyvio most recently opened the Library. Timestamp. NULL means it has not yet been opened.

### 5.2 `subscriptions` table

A subscription is the user's request for Plyvio to monitor an online source and import newly discovered games. The term does not imply payment, credentials, or an account connection; a subscription may simply identify a publicly accessible source such as a Chess.com player.

```text
Subscribe to AwesomeAtti on Chess.com and add new games to
the AwesomeAtti Library.
```

| #   | Column                | Type    | Description                                                      |
| --- | --------------------- | ------- | ---------------------------------------------------------------- |
| 1   | `id`                  | INTEGER | Primary key                                                      |
| 2   | `name`                | TEXT    | User-facing name of the subscription                             |
| 3   | `source_type`         | TEXT    | Type of online source                                            |
| 4   | `source_identifier`   | TEXT    | Identifier of the source within that source type                 |
| 5   | `library_id`          | INTEGER | Destination Library; references `libraries.id`                   |
| 6   | `enabled`             | INTEGER | Whether monitoring is enabled                                    |
| 7   | `created_at`          | TEXT    | When the subscription was created                                |
| 8   | `last_checked_at`     | TEXT    | When the application most recently attempted to check the source |
| 9   | `last_status`         | TEXT    | Last known status of the subscription                            |
| 10  | `last_status_message` | TEXT    | Optional human-readable detail about the last status             |

Suggested DDL:

```sql
CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_identifier TEXT NOT NULL,
    library_id INTEGER NOT NULL REFERENCES libraries(id),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_checked_at TEXT,
    last_status TEXT NOT NULL DEFAULT 'not_checked',
    last_status_message TEXT
);
```

#### `name`

A display name, so the source's technical identifier need not be suitable for presentation. For a Chess.com player it might simply be `AwesomeAtti`.

#### `source_type`

The kind of source being monitored, for example `chess_com_player` or `lichess_player`. The vocabulary is extensible as source types are added.

#### `source_identifier`

The particular source within `source_type`, for example `AwesomeAtti`; its meaning is determined by `source_type`. It implies no credentials or API keys. If a future source requires credentials, they are modeled separately from the subscription.

#### `library_id`

The Library into which newly discovered games are imported. The game database is reached through that Library's `game_db_path`.

Each subscription has exactly one destination, and several subscriptions may share one. The destination is a property of the subscription, not of the source:

```text
Subscription: AwesomeAtti   source: Chess.com player   destination: My Games
Subscription: Hikaru        source: Chess.com player   destination: My Games
Subscription: Chessbrah     source: Chess.com player   destination: Online Games
```

Whether the same source may be subscribed more than once, with different destinations, is an application rule rather than a schema requirement.

#### `enabled`

Whether the subscription is currently monitored. Boolean. Disabling a subscription does not delete its history or its last known status.

#### `created_at`

When the subscription was created. Timestamp.

#### `last_checked_at`

The most recent attempt to check the source, whether or not it succeeded. Timestamp. NULL means the subscription has never been checked.

#### `last_status`

The last known outcome of checking the subscription:

| Value         | Meaning                                  |
| ------------- | ---------------------------------------- |
| `success`     | Source was checked successfully          |
| `error`       | The check failed                         |
| `not_found`   | The configured source could not be found |
| `not_checked` | No check has yet been performed          |

A new subscription has `last_status = 'not_checked'` and `last_checked_at = NULL`.

`success` means the application obtained a valid response from the source, not necessarily that new games were found. The number of games found or imported belongs to an individual check, not to the subscription's persistent status.

#### `last_status_message`

Optional human-readable detail, for example `3 new games imported`, `Source temporarily unavailable`, or `Player not found`. It is informational: application logic uses `last_status` and does not parse this text. It may be NULL, particularly after a successful check.

#### Status while offline

Subscription status is persistent configuration data, not transient application state. When Plyvio starts without network access it displays the last recorded name, source, destination Library, check time, status, and message, and does not replace the status merely because it is offline:

```text
AwesomeAtti
Chess.com · My Games
Last checked: August 31, 2026 10:42 AM
Status: Successfully checked — 3 new games imported
```

The UI may additionally indicate current connectivity or a pending check; that transient state is distinct from `last_status`.

#### Games a subscription imports

A subscription does not own the games it discovers. They become ordinary rows in the destination game database and remain there if the subscription is deleted. If the same game arrives by another route, normal deduplication rules decide whether another row is created; this schema does not define game identity.

### 5.3 `engines` table

An engine record identifies an executable that Plyvio can invoke using the UCI protocol.

| #   | Column        | Type    | Description                           |
| --- | ------------- | ------- | ------------------------------------- |
| 1   | `id`          | INTEGER | Primary key                           |
| 2   | `name`        | TEXT    | User-facing engine name               |
| 3   | `version`     | TEXT    | Engine version                        |
| 4   | `url`         | TEXT    | URL for information about the engine  |
| 5   | `binary_path` | TEXT    | Path to the UCI engine executable     |
| 6   | `created_at`  | TEXT    | When the engine was added to Plyvio |

Suggested DDL:

```sql
CREATE TABLE engines (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT,
    url TEXT,
    binary_path TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

#### `name`

For example, `Stockfish`.

#### `version`

For example, `18.1`. No particular format is assumed. NULL if the version is unknown or cannot be determined.

#### `url`

Informational only; not used to locate or execute the engine.

#### `binary_path`

For example, `/Applications/Stockfish/stockfish`. Named `binary_path` rather than `path` so its purpose is unambiguous. The application should verify, when the engine is used, that the executable exists and supports the UCI protocol.

#### `created_at`

When the engine was added to Plyvio. Timestamp.

#### Engines and persisted evaluations

The engine record describes an engine that is available. The engine and settings that produced a game's persisted evaluations and best moves are recorded in that game's engine context (§3.3). Different games can therefore be analyzed with different engines, versions, or settings without changing the engine's configuration record.

The `engines` table does not store analysis settings such as search depth, threads, or hash size. If Plyvio later supports reusable user-defined engine profiles, they may be modeled separately from the engine itself.

---

## 6. The `positions` table

A game database **may** carry a `positions` table: aggregated statistics describing what has been played from each position across the games it holds, so that a position can be looked up without reading any game's movetext.

**The table is derived data.** Every row in it is reconstructible from the games. It is never a source of truth, it is never edited to correct a discrepancy, and a game database without one is valid — it simply cannot answer position queries, and any feature that needs them is unavailable until the table is present.

A game database supplied by another application will not have one.

---

### 6.1 Columns

One row per position per distinct move played from it.

| #   | Column  | Type    | Description                                     |
| --- | ------- | ------- | ----------------------------------------------- |
| 1   | `pos`   | TEXT    | Position key (§6.2)                              |
| 2   | `move`  | TEXT    | The move played from the position, in SAN       |
| 3   | `games` | INTEGER | Games that played this move from this position  |
| 4   | `white` | INTEGER | …of which White won                              |
| 5   | `draws` | INTEGER | …drawn                                            |
| 6   | `black` | INTEGER | …Black won                                        |

```sql
CREATE TABLE positions (
    pos    TEXT    NOT NULL,
    move   TEXT    NOT NULL,
    games  INTEGER NOT NULL,
    white  INTEGER NOT NULL,
    draws  INTEGER NOT NULL,
    black  INTEGER NOT NULL,
    PRIMARY KEY (pos, move)
) WITHOUT ROWID;
```

**The primary key's column order is load-bearing.** `WITHOUT ROWID` stores rows in primary-key order, so every row for one position is physically contiguous and already sorted by move. Reading a position is one B-tree seek followed by a short sequential run, requiring no aggregation and no temporary sort.

**The table holds no game reference.** It records totals, not games, so nothing in it identifies which games produced a figure and no statistic in it can be filtered by any property of a game.

---

### 6.2 Position key

The position key identifies a position for lookup. It is the **first four fields of the position's FEN** — piece placement, side to move, castling availability, en passant target square — joined by single spaces, and nothing else.

**The halfmove clock and fullmove number are excluded.** They describe a game's progress, not the position. Including either would prevent two games that reach the same position by different move orders from being recognised as the same position, which is the table's purpose.

**The en passant field records a square only when an en passant capture is actually legal.** Strict FEN writes the target square whenever a pawn has just advanced two squares, whether or not any pawn can capture it. Under that rule two otherwise identical positions key differently and a genuine transposition fails to merge. This is a deliberate departure from strict FEN and is stated here so that it is not later corrected back.

**`pos` is therefore not comparable with `current_position` (§2).** That field holds a complete FEN, including the two fields the key excludes. The two never match, and a query joining them returns nothing rather than failing.

---

### 6.3 What the counters mean

`games` counts the games that played `move` from `pos`. `white`, `draws` and `black` count those same games by result.

**A game with no recorded result counts in `games` alone.** A game whose `result` is `*` was still played, so it counts toward how often a move was chosen, and it contributes to no side's score. It follows that:

- unfinished games are `games − (white + draws + black)`; and
- any statistic reporting the White / Draw / Black split takes its denominator from `white + draws + black`, not from `games`.

**A game contributes at most once to any position.** A game that reaches the same position more than once — by repetition — counts once toward that position, so the totals across all moves from a position never exceed the number of games that reached it.

**Absence is not evidence.** A position with no rows means the table holds nothing for it. This does not establish that no game reached the position: a table need not cover every position in every game it was built from. A reader must not present an empty result as a statement about the games.

---

### 6a. The `game_search` table

A game database **may** carry a `game_search` table: one row per game, holding the text the Library's search matches against (§3.2.4.1 of the product specification), already folded so that it can be matched without reading and folding every game at query time.

**The table is derived data**, in the same sense as `positions` (§6). Every row is reconstructible from `games`, it is never a source of truth, and a game database without one is valid. The application creates and fills it itself when it opens a game database that lacks it, or lacks rows for some games. Doing so writes only to `game_search`, and never to `games`, so opening a Library still neither imports nor modifies its games (§5.1).

| #   | Column    | Type    | Description                                                   |
| --- | --------- | ------- | ------------------------------------------------------------- |
| 1   | `game_id` | INTEGER | The game (§1); the row is removed with it                      |
| 2   | `text`    | TEXT    | `white`, `black`, `event`, `date`, `result`, folded and joined  |

```sql
CREATE TABLE game_search (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    text    TEXT NOT NULL
);
```

**Folding** is Unicode NFD decomposition, removal of combining marks (U+0300–U+036F), then lower-casing, so `Polgár` is stored as `polgar`. The five fields are joined by U+001F (unit separator), which no field contains, so a search term never matches across two fields. A NULL field folds to the empty string.

**Folding happens in the application, not in SQL.** SQLite's `LIKE` folds ASCII case only, and not every host the application runs on can register a custom SQL function. The same folding is applied to the search term, and the term is matched with `LIKE` against `text`.

---

## 7. Library features

A game database carries tables for per-Library organization: Favorites, Trash, Tags, and Collections. Each refers to a game by `games.id` (§1) and its row is removed when that game is removed. None of them adds a column to `games` — favoriting, trashing, tagging, and collecting a game are additive relations, not properties of the game row.

Tags and Collections are scoped to the game database that holds them: a Tag or Collection created in one Library does not appear in another.

A game database supplied by another application, or populated independently, may not have these tables; the features they support are then unavailable until they are added.

### 7.1 `favorites` and `trash` tables

Favorites and Trash are **presence tables**: a row means the game is a favorite, or, respectively, in the Trash. Neither is a boolean column on `games`.

```sql
CREATE TABLE favorites (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE trash (
    game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE
);
```

Neither table carries a timestamp. No specified view sorts or filters by when a game was favorited or trashed; one can be added when a view needs it.

### 7.2 `tags` and `tag_games` tables

A Tag is a user-defined label; a game may carry several.

| #   | Column | Type    | Description |
| --- | ------ | ------- | ------------ |
| 1   | `id`   | INTEGER | Primary key |
| 2   | `name` | TEXT    | Tag name    |

```sql
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
```

`tag_games` is the many-to-many membership table between `tags` and `games`. Its primary key leads with `tag_id`, so — under the same `WITHOUT ROWID` clustering rule as `positions` (§6.1) — rows for one tag are physically contiguous, matching the primary access path: the Sidebar lists a Tag and filters to its games. `tag_games_by_game` is the reverse index, for "which tags does this game carry."

`tags.name` is unique ignoring case. Applying a tag creates one "when nothing matches exactly" (product spec §3.2.4.5); without a case-insensitive uniqueness rule, `Blunder` and `blunder` would become two separate Sidebar rows.

### 7.3 `collections` and `collection_games` tables

A Collection is a user-named, static group of games; a Smart Collection is the same concept computed from a saved search rather than explicit membership.

| #   | Column     | Type    | Description |
| --- | ---------- | ------- | ------------ |
| 1   | `id`       | INTEGER | Primary key |
| 2   | `name`     | TEXT    | Collection name |
| 3   | `smart`    | INTEGER | Whether this is a Smart Collection |
| 4   | `criteria` | TEXT    | Smart Collection's saved search; format unspecified (product spec §3.2.3.4) |

```sql
CREATE TABLE collections (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    smart    INTEGER NOT NULL DEFAULT 0 CHECK (smart IN (0, 1)),
    criteria TEXT,
    CHECK (smart = 1 OR criteria IS NULL)
);

-- Membership of regular Collections only. A Smart Collection computes its own.
CREATE TABLE collection_games (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    game_id       INTEGER NOT NULL REFERENCES games(id)       ON DELETE CASCADE,
    PRIMARY KEY (collection_id, game_id)
) WITHOUT ROWID;
CREATE INDEX collection_games_by_game ON collection_games (game_id);
```

`collection_games` records membership for a regular Collection only; a Smart Collection has no rows here because its membership is computed from `criteria` at query time, not stored.

A game may belong to more than one Collection: product spec §3.2.4.5 lets a single import place a game into several Collections at once.

`collections.name` is unique ignoring case, for the same reason as `tags.name` (§7.2).

---

## 8. Subscription tracking

`subscription_games` records which games in this game database arrived through which `config.db` subscription (§5.2), so the Sidebar can filter a Library's games by subscription and show a count.

| #   | Column            | Type    | Description                     |
| --- | ----------------- | ------- | -------------------------------- |
| 1   | `subscription_id` | INTEGER | `config.db` `subscriptions.id`  |
| 2   | `game_id`         | INTEGER | References `games.id`            |

```sql
CREATE TABLE subscription_games (
    subscription_id INTEGER NOT NULL,
    game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    PRIMARY KEY (subscription_id, game_id)
) WITHOUT ROWID;
CREATE INDEX subscription_games_by_game ON subscription_games (game_id);
```

**`subscription_id` carries no `REFERENCES` clause.** SQLite cannot enforce a foreign key into another database file, and `subscription_id` points at `config.db`'s `subscriptions` table, not at anything in this file. `config.db` is expected to reside beside the game database it references; the two travel together, but this table does not depend on that arrangement to remain internally valid.

**This table is a deliberate exception to the one-way relationship described in §5.** §5 states that a game database contains no reference to `config.db` or to any subscription, and remains valid and usable without it. `subscription_games` is such a reference: without `config.db` present, its `subscription_id` values mean nothing. The games themselves are unaffected — they remain fully usable rows in `games` regardless of `config.db`'s presence — and this table simply cannot be resolved to a subscription's name or source until `config.db` is available again.

**The relationship is many-to-many.** A game can arrive through more than one subscription — for example, a game between two subscribed players — so a game may have more than one row here.

**No `imported_at` column.** It would duplicate `games.created_at`, which already records when the row was added to this database. The count of games a subscription has newly found is the number of rows in this table, for that subscription, whose `games.created_at` is later than that subscription's `subscriptions.last_viewed_at`.

**Deleting a subscription leaves its rows.** Per §5.2, deleting a subscription does not delete the games it found; the rows here simply point at a `subscription_id` that no longer resolves, and may be cleaned up or left as an application choice.

---

## 9. Sources

- PGN standard:
  https://www.saremba.de/chessgml/standards/pgn/pgn-complete.htm
  — §8.1.1 (Seven Tag Roster), §9 (Supplemental tag names).

- PGN Extension: Evaluation Context, v1.0 (2026-09-11):
  `pgn-extension-evaluation-context.md`
  — The `[%engine]` comment command (§3.3).

- PGN Extension: Best Move, v1.1 (2026-09-12):
  `pgn-extension-bestmove.md`
  — The `[%bestmove]` comment command (§3.3).

- SQLite documentation:
  https://sqlite.org/docs.html
  — Data types, rowids, and foreign keys.

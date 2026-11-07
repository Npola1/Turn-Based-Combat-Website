# The Final Turn-Based Battle

## Start the game

Use Node.js 22.13 or later. From this directory run:

```sh
npm ci
npm start
```

Open **http://localhost:3000**. Run `npm ci` first. No separate database server is needed for local development. Opening `index.html` directly, or serving it with a static Live Server, cannot access SQL saves.

## Save flow

After pressing **Yes!** on the opening warning, choose a saved slot or **New Battle**. This picker appears on each fresh page visit or refresh. Loading restores the saved player-turn boundary and bypasses party selection and the opening sequence. Loading is unavailable for the rest of that page visit, including after returning to party selection with Shift.

There are six slots per browser identity:

- **1–5:** Manual saves. Press Save at a ready player turn, choose a slot, and confirm if overwriting it.
- **6:** Opening autosave. Written after the introductory and pre-fight dialogue finishes and the first controllable player turn is ready. Another battle replaces this slot after its own opening sequence. Players cannot manually write into slot 6.

Saving is disabled during dialogue, enemy turns, actions, targeting/confirmation menus, follow-ups, and combat animations. It becomes available at the next prepared player character's turn, after turn-start effects finish. Backing out of a command without acting allows saving again. Wait for the save confirmation before closing the page.

There are **no checkpoint autosaves between turns**. Combat history is written separately, so recording decisions never advances a saved checkpoint. Overwriting a slot preserves battle history. Loading an older save starts a history branch linked to its source battle and decision sequence; it leaves the original battle's decisions intact.

Snapshots preserve party and enemy data, HP/energy, statuses, cooldowns, used turns, actor order, inventory quantities, battle/story flags, and turn counters. They contain data only; timers, animation callbacks, DOM elements, and media players are recreated rather than serialized. Saves represent a stable turn boundary, not the middle of an animation. History includes actual before/after combat data, choices, affected targets, and log messages; it is not a deterministic replay system.

## Aurora DSQL and Lambda

Production uses **Amazon Aurora DSQL (SQL) + AWS Lambda**, with the game assets on a private S3 bucket behind CloudFront:

```text
Browser → CloudFront → S3                 game, images, music and SFX
                    → Lambda /api/* → Aurora DSQL
```

The browser uses the same save picker and six slots described above. Snapshots, inventory, battles, combat decisions and branch history live in SQL tables. There is no SQLite runtime or Lambda filesystem persistence. The frontend has no database credentials.

`server/database.js` connects using PostgreSQL's wire protocol, TLS certificate verification and freshly signed IAM authentication tokens for new connections. The Lambda role gets `dsql:DbConnect` on this cluster and SQL CRUD access through the `rpg_app` role; schema administration uses a separate admin connection. Whole transactions retry bounded optimistic-concurrency conflicts, and a per-player revision row serializes competing writes. Saving a snapshot, its inventory and pending decisions remains atomic.

DSQL has column and transaction size limits, so large JSON values use Unicode-safe SQL chunks. Saves retain the previous 8 MiB write limit; browser uploads and large responses also use authenticated transport chunks to fit Lambda request/response limits. Completed upload receipts prevent duplicate commits after response loss. Expired transport data and overwritten snapshot chunks are reclaimed in bounded batches on subsequent activity for that player. Inactive players' expired rows remain until they return; production retention/cleanup scheduling is a separate operational task.

CloudFront signs requests to an IAM-protected Lambda Function URL. API caching is disabled, cookies are forwarded, and the frontend computes the exact body SHA-256 required by CloudFront/Lambda for POST and PUT. A CloudFront Function overwrites the trusted site-origin header before forwarding it. Keep this API behind that distribution; the origin check assumes the deployment template's access policy.

A random HttpOnly, Secure, SameSite=Strict cookie identifies each player in production. This remains browser identity, without registration, account recovery or cross-device sync. Clearing the cookie or changing the website's hostname creates a different identity. Use one active game tab per identity to avoid competing manual slot overwrites. Combat runs in the browser; the server validates save structure and ownership, rather than independently simulating outcomes.

Requests time out and retry pending history and the captured opening autosave. Pending unsent changes can be lost if the page closes while offline.

### Local development

`npm start` runs the same API handler through a local HTTP adapter. Without AWS configuration it uses **PGlite**, a local PostgreSQL engine in WASM, persisted at `data/local-postgres`. This is a development dependency and is excluded from the Lambda bundle. `RPG_LOCAL_DB` changes this directory; `HOST` and `PORT` change the local bind address/port. The old `RPG_DB` SQLite setting is no longer used.

To preview against an initialized DSQL cluster, set `RPG_DSQL_HOST`, `AWS_REGION` and optionally `RPG_DSQL_USER` (default `rpg_app`), with AWS credentials authorized for that role. `DATABASE_URL` is also supported for a separate local PostgreSQL server. Lambda requires DSQL configuration and refuses local database fallbacks. Tests explicitly clear remote database configuration and use temporary local databases.

### Deploy to AWS

The repository includes a SAM/CloudFormation template at `aws/template.json`. It creates a single-region DSQL cluster, Lambda and its IAM role, a private encrypted S3 bucket, and an HTTPS CloudFront distribution. It does not require an always-running database instance, API Gateway, a NAT gateway or an RDS proxy. AWS usage is billable; this does not guarantee a zero bill.

Use an AWS region that supports Aurora DSQL. Install and configure the AWS CLI and AWS SAM CLI separately, then:

```sh
npm ci
npm run build:aws
sam validate --template-file aws/template.json --lint
sam deploy --template-file aws/template.json --guided
```

Choose a stack name and region, and acknowledge IAM resource creation. The build produces `dist/lambda` and `dist/site`; the static allowlist excludes database files, backend source, dependencies, test reports and environment files. Use the stack outputs for the following values:

```sh
export AWS_REGION='<your deployment region>'
export RPG_DSQL_HOST='<DsqlEndpoint output>'
export RPG_LAMBDA_ROLE_ARN='<LambdaRoleArn output>'
npm run db:init
```

Run `db:init` with deployment/admin AWS credentials authorized for `dsql:DbConnectAdmin`. It creates the schema and asynchronous indexes, waits for the indexes, creates `rpg_app` and maps the Lambda role to it. It is separate from deployment so the running Lambda never needs admin privileges. The API will not be ready until initialization succeeds.

Then upload only the built static directory to the dedicated bucket:

```sh
aws s3 sync dist/site 's3://<SiteBucketName output>' --delete
aws cloudfront create-invalidation --distribution-id '<DistributionId output>' --paths '/*'
```

Open the `WebsiteUrl` output and verify a new battle, autosave, manual save, refresh/load and history in AWS. On later releases, rebuild, redeploy Lambda, sync the site and invalidate CloudFront. Run schema initialization when adding schema objects; it does not transform incompatible existing schemas.

Database deletion protection and stack retention protect against accidental stack deletion; they are not a backup plan. Configure the backup/export and retention policy you need before production. Logs retain seven days. Custom domains, account login, scheduled data cleanup, monitoring and a live AWS deployment smoke test are not configured by this rewrite.

AWS references: [DSQL schema support](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html), [DSQL quotas](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html), [IAM authentication](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/SECTION_authentication-token.html), and [CloudFront access to Lambda Function URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html).

### Existing SQLite saves

The old `data/game.sqlite` and journal files are retained and are never used by the new game runtime. They are not automatically uploaded. To migrate them, stop the old server and make a consistent backup of its database, including its journals. Initialize a new, unused DSQL cluster first, keep game traffic stopped, then run this explicit one-time command with DSQL admin credentials:

```sh
npm run db:migrate -- /absolute/path/to/backup/game.sqlite
```

Only this migration command imports Node's SQLite reader, in read-only mode. It preserves player IDs, slots, inventory, battle outcomes, source branches and decision IDs/results. It refuses a destination containing any players and rolls back the whole import on failure. To stay within DSQL limits, the atomic importer refuses exports above 6 MiB or a conservative 2,000-row mutation budget; larger databases need an offline batch migration. No migration has been run against AWS.

Existing browser identities are usable only if the corresponding cookie is present on the deployed hostname. A local `localhost` cookie does not move to a CloudFront/custom domain automatically. Keep your original backup until AWS save/load and identity access are verified.

## Code

- `index.html`: game engine and snapshot/restore adapter; gameplay is unchanged by the backend migration.
- `save-system.js` / `save-system.css`: save picker, transport, manual saving, history and turn readiness.
- `server/schema.sql`: SQL tables for saves, inventory, histories, chunks and player ownership.
- `server/store.js`: async transactions, OCC retries, validation and checkpoint/history contracts.
- `server/database.js`: IAM-authenticated DSQL driver and local PostgreSQL development drivers.
- `server/api.js` / `server/lambda.js`: shared JSON API and production Lambda entry point.
- `server/server.js`: local development API/static server, including media byte ranges.
- `aws/template.json`: deployable AWS infrastructure; `scripts/build-aws.mjs` builds its artifacts.

Existing routes remain: `GET /api/saves`, `GET /api/saves/:slot`, `PUT /api/saves/:slot` (manual slots), `POST /api/autosave`, `POST /api/battles/events` and `GET /api/history`. Internal upload/response chunk routes are handled transparently by the frontend.

## Run all game tests

```sh
npm test
```

All test implementations are merged into **`scripts/test-game.mjs`**. `npm run test:all` and `node scripts/test-game.mjs` run the same complete collection. No separate test server or browser debugging session is required.

The file contains twelve sections: PostgreSQL persistence/history, Lambda contracts and DSQL deployment configuration, browser selection, every skill/passive, attack arithmetic, phases/dialogue, real browser save/load, expanded item/party/follow-up mechanics, API robustness, save transport failures, full journeys/UI, an explicit browser matrix, and initialization/media/visuals. Each section runs in an isolated child process, with fresh browser profiles and temporary databases where needed. The save-flow section automatically starts and stops its own game server. Existing player saves are untouched.

The runner continues through remaining sections when a check fails and writes **one self-contained file**, `test-results/all-tests-report.html`. It includes:

- Sidebar navigation for every suite, searchable checks, group filters, and a failures-only view.
- Expandable assertions, full evidence, assignment traces, dialogue events, and logs.
- Embedded screenshots with enlargement and original-image downloads.
- Every section's original HTML and raw JSON, viewable inside the report and downloadable with their exact bytes.
- A combined JSON download and an export of all original artifacts as a base64 JSON archive, with SHA-256 checksums.

The file works offline and can be moved or shared on its own. Worker HTML/JSON/log/image files stay in temporary directories and are embedded before cleanup. The report is updated after every completed section. Existing known gameplay and asset failures remain visible, and a failing section, timeout, or missing result still exits with code 1.

To consolidate an older report folder without rerunning game tests, use `node scripts/test-game.mjs --merge-reports`. This verifies the embedded originals before removing the separate files. Older report copies appear under Original files and are not counted again in the current run's totals.

To run just one section from the same file:

```sh
npm run test:unit
npm run test:skills
npm run test:attacks
npm run test:phases
npm run test:browser
npm run test:init
npm run test:extended
npm run test:api
npm run test:transport
npm run test:journeys
npm run test:matrix
```

`test:unit` runs the database and browser-selection sections. Database tests use real local PostgreSQL via PGlite, fault-injected OCC conflicts, Lambda HTTP v2 events, large Unicode payloads and legacy-import fixtures. Live DSQL/IAM/CloudFront verification is explicitly marked SKIP until deployed; local tests do not prove AWS service compatibility. `node scripts/test-game.mjs --list` lists section IDs; `--suite <id>` selects one directly. Set `RPG_ALL_REPORT_DIR` to change the output directory, or `RPG_SUITE_TIMEOUT_MS` to change the default 20-minute limit per section. Browser selection follows the system preference described below.

These tests cover the existing regression scenarios across the game; they do not exhaust every possible battle state or verify physical speakers and artistic appearance. The individual sections' coverage and limitations follow.

## Expanded regression coverage

`test:extended` adds explicit contracts for all 14 inventory items, empty stock, rejected targets, cancellation, caps, and observer protection. It checks all 10 legal four-character parties, support interactions, mentor-dependent damage, all 15 supported follow-up pairs and both chance branches, defensive options, incompatible/unusual checkpoints, 100,000 calculation iterations, and 500-target AoE processing. Seeded 20,000-trial statistical checks verify the ordinary/boosted follow-up rates, boss critical floor, and healthy boss AI distribution with a six-standard-deviation tolerance.

`test:api` exercises the real temporary server: invalid JSON/content types/state, oversized requests, ownership, protected files/slots, duplicate and conflicting decisions, 12 concurrent writers, corrupt persisted JSON, completed battles, and disk-backed server restart. Concurrent overwrites follow the current atomic last-writer-wins policy; the suite does not assume the game has a conflict-resolution interface.

`test:transport` uses the real save UI, API and PostgreSQL database with injected offline errors, 503 responses, request timeouts, delayed writes, lost responses, reloads, readiness invalidation and repeated clicks. API timeouts/retry waits are shortened only in its test page. No production saves are used.

`test:journeys` checks real menu and targeting cancellation, follow-up Back navigation, item/guide/Mimic pages, rapid input, native keyboard/touch actions, narrow/tablet/desktop layouts, CSS zoom, native zoom when the driver actually applies it, and pixel ratios, accessible names/unique IDs, repeated starts, and crowded battle rendering. It runs an unmodified-stat Guard-to-defeat playthrough and a separate high-HP/debug-ATK sandbox victory through the phase dialogues and credits. The sandbox journey uses enlarged test-fixture HP and the built-in ATK shortcut; it validates control flow, not natural survival or game difficulty. Intro fades and enemy pacing are shortened; real media decoding and volume transitions are checked by `test:init`.

Pending checks are shown explicitly as **SKIP**, excluded from pass/fail totals, and retained in the report:

- **Approved visual comparisons:** provide `RPG_VISUAL_BASELINE_DIR` containing `viewport-390.png`, `viewport-768.png`, and `viewport-1440.png`. Comparisons decode pixels and allow a default 1% changed-pixel fraction; set `RPG_VISUAL_DIFF_LIMIT` to change that budget. Captured screenshots are never approved automatically.
- **Additional browser engines:** set `RPG_TEST_BROWSER_MATRIX` to a JSON array of explicit executable paths. The matrix runs the real initialization/media/UI checks for each requested browser. Without it, the default browser is tested and other engines are marked pending; another browser is never selected silently.
- **Human-dependent review:** balance/difficulty targets, artistic judgment, physical audio and screen-reader experience require review. Heap-growth measurements are pending where the portable driver cannot expose reliable memory data; DOM/listener growth and calculation/render stress are automated.

These cases expand coverage without claiming every possible input sequence, party/status combination, or game balance outcome has been proven correct. Failures expose current behavior; gameplay is not rewritten to make the tests pass.

## Browser selection

Every browser test reads the **system default browser on each run**. It does not choose another installed browser as a fallback. Firefox uses WebDriver BiDi; Chrome and other Chromium browsers use the Chrome DevTools Protocol. An unsupported or missing default produces a clear error before any browser is opened. Safari automation is not currently supported.

To see which browser will be used without opening it:

```sh
npm run test:browser-info
```

`RPG_TEST_BROWSER` remains an explicit override for deliberately testing a different browser. Test sessions use temporary profiles and close when finished. They do not reuse your normal tabs or browser profile. The shared resolver is `scripts/default-test-browser.mjs`, and the automation launcher is `scripts/browser-automation.mjs`.

## Test every skill

```sh
npm run test:skills
```

The skills section lives in `scripts/test-game.mjs`. It starts its own temporary local server and isolated headless browser, so you do **not** need to start the game server or a browser debugging session first. It uses your selected system default browser. Set `RPG_TEST_BROWSER` only to explicitly request a different supported browser.

The suite discovers the current playable roster and every listed skill/passive. It checks explicit expected effects, exact HP/EN costs, insufficient resources, pending targeting, successful/failed chance branches, critical hits, observer immunity, team damage multipliers, passive triggers and lifetimes, Mimic copies and menus, and the real enemy action handlers. Adding a new skill without an explicit behavioral test makes the coverage check fail.

The skills results, original `skills-report.html`, complete `skills.json`, and combat logs are embedded in `test-results/all-tests-report.html`. Choose the skills suite or use Original files to view and download the raw report/catalog.

Set `RPG_ALL_REPORT_DIR` to save reports elsewhere. The command exits with code **1** when checks fail and **0** when all pass. Failed checks are findings to investigate, rather than a reason to weaken the assertions.

Tests load the actual patched game engine from `index.html`, injecting their adapter into an in-memory copy only. Damage, status, cost, passive and targeting code executes normally with controlled randomness. Rendering/audio, dialogue waits and automatic turn advancement are isolated so each effect can be checked independently. This is a mechanics regression suite; it does not validate sound playback, visual animations, full UI navigation for every skill, or every possible battle-state combination. No save API is started or contacted, and existing player saves are untouched.

## Test attack calculations and overwritten stats

```sh
npm run test:attacks
```

The attack section in `scripts/test-game.mjs` runs the actual game engine using your system default browser, a temporary local server, and an isolated browser profile. No separate server is required and existing saves are untouched.

The suite checks all six characters' base attack, repeated calculations, normal attacks, offensive skills, Mimic, follow-ups, ATK buffs/debuffs, Rage, defense precedence, random damage spread, and team damage charges. It checks temporary attack overrides on hits, misses, reflection, deferred defeat dialogue, and injected calculation failures. Debug boost toggles and the real save/restore adapter are also checked for lost or compounded attack values. Expected arithmetic is calculated independently of the game helpers.

Attack results and the original `attacks-report.html` / `attacks.json` are embedded in `test-results/all-tests-report.html`. Failures include expected/actual values, damage inputs, and stored-stat assignment traces. Set `RPG_ALL_REPORT_DIR` to change the output directory. The command exits with code 1 if a regression is found. Presentation, audio, and automatic turn progression are isolated; this suite checks combat arithmetic rather than full battle timing or animations.

## Test phases, dialogue and turn transitions

```sh
npm run test:phases
```

The phase section in `scripts/test-game.mjs` starts its own local server and uses your system default browser. Each case runs in a fresh page to isolate dialogue listeners, timers, flags, and effects. The actual game functions and dialogue handlers run; audio output and enemy pacing are isolated. The opening warning uses its real Yes handler with shortened cosmetic fade delays. Save API calls are captured locally and existing saves are untouched.

Coverage follows the current game stages:

- Opening: Start Battle, pre-fight dialogue, Reincarnation, summon dialogue, first ready player turn, and opening checkpoint timing.
- Observer stage: boss targeting/status immunity, no boss actions, summon action counts with both or only one alive, and deferred first actions.
- Summon defeats: each character's dialogue, Itachi's three-turn Despair on Niko, Yuki's six-turn ATK boost on Miya, duplicate-event protection, and both defeat orders.
- Active boss: post-summons dialogue order, Analytical Thinking unlock and rotation, four boss actions, music selection, and a fresh player phase.
- HP power-up at 25,000: threshold boundaries, dialogue completion, one-time permanent changes, effective ATK/DEF, debuff immunity, Focus probability, critical chance, and music changes.
- Turn flow: each living ally acts once, dead allies are skipped, enemy upkeep, nested/back-to-back dialogue locks, action blocking, status ticks after dialogue, and Niko's restart order.
- Endings: boss defeat dialogue and escape screen, Niko defeat and game-over screen, and checks that the removed revival/sixteen-enemy finale remain disabled.
- Restoring saves from the observer, active boss, and HP power-up stages without replaying completed dialogue or losing phase state.

The report calls the active boss stage **Phase 2** and the HP power-up **Phase 3**. Internally the HP power-up still uses names such as `_phase2` and `SS_PHASE2_LINES`; the report includes these distinctions through the test names and state evidence. The DEF increase test follows the existing dialogue's announced permanent increase and `SS_PHASE2_ATK_DEF_MULT` setting; ineffective changes remain failures.

Phase results and the original `phases-report.html` / `phases.json` are embedded in `test-results/all-tests-report.html`, with expected/actual assertions, dialogue events, turn effects, music requests, and resulting battle state. Set `RPG_ALL_REPORT_DIR` to choose another directory. The command exits with code 1 when checks fail. These are focused regression cases, not an exhaustive simulation of every possible battle state; media decoding and broader startup visuals are covered by `test:init`.

## Test initialization, music, SFX and visuals

```sh
npm run test:init
```

The initialization section lives in `scripts/test-game.mjs`. It starts the **actual game server** with a temporary PostgreSQL database and a fresh headless browser profile. No separate server or browser setup is required. It uses the same default-browser selection and explicit `RPG_TEST_BROWSER` override as the skill tests. A temporary in-memory diagnostic bridge exposes the existing game functions to either browser protocol; production files and behavior are not rewritten.

The runner checks:

- Startup through the warning, save picker, party selection, opening dialogue and first actionable battle turn.
- Music preloading, silence before accepting the warning, and actual playback after trusted user input.
- Every registered music route, game-over music, and every SFX-bank cue, including errors normally swallowed by `play().catch(...)`.
- Every local audio/video/image file, registered portrait, skill SFX declaration, non-concatenated literal asset reference, inline image, and CSS image found in the rendered screens.
- Successful HTTP responses, nonempty files, real media byte ranges, finite duration, an advancing playback clock, audio tracks, and seeking into later content. MP3/WAV/OGG files also undergo full Web Audio decoding and a check for non-silent samples.
- Real image decoding with nonzero dimensions, styles/font initialization, rendered portraits, HP/EN bars, active-turn highlighting, and ally/enemy hurt portraits appearing and restoring.
- Deliberately corrupted image and audio payloads, to verify that a successful HTTP response alone cannot make a broken file pass.

Initialization results and the original `initialization-report.html` / `initialization.json` are embedded in `test-results/all-tests-report.html`. The report includes source-reference labels, decoding/playback evidence, failed requests, and screenshots of the startup and battle screens. Override the output directory with `RPG_ALL_REPORT_DIR`.

Reports distinguish active registered cues from declared references. Unused metadata or optional effects can reference missing assets even while the main music/SFX players work; these broken declarations remain visible as failures with their source locations. Automatically requested `/favicon.ico` is excluded from startup failures when the page does not declare a favicon. Normal canceled media requests are recorded without being treated as decoding failures.

The browser's **output is muted** while its real media elements load and play normally; the runner does not change autoplay policy or stub the audio APIs. These checks verify browser decoding and playback, not physical speakers or artistic appearance. Screenshots support visual review. Existing saves and production game files are untouched. As with skill tests, the command exits with code 1 when checks fail.

# The Final Turn-Based Battle

A browser-based, turn-based RPG where you choose three of five supporting characters to join Niko Himura against a challenging boss.

- **Frontend:** HTML, CSS and JavaScript handle combat, dialogue and animations.
- **Backend:** AWS Lambda and Amazon Aurora DSQL store saves, inventory and combat history.
- **Hosting:** Amazon S3 and CloudFront serve the game.

Players have five manual save slots and one autosave, allowing battles to resume across visits.

**Run locally** with Node.js 22.13+:

```sh
npm ci
npm start
```

Open **http://localhost:3000**. Local development uses PostgreSQL through PGlite.

**Repo layout:** `index.html` contains the game, `server/` the backend, `aws/` deployment configuration, and `scripts/` build tools and tests.

Run `npm test` to test the game using your system default browser.

[Setup, AWS deployment and testing guide](docs/DEVELOPMENT.md)

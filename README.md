# Bomboclats World Cup Pool

A static, no-login dashboard for a private World Cup pool. It runs with plain HTML, CSS, and JavaScript, so it can be deployed directly to GitHub Pages.

## Files

- `index.html` loads the dashboard.
- `styles.css` handles the responsive layout and card design.
- `app.js` calculates standings, team points, and validation warnings.
- `data/teams.js` stores team prices, tiers, groups, flags, and aliases.
- `data/players.js` stores player profiles, nationalities, headshots, and picks.
- `data/results.js` is the manual match-result entry point.
- `assets/players/avatars` contains cropped player images.

## Local Preview

Open `index.html` in a browser, or run a tiny static server from this folder:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Publishing On The Web

This project is ready for GitHub Pages because it uses plain static files. Publish only the site files, not the whole working folder, because this directory also contains unrelated notebooks, datasets, and model files.

Recommended GitHub Pages setup:

1. Create a new public GitHub repository, for example `bomboclats-world-cup-pool`.
2. Add only these files and folders:
   - `index.html`
   - `styles.css`
   - `app.js`
   - `README.md`
   - `data/`
   - `assets/`
   - `scripts/`
   - `.github/workflows/`
3. Push to GitHub.
4. In the GitHub repo, go to `Settings` -> `Pages`.
5. Under `Build and deployment`, choose `Deploy from a branch`.
6. Choose branch `main` and folder `/root`, then save.
7. GitHub will publish the site at `https://YOUR-USERNAME.github.io/bomboclats-world-cup-pool/`.

The included GitHub Action in `.github/workflows/update-world-cup-results.yml` runs every hour. It calls `scripts/update-results.mjs`, fetches World Cup matches from ESPN, rewrites `data/results.js`, awards the 32 group-stage advance bonuses, marks eliminated teams, and commits the change when scores move. The updater validates the bracket and generated rows before publishing. The page also refreshes itself hourly when served over `http` or `https`, so an open leaderboard will pick up those committed updates.

## Updating Results

Add match results to `data/results.js`:

```js
{
  team: "Portugal",
  stage: "Groups",
  result: "W",
  advanceBonus: false
}
```

Scoring uses:

- Win = 3 points
- Draw = 1 point
- Loss = 0 points
- Stage multiplier applies to match points
- Advance bonus = +1 point and is not multiplied

Set `window.POOL_RESULTS_META.lastUpdated` when you update results, for example:

```js
window.POOL_RESULTS_META = {
  lastUpdated: "June 16, 2026"
};
```

## Data Checks

The Rules tab shows quiet validation warnings for:

- Unknown team names in player picks or results
- Players over or under the $150 budget
- Players with more than one Tier 1 team
- Players with fewer than three Tier 3 teams
- Missing image paths

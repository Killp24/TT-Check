# TT Matchup Check

A small static app for TT Elite Series matchups. It compares two players' Elo, shows a win chance, and keeps a private bet log in the browser. Ratings, results, and the schedule are text files in this folder. The page can read them from the repo on GitHub, and it falls back to the copies next to `index.html` when you serve the folder yourself.

## Run it locally

Python 3 is enough. From this directory:

```bash
python3 -m http.server 8080
```

Open http://127.0.0.1:8080/

The app opens on **Home**, today's TT Elite match list. **Signals** lists ban-list, form, head-to-head, and price gaps. **Search** is where you type two player names. Home in the bottom bar returns to that list.

Check the parlay and snapshot helpers:

```bash
node --test settle.test.js
```

## Data files

| File | Contents |
| --- | --- |
| `ratings.txt` | Official Elo ranking |
| `official.txt` | Match history collected from player pages |
| `players.txt` | Career wins and losses from the site |
| `schedule.txt` | Nearby match times, Polish time |
| `ratings_history.txt` | One rankings snapshot per day |
| `ban.txt` | Manual ban list. The app does not rewrite this from form. |
| `matches.txt` | Results logged in the app |
| `odds.txt` | Book prices, with the app's prediction, edge, and timestamp |

## Update the data

Both scripts use only the Python standard library. They read [tt-series.com](https://www.tt-series.com/) and overwrite the text files above. Run them from this directory.

Fast pass. Today's tournament pages only, about twenty requests. Refreshes `schedule.txt` and adds finished matches to `official.txt`:

```bash
python3 fast_update.py
```

Full pass. The ranking, then every player page. This is hundreds of requests and is what produces `ratings.txt`, `players.txt`, `official.txt`, `schedule.txt`, and `ratings_history.txt`:

```bash
python3 update_data.py
```

If `ratings.txt` is missing, run the full pass before the fast one. GitHub Actions in `.github/workflows/` run these on a schedule and commit when a file changes. A local run does not push.

Sharing setup in the app stores a GitHub token in the browser only. Do not put tokens in these files.

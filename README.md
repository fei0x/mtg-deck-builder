# Commander Deck Builder

A local single-page web app for building Magic: The Gathering decks — built around
**Commander**, but also handles Oathbreaker, Duel Commander, Brawl, and the common
constructed formats. Pick a commander, auto-import its EDHREC recommendation pool,
then curate it into a deck using a five-level inclusion model, playtest it, and
export to the tools you already use.

## Getting started (first time)

You only need two things: **Python** and **PowerShell** (PowerShell already comes with
Windows). The whole app runs on your own computer.

### 1. Install Python (one time)

If you don't already have Python, install it. The easiest way on Windows 10/11 — open
**PowerShell** and run:

```powershell
winget install Python.Python.3.12
```

…or download it from <https://www.python.org/downloads/>. **Important:** on the very first
installer screen, tick **“Add python.exe to PATH”** before you click Install. (If you skip
this, Windows won't be able to find Python and `start.ps1` will tell you so.)

You don't need to install Flask or anything else by hand — the start script does that for you.

### 2. Start the app

1. Open the project folder in File Explorer.
2. In the address bar, type `powershell` and press **Enter** (this opens PowerShell already in
   the right folder).
3. Run:

   ```powershell
   ./start.ps1
   ```

The first run takes a minute (it sets up a private Python environment and downloads Flask).
After that it's quick. When it's ready your browser opens automatically at
<http://localhost:5000>.

> **If you see a red “running scripts is disabled on this system” error**, run this once, then
> try again:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```

### 3. Stop the app

```powershell
./stop.ps1
```

Or just close the server window. Re-running `./start.ps1` also restarts a clean copy.

Nothing leaves your machine except card-data lookups to Scryfall / EDHREC.

## What it does

- **Start from a commander** — type a commander (Scryfall autocomplete); the app pulls
  the full EDHREC recommendation pool (~200–300 cards) and loads them into your workspace.
- **Formats** — Commander, Oathbreaker, Duel Commander, Brawl, Modern, Pioneer, Standard,
  Legacy, Vintage, Pauper, and Premodern, set from the gear (⚙) menu. Every card's Scryfall
  legality is tracked per-format; an illegal card is excluded from the count/price/stats/
  playtest automatically but stays visible (dimmed, sorted last) so you can see what has to go.
  Singleton formats get a copy-limit ⚠ warning if you exceed it.
  A **Keyboard Shortcuts** item in the same menu covers the shortcuts below.
- **Functional tagging** — every card is tagged by role (Ramp, Card Draw, Removal, Board
  Wipes, Counterspells, Burn, Life Gain, Tokens, Tutors, Group Hug, …) using Archidekt's
  crowd-sourced categories plus oracle-text heuristics. The gear (⚙) → **Tags** pop-up lets you
  reorder tag buckets and **Recalculate all tags** (re-derives from oracle text, with options to
  also drop stale tags or reset each card's primary tag). Typing a new tag on a card offers a
  filter-as-you-type combobox of existing tags.
- **Five-level inclusion model** — every card is `Locked In · In · Undecided · Out · Locked Out`.
  Only *Locked In* + *In* count toward the deck. Hover a card (or use the drawer/numpad, see
  below) to set its state — locked states ask for confirmation. The workspace *is* your maybeboard.
- **Printing / "skin" picker** — flip through every printing of a card (gallery, drawer, or
  tokens) without touching its price, which is frozen to the card's original printing.
- **Bucketing** — group the gallery by **All**, **Tag**, **Card Type**, **Mana Cost** (with
  configurable breakpoints), or **Rarity**, with a multi-select popover for colour/type filters
  and cost breakpoints. Sort by name, mana value, **EDHREC inclusion/synergy**, price, or
  rarity, with an optional "In first" toggle (illegal cards always sort last).
- **Keyboard shortcuts** (drawer open, not typing in a field) — **←/→** step to the previous/
  next card, **↑/↓** step through its printings, and the numpad (**1/2/3** In/Undecided/Out,
  **4/6** Locked In/Out) sets inclusion state, with the usual confirmation popup when leaving a
  locked state.
- **Card detail drawer** — full image with hover-flip for double-faced cards, mana symbols,
  oracle text, a plain-English **keyword glossary**, **rulings**, tag editing, the inclusion
  control, printing picker, prices, and format legality.
- **Stats** — mana curve (and by color), color identity, card-type and tag distributions,
  inclusion-state summary, average CMC.
- **Playtester** — shuffle, opening hand, London mulligan, draw, and six zones (library / hand /
  battlefield / graveyard / exile / command — the Command Zone appears for every commander-style
  format). Tap/untap, turns, life & the six mana counters, a randomiser (roll a die, flip a
  coin, or select N cards from a zone), full undo, drag-and-drop to reposition or move cards
  between zones (including multi-row zones), right-click menus, generic counters (add/remove,
  up to 12), token creation/removal, an inclusion overlay so you can adjust the real deck without
  leaving the sim, and **Scry** — peek the top of the library with a face-down card back you
  click to reveal.
- **Import / Export** — paste or pull from an **Archidekt URL**; export to **plain text,
  MTG Arena, mtgprint.net, Archidekt**, a **lossless Archidekt round-trip** (preserves inclusion
  state + tags), or **JSON** backup, filtered by whichever inclusion states (and tokens) you pick.
  Bulk-add also supports pulling a card's own EDHREC recommendation pool by name.

## Data sources

- **Scryfall** — card data, images, prices, rulings, legality (`api.scryfall.com`; cached locally).
- **EDHREC** — the per-commander (and per-card) recommendation pool + inclusion/synergy stats.
- **Archidekt** — crowd-sourced functional categories (read-only) to enrich tagging, and the
  public deck API for URL import.

## Where your data lives

- `decks/` — your decks, one JSON file each.
- `cache/` — cached Scryfall/EDHREC/Archidekt responses (7-day TTL; safe to delete).

## Known limitations

- Commander autocomplete lists any card name (non-commanders fail gracefully with an
  "empty deck" option).
- Single local user; no accounts, no cloud sync (use Archidekt round-trip or JSON export as a
  backup). See "Sharing this with other people" below if you want more than one person using it.

## Sharing this with other people

There are no user accounts and no per-user data isolation — everyone who opens the app talks
to the same `decks/` folder. The recommended setup is **one copy per person**: each friend
clones/downloads the repo and runs their own `./start.ps1` on their own machine, exactly like
you do. That needs zero code changes, costs nothing, and each person's decks stay private to
them. Point them at this README — `start.ps1` handles the Python setup for them too.

If you specifically want everyone sharing *one* running instance (e.g. so you can all see the
same decks from different computers), that means hosting the Flask app somewhere reachable
(a small VPS, or a free/cheap tier on something like Render/Railway/Fly.io) — but decks would
need per-user separation added first, since right now anyone hitting that instance sees and can
edit every deck on it. That's a real feature to build, not a deployment setting, so it's worth
confirming that's actually what you want before investing in it.

## Putting this on GitHub

1. `git init` in the project folder (turns it into a repo — already has a `.gitignore` that
   excludes `venv/`, `cache/`, and your personal `decks/*.json` files, so only the app itself
   gets committed).
2. `git add -A` then `git commit -m "Initial commit"`.
3. Create an empty repository on github.com (no README/license/gitignore — you already have
   those), then copy its URL.
4. `git remote add origin <that URL>`.
5. `git branch -M main` (if your default branch is still `master`).
6. `git push -u origin main`.

After that, `git add`, `git commit`, and `git push` are all you need for future changes. If you'd
rather not touch the command line, GitHub Desktop does the same thing with a GUI — point it at
this folder and it'll offer to publish it. Say the word if you want me to run steps 1–2 now (I'd
still need you to create the empty repo on github.com yourself and hand me the URL for step 4).

## Project docs

- [`requirements/`](requirements/00-index.md) — the full specification.
- [`plan/`](plan/README.md) — the implementation plan, per-bucket build logs, and the
  backlog ([`plan/TODO.md`](plan/TODO.md)).

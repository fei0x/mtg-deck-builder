// playtest.js — local single-player playtest view (plan bucket 12).
//
// A self-contained hand/zone simulator for the deck's INCLUDED cards
// (inclusionState in {locked_in, in}), expanded by quantity. The commander
// (isCommander) goes to the Command Zone; everything else seeds the Library.
// No rules enforcement — just draws, zones, life, mana, turns, undo.
//
// Contract:
//   import { getState } from "./state.js";
//   import { loadCardData } from "./card.js";
//   export function openPlaytest();  // wired to the Playtest button in app.js
//
// This module owns ONLY static/js/playtest.js. It injects its own <style> block
// (guarded against duplicates) and builds its overlay imperatively, using the
// shared theme CSS variables so it matches the dark theme.

import { getState, isLegal } from "./state.js";
import { loadCardData } from "./card.js";
import { api } from "./api.js";
import { LOCK_SVG } from "./cardstate.js";

const IN_STATES = new Set(["locked_in", "in"]);

// Card-size slider persistence — a plain localStorage entry (not routed through
// state.js's setState/persist) because playtest.js renders itself and never
// touches the global pub/sub; going through setState would also re-trigger the
// main gallery's render on every drag tick of this slider.
const PT_CARD_W_KEY = "cdb.pt.cardW";
function loadCardW() {
  const n = parseInt(localStorage.getItem(PT_CARD_W_KEY), 10);
  return Number.isFinite(n) ? n : 200;
}
function saveCardW(w) {
  try { localStorage.setItem(PT_CARD_W_KEY, String(w)); } catch { /* ignore quota/private-mode errors */ }
}

// PT6 — starting life by format. Commander 40 · Brawl 25 · everything else 20.
const FORMAT_LIFE = { commander: 40, brawl: 25 };
function startingLife(format) {
  return FORMAT_LIFE[String(format || "commander").toLowerCase()] ?? 20;
}

// (R18) format label for the header reminder (mirrors app.js's FORMATS/formatLabel).
const FORMAT_LABELS = {
  commander: "Commander", oathbreaker: "Oathbreaker", duel: "Duel Commander",
  brawl: "Brawl", modern: "Modern", pioneer: "Pioneer", standard: "Standard",
  legacy: "Legacy", vintage: "Vintage", pauper: "Pauper", premodern: "Premodern",
};
function formatLabel(format) {
  return FORMAT_LABELS[String(format || "commander").toLowerCase()] || format || "Commander";
}

// PT4 — inclusion state → the deck-builder --state-* colour (undecided has no
// dedicated var; use the dim text colour like the gallery does).
const INCL_STATE_COLOR = {
  locked_in: "var(--state-locked-in)",
  in: "var(--state-in)",
  undecided: "var(--text-dim)",
  out: "var(--state-out)",
  locked_out: "var(--state-locked-out)",
};
const INCL_ORDER = ["locked_in", "in", "undecided", "out", "locked_out"];
// (R9 WS10) same drawn lock glyph as the workspace uses for both lock states —
// colour (gold vs red) is applied via CSS, see .pt-incl-bubble.cs-locked_out.
const INCL_ICONS = { locked_in: LOCK_SVG, in: "✓", undecided: "?", out: "✗", locked_out: LOCK_SVG };
const INCL_LABELS = {
  locked_in: "Locked In", in: "In", undecided: "Undecided", out: "Out", locked_out: "Locked Out",
};

// Zone keys → display labels. Library/Command get bespoke layouts; the rest are
// generic card piles/rows.
const ZONES = {
  library: "Library",
  hand: "Hand",
  battlefield: "Battlefield",
  graveyard: "Graveyard",
  exile: "Exile",
  command: "Command Zone",
};

// Where the per-card context menu can send a card. (Filtered to exclude the
// card's current zone at menu-build time.)
const MOVE_TARGETS = [
  ["hand", "Hand"],
  ["battlefield", "Battlefield"],
  ["graveyard", "Graveyard"],
  ["exile", "Exile"],
  ["command", "Command Zone"],
  ["library-top", "Library (top)"],
  ["library-bottom", "Library (bottom)"],
];

// J4 — per-zone identity: color CSS var + a single icon glyph. Used on the
// per-card move-button rings AND echoed in each zone header so the colour/icon
// language is consistent everywhere.
// PT-P5 — inline monochrome SVGs (inherit currentColor) for the icons that have
// no good single-colour unicode glyph: an OPEN hand for Hand and a GRAVESTONE
// for Graveyard. `svg` (when present) is preferred over the `icon` glyph.
const SVG_HAND =
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">' +
  '<path d="M7 11V4.5a1.3 1.3 0 0 1 2.6 0V10h.7V3.3a1.3 1.3 0 0 1 2.6 0V10h.7V4a1.3 1.3 0 0 1 2.6 0v6h.7V6.5a1.3 1.3 0 0 1 2.6 0V14c0 3.9-2.7 6.5-6.4 6.5-2.2 0-3.9-.8-5.3-2.6L4 13.4a1.3 1.3 0 0 1 2-1.7l1 1.1z"/></svg>';
const SVG_GRAVE =
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 2a6 6 0 0 0-6 6v11h12V8a6 6 0 0 0-6-6zm-1 5h2v2h2v2h-2v4h-2v-4H9V9h2V7z"/>' +
  '<rect x="4" y="19" width="16" height="2.5" rx="1"/></svg>';
// (R19) "Draw" icon — same tray+down-arrow shape as the top bar's Import
// button (drawing a card = pulling it down into your hand).
const SVG_DRAW =
  '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">' +
  '<path d="M12 3v10m0 0l-4-4m4 4l4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// PT-P4 — "stack of rectangles" icons for the move-to-top / move-to-bottom of
// library controls. Three horizontal rounded rects; the TOP one filled for
// move-to-top, the BOTTOM one filled for move-to-bottom (others outlined).
// Monochrome — inherits currentColor.
function stackSvg(filled /* "top" | "bottom" */) {
  const y = [3, 9.5, 16];
  const rect = (yy, on) =>
    `<rect x="3" y="${yy}" width="18" height="5" rx="1.6" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.6"/>`;
  return '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">' +
    rect(y[0], filled === "top") + rect(y[1], false) + rect(y[2], filled === "bottom") +
    "</svg>";
}
const SVG_LIB_TOP = stackSvg("top");
const SVG_LIB_BOTTOM = stackSvg("bottom");

const ZONE_IDENTITY = {
  command:     { color: "var(--pt-zc-command)",     icon: "♛" },
  // PT-P5 — open-hand SVG (inherits the zone-ring colour, green) instead of the
  // old ☝ manicule glyph.
  hand:        { color: "var(--pt-zc-hand)",        icon: "✋", svg: SVG_HAND },
  battlefield: { color: "var(--pt-zc-battlefield)", icon: "⚔" },
  library:     { color: "var(--pt-zc-library)",     icon: "▤" },
  // PT-P5 — gravestone SVG instead of the ⚰ coffin glyph.
  graveyard:   { color: "var(--pt-zc-graveyard)",   icon: "⚰", svg: SVG_GRAVE },
  exile:       { color: "var(--pt-zc-exile)",       icon: "✦" },
  // P7 — Life is not a card zone, but it shares the coloured-icon identity
  // language (Orange) so the left-rail Life box matches the other zones.
  life:        { color: "var(--pt-zc-life)",        icon: "♥" },
};

// PT-P5 — render a zone identity icon as a DOM node: an inline SVG when the
// zone defines one (Hand / Graveyard), otherwise a text glyph. Callers append
// the returned node wherever the icon should appear.
function zoneIconNode(id) {
  if (id?.svg) return el("span", { class: "pt-zone-glyph", html: id.svg });
  return document.createTextNode(id?.icon || "");
}

// J8 — land detection mirrors stats.js (cardType / cardTypes carry the parsed
// type line). Lands get their own battlefield row when moved via buttons.
function isLandCard(card) {
  const t = card.cardType || "";
  if (/land/i.test(t)) return true;
  if (Array.isArray(card.cardTypes) && card.cardTypes.some((x) => /land/i.test(x))) return true;
  return false;
}

// R6 — map a card's colour identity to a single bead colour for the round-stone
// play markers: mono W/U/B/R/G → that mana colour, multicolour → gold,
// colourless/none → grey.
const BEAD_MANA = {
  W: "var(--pt-mana-w)", U: "var(--pt-mana-u)", B: "var(--pt-mana-b)",
  R: "var(--pt-mana-r)", G: "var(--pt-mana-g)", C: "var(--pt-mana-c)",
};
function beadColorFor(colorIdentity) {
  const ci = Array.isArray(colorIdentity)
    ? [...new Set(colorIdentity.map((s) => String(s).toUpperCase()).filter((s) => s in BEAD_MANA && s !== "C"))]
    : [];
  if (ci.length === 0) return "var(--text-faint)"; // colourless / none → grey
  if (ci.length === 1) return BEAD_MANA[ci[0]];     // mono → its mana colour
  return "#e0b341";                                  // multicolour → gold
}

let cardSeq = 0; // unique instance id per physical card

// ---------------------------------------------------------------------------
// Style injection (guarded — only once per page)
// ---------------------------------------------------------------------------
function injectStyles() {
  if (document.getElementById("playtest-styles")) return;
  const style = document.createElement("style");
  style.id = "playtest-styles";
  style.textContent = `
  .pt-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: var(--bg-0); color: var(--text);
    font-family: var(--font); font-size: var(--fs-md);
    display: flex; flex-direction: column;
    overflow: hidden;
    max-width: 100vw; max-height: 100vh;
    /* J4 — per-zone identity colours (Command=Gold, Hand=Green,
       Battlefield=Red, Library=Blue, Graveyard=Purple, Exile=White,
       P7 Life=Orange). */
    --pt-zc-command: #e0b341;
    --pt-zc-hand: #3fb950;
    --pt-zc-battlefield: #f0566b;
    --pt-zc-library: #4c9aff;
    --pt-zc-graveyard: #b07bd9;
    --pt-zc-exile: #e8e8ec;
    --pt-zc-life: #e8893f;
    /* P4 — fixed PILE size (Command/Library/Graveyard/Exile piles + the
       commander). Distinct from --pt-card-w (the size slider, open zones only).
       Enlarged ~30% over the old 118px pile width. */
    --pt-pile-w: 153px;
    /* (R15) dedicated mana-symbol colours for the playtester — closer to
       Magic's actual 5-colour (+colourless) palette than the shared --mana-*
       vars, which are deliberately pale pastels so dark pip text stays
       legible on them elsewhere in the app (drawer mana cost). Those don't
       read as "the 5 colours" on their own, which is what was asked for here. */
    --pt-mana-w: #f8f6d8;
    --pt-mana-u: #0e68ab;
    --pt-mana-b: #2b2320;
    --pt-mana-r: #d3202a;
    --pt-mana-g: #1b7943;
    --pt-mana-c: #b0aea8;
  }
  .pt-overlay * { box-sizing: border-box; }
  .pt-topbar {
    flex: 0 0 auto;
    display: flex; align-items: center; gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-1);
    border-bottom: 1px solid var(--border);
  }
  /* (R17) mirrors the main page's #topbar three-section layout. */
  .pt-topbar-left, .pt-topbar-right { display: flex; align-items: center; gap: var(--sp-2); }
  .pt-topbar-right { margin-left: auto; }
  .pt-topbar-center {
    flex: 1; min-width: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; line-height: 1.1;
  }
  .pt-brand { font-weight: 700; color: var(--text); white-space: nowrap; letter-spacing: .2px; }
  .pt-commander-sub { font-size: var(--fs-sm); color: var(--text-dim); }
  .pt-title { font-size: var(--fs-lg); font-weight: 600; }
  .pt-sub { color: var(--text-dim); font-size: var(--fs-sm); }
  .pt-sub b { color: var(--text); font-weight: 600; }
  .pt-warn { color: var(--warn); font-size: var(--fs-sm); }
  .pt-spacer { flex: 1 1 auto; }
  /* X5 — prominent Turn counter in the top bar (larger / emphasised). */
  .pt-turn {
    display: inline-flex; align-items: baseline; gap: 6px;
    background: var(--bg-2); border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm); padding: 2px 12px;
  }
  .pt-turn-lbl {
    color: var(--text-dim); font-size: var(--fs-xs);
    text-transform: uppercase; letter-spacing: .06em;
  }
  .pt-turn-val {
    color: var(--text); font-size: var(--fs-xl); font-weight: 700;
    font-variant-numeric: tabular-nums; line-height: 1;
  }

  .pt-btn {
    background: var(--bg-2); color: var(--text);
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
    padding: 5px 10px; cursor: pointer; font-size: var(--fs-sm);
    line-height: 1.2; white-space: nowrap;
  }
  .pt-btn:hover { background: var(--bg-hover); }
  .pt-btn:disabled { opacity: 0.4; cursor: default; }
  .pt-btn.primary { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }
  .pt-btn.primary:hover { background: var(--accent-hover); }
  .pt-btn.danger { border-color: var(--danger); color: var(--danger); }
  .pt-btn.sm { padding: 2px 7px; font-size: var(--fs-xs); }

  .pt-toolbar {
    flex: 0 0 auto;
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-1); border-bottom: 1px solid var(--border);
  }
  .pt-toolbar .sep { width: 1px; align-self: stretch; background: var(--border); margin: 0 var(--sp-1); }
  /* R6 — flex spacer right-justifies the randomiser / mana / size groups. */
  .pt-tb-spacer { flex: 1 1 auto; }
  .pt-group { display: flex; align-items: center; gap: 4px; }
  .pt-group label { color: var(--text-dim); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; }
  /* PT-P7 — two-line labelled toolbar sections (mirrors the main gallery
     .toolbar-label / .tb-section pattern): an uppercase label row on top and a
     controls row beneath, with a thin divider between groups. */
  .pt-tb-section { display: flex; flex-direction: column; gap: 3px; }
  .pt-tb-label {
    font-size: var(--fs-xs); color: var(--text-faint);
    text-transform: uppercase; letter-spacing: .5px; line-height: 1;
  }
  .pt-tb-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .pt-toolbar .vsep { width: 1px; align-self: stretch; background: var(--border); margin: 0 var(--sp-1); }

  .pt-counter {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 2px 4px;
  }
  .pt-counter .val { min-width: 22px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }
  .pt-counter .lbl { color: var(--text-dim); font-size: var(--fs-xs); padding: 0 2px; }
  .pt-counter button {
    background: var(--bg-3); color: var(--text); border: none; border-radius: 3px;
    width: 20px; height: 20px; cursor: pointer; font-size: 13px; line-height: 1;
  }
  .pt-counter button:hover { background: var(--bg-hover); }

  /* PT12 — the pip circle is gone; the count itself now carries a dark-tinted
     mana-colour background (white text stays legible against all six colours,
     including the naturally pale/cream white mana). (R15) uses the dedicated
     --pt-mana-* palette (see .pt-overlay) instead of the shared, deliberately
     pastel --mana-* vars, so these read as the actual 5 Magic colours. */
  .pt-mana .val { padding: 1px 7px; border-radius: 4px; color: #fff; }
  /* (R17) white mana swaps the usual dark-tint/white-text pattern — a WHITE
     background reads more like actual white mana than a dark-tinted chip
     ever could, so it gets grey text instead of white for contrast. */
  .pt-mana .val-mana-W { background: var(--pt-mana-w); color: #55524a; }
  .pt-mana .val-mana-U { background: color-mix(in srgb, var(--pt-mana-u) 45%, #10131a); }
  .pt-mana .val-mana-B { background: color-mix(in srgb, var(--pt-mana-b) 55%, #10131a); }
  .pt-mana .val-mana-R { background: color-mix(in srgb, var(--pt-mana-r) 45%, #10131a); }
  .pt-mana .val-mana-G { background: color-mix(in srgb, var(--pt-mana-g) 45%, #10131a); }
  .pt-mana .val-mana-C { background: color-mix(in srgb, var(--pt-mana-c) 45%, #10131a); }

  .pt-main {
    flex: 1 1 auto; display: flex; min-height: 0; min-width: 0;
    overflow: hidden;
  }
  /* J5 — Left rail: Command Zone + Library beneath it. Sized to comfortably
     fit a card at the larger default size. */
  .pt-side {
    flex: 0 0 200px; display: flex; flex-direction: column; gap: var(--sp-3);
    padding: var(--sp-3); border-right: 1px solid var(--border);
    background: var(--bg-1); overflow-y: auto; overflow-x: hidden;
    min-width: 0;
  }
  /* J6 — center (Hand/Battlefield) and right (Graveyard/Exile) panels share the
     remaining width; whichever is focused gets the bulk, the other collapses to
     a narrow pile column. The .focus-* class on .pt-main drives the split. */
  .pt-zones, .pt-rail {
    display: flex; flex-direction: column; gap: var(--sp-3);
    overflow-y: auto; overflow-x: hidden; padding: var(--sp-3);
    min-width: 0; min-height: 0;
  }
  .pt-rail { border-left: 1px solid var(--border); background: var(--bg-1); }
  .pt-main.focus-center .pt-zones { flex: 1 1 auto; }
  .pt-main.focus-center .pt-rail  { flex: 0 0 168px; }
  .pt-main.focus-right  .pt-zones { flex: 0 0 168px; }
  .pt-main.focus-right  .pt-rail  { flex: 1 1 auto; }

  .pt-zone {
    background: var(--bg-1); border: 1px solid var(--border);
    border-radius: var(--radius); padding: var(--sp-2);
    min-width: 0; max-width: 100%;
  }
  .pt-zone.drop-hover { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .pt-zone-head {
    display: flex; align-items: center; gap: var(--sp-2);
    margin-bottom: var(--sp-2); color: var(--text-dim);
    font-size: var(--fs-sm); text-transform: uppercase; letter-spacing: .04em;
  }
  .pt-zone-head b { color: var(--text); font-weight: 600; }
  /* J4 — zone identity icon echoed in the header, coloured to match its ring. */
  .pt-zone-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; border-radius: 50%;
    border: 1.5px solid currentColor; font-size: 12px; line-height: 1;
    flex: 0 0 auto;
  }
  .pt-zone-actions { margin-left: auto; display: flex; gap: 4px; }
  /* PT-P5 — inline zone-identity SVG glyph (Hand / Graveyard); inherits the
     surrounding colour and sits on the text baseline like a glyph. */
  .pt-zone-glyph { display: inline-flex; align-items: center; justify-content: center; line-height: 0; }
  .pt-zone-glyph svg { display: block; }
  /* PT-P1 — padding + visible overflow so the coloured inclusion borders /
     box-shadows on Hand / Battlefield / Library-splay cards are never clipped
     at the container edge (Graveyard/Exile piles already looked right). */
  .pt-cards {
    display: flex; flex-wrap: wrap; gap: var(--sp-2); min-height: var(--pt-card-h, 120px);
    align-content: flex-start; min-width: 0; max-width: 100%;
    padding: 4px; overflow: visible;
  }
  .pt-cards.row { flex-wrap: nowrap; overflow-x: auto; overflow-y: visible; max-width: 100%; padding: 4px; }
  .pt-empty { color: var(--text-faint); font-size: var(--fs-sm); font-style: italic; padding: var(--sp-2); }

  /* P1/P2/P4 — Command Zone: the commander card stays at the fixed PILE size
     (the size slider must NOT resize it), and the card area keeps a fixed
     height (sized to a pile-width card's 63:88 aspect ratio) so the zone — and
     everything beneath it in the left rail — never shifts when the commander
     leaves the Command Zone. */
  .pt-cmd-cards {
    min-height: calc(var(--pt-pile-w) * 88 / 63);
  }
  .pt-cmd-cards .pt-card { width: var(--pt-pile-w); }

  .pt-card {
    position: relative; width: var(--pt-card-w, 86px);
    border-radius: var(--radius-sm); overflow: visible; cursor: grab;
    user-select: none;
  }
  /* (R14) percentage radius (not a fixed px one) — matches the steeper,
     size-proportional rounding of the printed MTG card so a sliver of the
     image's (usually white) background outside the card's own rounded
     silhouette can't peek through our clip mask at larger card sizes. */
  .pt-card .pt-card-inner {
    /* (R17) 5% / 3.58% (width-% / height-%) — a true circular corner sized
       to match a real card's ~5% radius; a plain "6%" cut too much art away
       and, on this portrait box, drew a slightly elliptical corner. */
    border-radius: 5% / 3.58%; overflow: hidden;
    background: var(--bg-3); border: 1px solid var(--border-strong);
    aspect-ratio: 63 / 88; display: flex; align-items: center; justify-content: center;
    transition: transform .12s ease;
  }
  .pt-card.tapped .pt-card-inner { transform: rotate(90deg) scale(.82); }
  .pt-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pt-card .pt-ph {
    font-size: var(--fs-xs); color: var(--text-dim); text-align: center;
    padding: 4px; line-height: 1.15; word-break: break-word;
  }
  .pt-card.dragging { opacity: .4; }
  /* R6 — round-stone play markers: upper-left, two columns, glass-bead look,
     tinted to the card's colour (--bead). Hover +/- controls at the bottom-left. */
  /* (R14) nudged down by half a stone's height (17px / 2) so it clears
     "sub-titled" cards (e.g. an Equipment with a flavour name under the
     title) whose title band runs taller than usual. */
  /* (R15) 3 columns, filled COLUMN-at-a-time (grid-auto-flow: column with a
     fixed 4-row height) instead of row-at-a-time — max 12 shown (3x4). */
  .pt-card .pt-stones {
    position: absolute; top: calc(12% + 8.5px); left: 4%; z-index: 2; pointer-events: none;
    display: grid; grid-auto-flow: column; grid-template-rows: repeat(4, auto); gap: 2px;
  }
  .pt-card .pt-stone {
    width: 17px; height: 17px; border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, rgba(255,255,255,.75), var(--bead, var(--text-faint)) 70%);
    border: 1px solid rgba(0,0,0,.4); box-shadow: 0 1px 2px rgba(0,0,0,.5);
  }

  /* (R18) real card-back photo instead of the diagonal-stripe placeholder,
     with a dark overlay so the count/"Draw" text stays legible over it. */
  .pt-libface {
    position: relative;
    width: var(--pt-pile-w); max-width: 100%; aspect-ratio: 63 / 88;
    border-radius: 5% / 3.58%;
    background: linear-gradient(rgba(10,12,16,.55), rgba(10,12,16,.55)),
      url("/img/card-back.webp") center/cover no-repeat;
    border: 1px solid var(--border-strong);
    display: flex; align-items: center; justify-content: center; flex-direction: column;
    color: var(--text-dim); font-size: var(--fs-sm); cursor: pointer;
  }
  /* (R19) always a blue outline around the whole pile (was only on hover with
     the muted default border) — the draw affordance is the WHOLE pile, so the
     highlight lives on it, not the card art. */
  .pt-libface { border: 1.5px solid var(--accent); }
  .pt-libface:hover { border-color: var(--accent-hover); }
  .pt-libface b { color: var(--text); font-size: var(--fs-xl); }
  /* D2/(R19) "Click to draw" affordance — blue text + icon over a dark
     translucent band (was a solid blue fill) to match the outline instead of
     competing with it. */
  /* (R20) inset 3px on all sides (was flush left/right/bottom) — flush edges
     covered the pile's rounded blue border at the bottom corners. */
  .pt-libface .pt-draw-cta {
    position: absolute; left: 3px; right: 3px; bottom: 3px;
    display: flex; align-items: center; justify-content: center; gap: 4px;
    background: rgba(10,12,16,.75); color: var(--accent);
    font-size: var(--fs-sm); font-weight: 700; text-align: center;
    padding: 4px 2px; border-radius: 4px;
    pointer-events: none; letter-spacing: .02em;
  }
  .pt-draw-cta svg { width: 13px; height: 13px; display: block; }
  /* J7 — clickable control below the Library pile to view ALL cards in order.
     P3 — its width matches the Library pile width exactly. */
  .pt-lib-expand {
    margin-top: var(--sp-2); width: var(--pt-pile-w); max-width: 100%;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    background: var(--bg-2); color: var(--text); cursor: pointer;
    border: 1px solid var(--pt-zc-library); border-radius: var(--radius-sm);
    padding: 5px 8px; font-size: var(--fs-sm); line-height: 1.2;
  }
  .pt-lib-expand:hover { background: var(--bg-hover); }
  /* X4 — the library identity icon coloured to match its ring, with the flex
     gap providing the space between it and the "View Library" text. */
  .pt-lib-expand-icon { color: var(--pt-zc-library); }
  /* X3 — Shuffle control directly below View-Library, identical width. */
  .pt-lib-shuffle {
    margin-top: var(--sp-2); width: var(--pt-pile-w); max-width: 100%;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    background: var(--bg-2); color: var(--text); cursor: pointer;
    border: 1px solid var(--pt-zc-library); border-radius: var(--radius-sm);
    padding: 5px 8px; font-size: var(--fs-sm); line-height: 1.2;
  }
  .pt-lib-shuffle:hover { background: var(--bg-hover); }
  /* R6 — only the shuffle glyph is tinted library-blue; the word stays white. */
  .pt-lib-shuffle-icon { color: var(--pt-zc-library); }

  /* J8 — battlefield split into a non-land area and a lands row beneath it.
     PT-P1 — visible overflow so card shadows aren't clipped by the row above. */
  .pt-bf-rows { display: flex; flex-direction: column; gap: var(--sp-2); overflow: visible; }
  .pt-bf-row-label {
    color: var(--text-faint); font-size: var(--fs-xs);
    text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px;
  }
  .pt-bf-lands { border-top: 1px dashed var(--border); padding-top: var(--sp-2); }
  /* R6 — two labelled counts in the battlefield header (Permanents · Lands). */
  .pt-bf-count { color: var(--text-dim); font-size: var(--fs-xs); text-transform: none; letter-spacing: normal; }
  .pt-bf-count + .pt-bf-count::before { content: "·"; margin: 0 5px; color: var(--text-faint); }

  /* J9 — drop indicator shown between cards when reordering / inserting. */
  .pt-card.drop-before { box-shadow: -3px 0 0 0 var(--accent); }
  .pt-card.drop-after  { box-shadow:  3px 0 0 0 var(--accent); }

  /* D3 — slim right-rail stacks (Graveyard / Exile) showing top card + count */
  .pt-stack { display: flex; flex-direction: column; min-width: 0; }
  .pt-stackface {
    position: relative; width: var(--pt-pile-w); max-width: 100%; aspect-ratio: 63 / 88;
    border-radius: 5% / 3.58%; overflow: hidden; cursor: pointer;
    background: var(--bg-3); border: 1px solid var(--border-strong);
    display: flex; align-items: center; justify-content: center;
  }
  .pt-stackface:hover { border-color: var(--accent); }
  .pt-stackface img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pt-stackface .pt-ph { font-size: var(--fs-xs); color: var(--text-dim); text-align: center; padding: 4px; }
  .pt-stackface .pt-stack-count {
    position: absolute; top: 3px; right: 3px;
    background: rgba(10,12,16,.82); color: var(--text);
    font-size: 11px; font-weight: 700; border-radius: 8px; padding: 1px 7px; line-height: 16px;
  }
  .pt-stackface .pt-stack-empty { color: var(--text-faint); font-style: italic; font-size: var(--fs-xs); }

  /* J6 — a panel (expanded zone group OR collapsed pile column) fills its
     column and stacks its zones vertically. */
  .pt-expand { display: flex; flex-direction: column; gap: var(--sp-3); flex: 1 1 auto; min-height: 0; }

  /* D4/J2/J4 — per-card hover zone-move control. The row is sized to the card
     (full width, centred, wraps) so the buttons never crunch/overlap even at
     the smallest card size. Every button uses a consistent coloured-ring icon
     keyed to the destination zone's identity colour. */
  .pt-zonemove {
    position: absolute; left: 50%; bottom: 4px; transform: translateX(-50%);
    display: flex; flex-wrap: wrap; justify-content: center; gap: 3px; padding: 3px;
    background: rgba(10, 12, 16, 0.9); border-radius: 12px;
    opacity: 0; transition: opacity 100ms; pointer-events: none; z-index: 5;
    width: calc(100% - 6px); max-width: 100%;
  }
  /* (R20) .pt-force-hover — see render()'s comment. */
  .pt-card:hover .pt-zonemove, .pt-card.pt-force-hover .pt-zonemove { opacity: 1; pointer-events: auto; }
  .pt-zm-btn {
    width: 22px; height: 22px; border-radius: 50%;
    border: 1.5px solid var(--zm-color, var(--border-strong));
    background: var(--bg-2); color: var(--zm-color, var(--text-dim)); cursor: pointer;
    font-size: 11px; line-height: 1; display: flex; align-items: center; justify-content: center;
    padding: 0; flex: 0 0 auto;
  }
  .pt-zm-btn:hover { background: var(--zm-color, var(--bg-hover)); color: var(--bg-0); }
  .pt-zm-btn:disabled { opacity: .35; cursor: default; background: var(--bg-2); color: var(--text-faint); }
  /* PT-P4/PT-P5 — inline SVG glyphs (stack / hand / gravestone) sized to the ring. */
  .pt-zm-btn svg { width: 13px; height: 13px; display: block; }

  /* D6/J10 — dice / coin result readout. FIXED size (fixed width + height,
     centred content) so nothing in the toolbar shifts after a roll/flip. */
  .pt-result {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 0 10px; font-size: var(--fs-sm); color: var(--text-dim);
    width: 132px; height: 26px; box-sizing: border-box;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .pt-result b { color: var(--text); font-weight: 700; font-variant-numeric: tabular-nums; }
  .pt-result.flash { border-color: var(--accent); color: var(--text); }

  .pt-menu {
    position: fixed; z-index: 220; background: var(--bg-2);
    border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
    box-shadow: var(--shadow-2); min-width: 150px; padding: 4px 0; font-size: var(--fs-sm);
  }
  .pt-menu .item { padding: 5px 12px; cursor: pointer; white-space: nowrap; }
  .pt-menu .item:hover { background: var(--bg-hover); }
  .pt-menu .item.dim { color: var(--text-dim); }
  .pt-menu .head { padding: 4px 12px; color: var(--text-faint); font-size: var(--fs-xs);
    text-transform: uppercase; letter-spacing: .04em; }
  .pt-menu .div { height: 1px; background: var(--border); margin: 4px 0; }

  .pt-modal-overlay {
    position: fixed; inset: 0; z-index: 230; background: rgba(0,0,0,.55);
    display: flex; align-items: center; justify-content: center;
  }
  .pt-modal {
    background: var(--bg-1); border: 1px solid var(--border-strong);
    border-radius: var(--radius); box-shadow: var(--shadow-2);
    max-width: 80vw; max-height: 80vh; overflow: auto; padding: var(--sp-4);
  }
  .pt-modal h3 { margin: 0 0 var(--sp-3); }
  /* P5 — View-Library popup header: library identity icon + title together. */
  .pt-modal-head { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-3); }
  .pt-modal-head h3 { margin: 0; }
  .pt-peek-row { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .pt-peek-card { width: 96px; text-align: center; }
  .pt-peek-card .pt-card-inner { aspect-ratio: 63/88; }
  .pt-peek-card .name { font-size: var(--fs-xs); margin-top: 3px; color: var(--text-dim); }
  .pt-peek-card .acts { display: flex; gap: 3px; justify-content: center; margin-top: 3px; }

  /* P5 — View-Library splay: all cards laid out like an open zone, sized by the
     size slider (--pt-card-w), wrapping (NO horizontal scrollbar). Each card
     reuses the standard .pt-card so the per-card hover zone-move controls work
     exactly as they do inside the zones. */
  .pt-lib-splay {
    display: flex; flex-wrap: wrap; gap: var(--sp-2);
    align-content: flex-start; max-width: 100%; overflow-x: hidden;
    padding: 4px;
  }
  .pt-lib-splay .pt-card { width: var(--pt-card-w, 86px); }
  .pt-lib-splay .pt-lib-idx {
    font-size: var(--fs-xs); color: var(--text-dim); text-align: center; margin-top: 2px;
  }

  /* P7 — Life zone (left rail, below Library) with an ORANGE identity icon
     consistent with the other zones' coloured-icon style. */
  .pt-life { font-size: var(--fs-xl); font-weight: 700; }
  .pt-life-zone .pt-life-controls {
    display: flex; align-items: center; justify-content: center; gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .pt-life-zone .pt-life-val {
    min-width: 48px; text-align: center; font-size: var(--fs-xl); font-weight: 700;
    font-variant-numeric: tabular-nums; color: var(--text);
  }
  .pt-life-zone .pt-life-btn {
    background: var(--bg-3); color: var(--text); border: 1px solid var(--pt-zc-life); border-radius: var(--radius-sm);
    width: 30px; height: 30px; cursor: pointer; font-size: 18px; line-height: 1;
  }
  .pt-life-zone .pt-life-btn:hover { background: var(--bg-hover); }

  /* PT1 — real MTG card-back photo (static/img/card-back.webp) instead of a
     CSS gradient recreation. PT2 — translucent/blurred "◆ Reveal" band across
     the bottom (matches the hover "＋ Token"/"＋ Counter" chrome elsewhere in
     this file) to signal it flips face-up on click. (R20) purple outline —
     matches the library pile's blue-outline treatment (--pt-zc-graveyard is
     this file's existing "purple", reused here instead of a new colour). */
  .pt-card-back {
    position: relative; width: 100%; aspect-ratio: 63 / 88; border-radius: 5% / 3.58%;
    background: #000 url("/img/card-back.webp") center/cover no-repeat;
    border: 1.5px solid var(--pt-zc-graveyard); overflow: hidden; cursor: pointer;
  }
  /* (R17) moved from a thin bottom band to a thicker one centred vertically
     on the card. (R20) purple text/border to match, and inset 3px on the
     sides (was flush left/right) so it doesn't sit on top of the new border. */
  .pt-card-back .pt-back-reveal {
    position: absolute; left: 3px; right: 3px; top: 50%; transform: translateY(-50%); z-index: 1;
    display: flex; align-items: center; justify-content: center; gap: 5px;
    background: rgba(10,12,16,.75);
    backdrop-filter: blur(2px);
    color: var(--pt-zc-graveyard);
    font-size: var(--fs-xs); font-weight: 700; letter-spacing: .04em;
    padding: 6px 2px; border-radius: 4px;
  }

  /* PT4 — inclusion overlay: border colour by state + hover bubbles. Reuses the
     deck-builder --state-* colours. */
  .pt-card.pt-incl-locked_in .pt-card-inner { box-shadow: 0 0 0 3px var(--state-locked-in); }
  .pt-card.pt-incl-in        .pt-card-inner { box-shadow: 0 0 0 3px var(--state-in); }
  .pt-card.pt-incl-undecided .pt-card-inner { box-shadow: 0 0 0 2px var(--text-dim); }
  .pt-card.pt-incl-out       .pt-card-inner { box-shadow: 0 0 0 3px var(--state-out); }
  .pt-card.pt-incl-locked_out .pt-card-inner { box-shadow: 0 0 0 3px var(--state-locked-out); }
  /* (R20) centred (was top-right). */
  .pt-incl-bubbles {
    position: absolute; top: 3px; left: 50%; transform: translateX(-50%); z-index: 6;
    display: flex; gap: 3px; padding: 3px; border-radius: 10px;
    background: rgba(10,12,16,.9);
    opacity: 0; transition: opacity 100ms; pointer-events: none;
  }
  .pt-card:hover .pt-incl-bubbles, .pt-card.pt-force-hover .pt-incl-bubbles { opacity: 1; pointer-events: auto; }
  .pt-incl-bubble {
    width: 16px; height: 16px; border-radius: 50%; cursor: pointer; padding: 0;
    border: 1.5px solid var(--ib-color, var(--border-strong)); background: var(--bg-2);
    font-size: 9px; line-height: 1; color: var(--text-dim);
    display: flex; align-items: center; justify-content: center;
  }
  .pt-incl-bubble svg { width: 62%; height: 62%; display: block; }
  .pt-incl-bubble.active { background: var(--ib-color, var(--accent)); color: var(--bg-0); }
  .pt-incl-bubble:hover { border-color: var(--ib-color, var(--accent)); }
  /* (R9 WS10) locked_out keeps its dim grey ring/fill — only the lock glyph
     turns red, matching the workspace's inclusion control. */
  .pt-incl-bubble.active.cs-locked_out { color: var(--danger); }

  /* PT7 — create-token hover button. PT-P3 — the generic "＋ Counter" button
     shares the same look/placement. PT10 adds a "− Token" removal button.
     PT11 — the row sits at the SAME proportional top offset as the stones
     (top: 12%) but RIGHT-justified, so counters (left) and make-controls
     (right) share one band just below the card's printed title. */
  .pt-hover-make {
    /* (R14) nudged down to match .pt-stones — see its comment above. */
    position: absolute; top: calc(12% + 8.5px); right: 4%; left: auto; transform: none;
    z-index: 6; display: flex; flex-direction: column; gap: 3px; align-items: flex-end;
    opacity: 0; transition: opacity 100ms; pointer-events: none;
  }
  .pt-card:hover .pt-hover-make, .pt-card.pt-force-hover .pt-hover-make { opacity: 1; pointer-events: auto; }
  /* PT11 — orange outline + orange text over a dark translucent pill (reuses
     the Life-orange identity colour), mirroring the .pt-zonemove dark-pill
     look instead of a solid accent fill. */
  .pt-hover-make button {
    background: rgba(10,12,16,.78);
    color: var(--pt-zc-life);
    border: 1.3px solid var(--pt-zc-life); border-radius: 8px; padding: 1px 6px; cursor: pointer;
    font-size: 10px; font-weight: 700; line-height: 15px;
  }
  .pt-hover-make button:hover { background: color-mix(in srgb, var(--pt-zc-life) 30%, rgba(10,12,16,.78)); }

  /* PT13 — generic per-card selection highlight + hover toggle control. */
  .pt-card.pt-selected .pt-card-inner { box-shadow: 0 0 0 3px var(--accent), 0 0 10px 2px var(--accent); }
  .pt-select-ctl {
    position: absolute; bottom: 3px; right: 3px; z-index: 4;
    opacity: 0; transition: opacity 100ms;
  }
  .pt-card:hover .pt-select-ctl, .pt-card.pt-force-hover .pt-select-ctl { opacity: 1; }
  .pt-select-ctl button {
    width: 18px; height: 18px; padding: 0; border-radius: 50%; cursor: pointer;
    border: 1px solid var(--border-strong); background: var(--bg-2); color: var(--text);
    font-size: 11px; line-height: 1; display: flex; align-items: center; justify-content: center;
  }
  .pt-card.pt-selected .pt-select-ctl button { background: var(--accent); color: var(--bg-0); border-color: var(--accent); }
  .pt-select-ctl button:hover { background: var(--bg-hover); }
  `;
  document.head.append(style);
}

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "onclick") n.addEventListener("click", v);
    else if (k === "html") n.innerHTML = v;
    else if (k === "style") n.setAttribute("style", v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

function toast(msg) {
  if (window.cdb?.toast) window.cdb.toast(msg);
}

// ---------------------------------------------------------------------------
// RNG / shuffle — Fisher-Yates with Math.random (fine for browser playtest).
// ---------------------------------------------------------------------------
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Playtest session — encapsulates all mutable state + rendering.
// ---------------------------------------------------------------------------
class Playtest {
  constructor(deck) {
    this.deck = deck;
    this.deckName = deck.name || "Untitled";

    // PT5/PT6 — format drives the starting life and whether the Command Zone
    // is shown at all. (R10) Every singleton format with a commander-style card
    // gets the Command Zone — Commander, Oathbreaker, Duel Commander, and Brawl
    // all set a card aside like this (life total still varies by format; see
    // FORMAT_LIFE/startingLife). Mirrors state.js's SINGLETON_FORMATS set.
    const COMMANDER_ZONE_FORMATS = new Set(["commander", "oathbreaker", "duel", "brawl"]);
    this.format = deck.format || "commander";
    this.isCommanderFormat = COMMANDER_ZONE_FORMATS.has(String(this.format).toLowerCase());

    // zones: arrays of card instances. Library order = index 0 is the TOP.
    this.zones = { library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [] };

    this.life = startingLife(this.format);

    // PT4 — inclusion overlay toggle (off by default).
    this.inclusionOverlay = false;
    // (R20) select mode: while on, a plain click on any card toggles its
    // highlight (instead of e.g. tapping a battlefield card).
    this.selectMode = false;
    // PT7 — token list for this deck (fetched once, cached). Map of source card
    // name (lowercase) → array of token defs {name,scryfallId,image}.
    this.tokenBySource = new Map();
    this.loadTokens();
    // PT13 — randomiser mode + current picker options.
    this.randMode = "die";
    this.randDie = 20;
    // PT-P6 — persisted "Select Cards" count (driven by − [n] + controls).
    this.pickCount = 1;
    this.turn = 1;
    this.mulligans = 0;
    this.mana = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    // J1 — card width. Slider now ranges ~120–280 (old max 150 ≈ new min);
    // 280 ≈ the deck builder's max (150 base × 1.8 zoom).
    // R6 — default to the slider midpoint (200) so cards start larger.
    // Persisted across sessions (see loadCardW/saveCardW) — no reason to reset
    // to the default every time the playtester opens.
    this.cardW = loadCardW();

    // Undo: stack of deep snapshots (capped). Simple + robust for a simulator.
    this.undoStack = [];

    this.menuEl = null;
    // J6 — which side is expanded: "center" (Hand+Battlefield, default) or
    // "right" (Graveyard+Exile). The non-focused side collapses to a top-card
    // pile. Both sides render the same way at each size.
    this.focus = "center";
    // D6 — latest dice/coin outcome for the toolbar readout.
    this.lastResult = "";
    this.build();
  }

  // Build card instances from INCLUDED cards, expanded by quantity.
  // (R16) the commander is exempted from the legality filter (only here, for
  // seeding the Command Zone) — most EDHREC-built decks' commanders simply
  // aren't legal in e.g. Brawl's much narrower card pool, so without this the
  // Command Zone silently ended up empty when playtesting a deck under a
  // format other than the one it was actually built for. Everything else
  // (the 99, stats, price, count) still follows "legality trumps inclusion."
  build() {
    const included = this.deck.cards.filter((c) => IN_STATES.has(c.inclusionState) &&
      (isLegal(c, this.deck) || (c.isCommander && this.isCommanderFormat)));
    this.includedCount = included.reduce((n, c) => n + (c.quantity || 1), 0);

    const lib = [];
    const cmd = [];
    for (const entry of included) {
      const qty = entry.quantity || 1;
      for (let i = 0; i < qty; i++) {
        const inst = {
          uid: ++cardSeq,
          name: entry.name,
          scryfallId: entry.scryfallId || null,
          img: null,          // resolved lazily
          imgLoaded: false,
          tapped: false,
          counters: 0,        // +1/+1 counters (P3)
          stones: 0,          // R6 — generic round-stone play markers
          // R6 — bead colour derived from the card's colour identity, used for
          // the round-stone markers on the battlefield.
          beadColor: beadColorFor(entry.colorIdentity),
          // J3 — only the commander instance offers the Command Zone button.
          isCommander: !!entry.isCommander,
          // J8 — carry type info so the battlefield can split lands into a row.
          cardType: entry.cardType || "",
          cardTypes: entry.cardTypes || null,
          // PT4 — thread the real deck-entry id + current inclusion so the
          // inclusion overlay can display + persist state changes. isToken stays
          // false for real deck cards (PT7 tokens set it true).
          entryId: entry.id,
          inclusionState: entry.inclusionState,
          isToken: false,
          // PT13 — generic selection/highlight flag.
          selected: false,
        };
        // PT3/PT5 — commander seeds the Command Zone only in commander format;
        // otherwise it plays from the library like any other card.
        (entry.isCommander && this.isCommanderFormat ? cmd : lib).push(inst);
      }
    }
    this.zones.library = lib;
    this.zones.command = cmd;
  }

  // PT7 — fetch this deck's token list once and index it by source-card name so
  // hovering a card can offer to create the tokens it makes.
  async loadTokens() {
    const id = this.deck?.id;
    if (!id) return;
    try {
      const tokens = await api.deckTokens(id);
      for (const t of tokens || []) {
        if (!t.scryfallId) continue; // skip designation-only entries (no real token card)
        for (const src of t.createdBy || []) {
          const key = String(src).toLowerCase();
          if (!this.tokenBySource.has(key)) this.tokenBySource.set(key, []);
          this.tokenBySource.get(key).push({ name: t.name, scryfallId: t.scryfallId, image: t.image || null });
        }
      }
      if (this.tokenBySource.size && this.overlay) this.render();
    } catch { /* tokens are best-effort */ }
  }

  // ---- snapshot / undo --------------------------------------------------
  snapshot() {
    const z = {};
    for (const k of Object.keys(this.zones)) z[k] = this.zones[k].slice();
    this.undoStack.push({
      zones: z,
      life: this.life,
      turn: this.turn,
      mulligans: this.mulligans,
      mana: { ...this.mana },
      cards: new Map(
        [...Object.values(this.zones)].flat().map((c) => [c.uid, { tapped: c.tapped, counters: c.counters, stones: c.stones || 0, bfRow: c.bfRow || null }])
      ),
    });
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) { toast("Nothing to undo"); return; }
    for (const k of Object.keys(this.zones)) this.zones[k] = snap.zones[k];
    this.life = snap.life;
    this.turn = snap.turn;
    this.mulligans = snap.mulligans;
    this.mana = snap.mana;
    for (const [uid, st] of snap.cards) {
      const card = this.find(uid);
      if (card) {
        card.tapped = st.tapped; card.counters = st.counters; card.stones = st.stones || 0;
        if (st.bfRow) card.bfRow = st.bfRow; else delete card.bfRow;
      }
    }
    this.render();
  }

  // ---- card lookup / movement ------------------------------------------
  find(uid) {
    for (const k of Object.keys(this.zones)) {
      const c = this.zones[k].find((x) => x.uid === uid);
      if (c) return c;
    }
    return null;
  }

  zoneOf(uid) {
    for (const k of Object.keys(this.zones)) {
      if (this.zones[k].some((x) => x.uid === uid)) return k;
    }
    return null;
  }

  remove(uid) {
    for (const k of Object.keys(this.zones)) {
      const i = this.zones[k].findIndex((x) => x.uid === uid);
      if (i >= 0) return this.zones[k].splice(i, 1)[0];
    }
    return null;
  }

  // PT-P8 — only the commander may occupy the Command Zone.
  canEnterCommand(card) {
    return !!(card && card.isCommander && this.isCommanderFormat);
  }

  // target: "hand"|"battlefield"|"graveyard"|"exile"|"command"|"library"|"library-top"|"library-bottom"
  move(uid, target, { record = true } = {}) {
    // PT-P8 — reject moves of non-commanders into the Command Zone.
    if (target === "command" && !this.canEnterCommand(this.find(uid))) {
      toast("Only the commander can go to the Command Zone");
      return;
    }
    if (record) this.snapshot();
    const fromZone = this.zoneOf(uid);
    const card = this.remove(uid);
    if (!card) return;
    // J8 — button-moves auto-place by type: clear any freeform row override so
    // the battlefield partition sorts the card into the correct (land/non-land)
    // row. Dragging into a specific row sets bfRow via moveToIndex instead.
    delete card.bfRow;
    // PT8 — a token permanent leaving the battlefield ceases to exist: drop it
    // from the sim entirely instead of placing it anywhere else.
    if (card.isToken && fromZone === "battlefield" && target !== "battlefield") {
      this.render();
      if (this._libModalRefresh) this._libModalRefresh();
      return;
    }
    // PT9 — counters and play-stones are removed whenever a card changes zones.
    if (target !== fromZone) { card.counters = 0; card.stones = 0; }
    if (target === "library-top") { card.tapped = false; this.zones.library.unshift(card); }
    else if (target === "library-bottom" || target === "library") { card.tapped = false; this.zones.library.push(card); }
    else if (this.zones[target]) {
      if (target !== "battlefield") card.tapped = false;
      this.zones[target].push(card);
    }
    this.render();
    // P5 — keep the View-Library popup (if open) in sync after a move.
    if (this._libModalRefresh) this._libModalRefresh();
  }

  // ---- core actions -----------------------------------------------------
  shuffleLibrary() { shuffle(this.zones.library); }

  drawN(n, { record = true } = {}) {
    if (record) this.snapshot();
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      const card = this.zones.library.shift();
      if (!card) break;
      this.zones.hand.push(card);
      drawn++;
    }
    if (drawn < n) toast("Library is empty");
    this.render();
  }

  // Fresh deal: rebuild the sim from the deck's CURRENT inclusion (so cards
  // marked "out" during play drop, PT4), reset life by format (PT6), send the
  // commander back to the Command Zone (PT3), shuffle, draw 7. Tokens are not
  // rebuilt (they only exist while created — PT8).
  resetDeal({ record = true } = {}) {
    if (record) this.snapshot();
    // PT4 — rebuild library + command from current inclusion. build() rereads
    // deck.cards, so any inclusion changes made via the overlay take effect and
    // "out"/illegal cards are excluded here.
    this.zones = { library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [] };
    this.build();
    this.life = startingLife(this.format); // PT6
    this.mulligans = 0;
    this.turn = 1;
    this.shuffleLibrary();
    this.drawN(7, { record: false });
    if (this.lifeValEl) this.lifeValEl.textContent = String(this.life);
  }

  // London mulligan: shuffle hand back, redraw 7, then bottom N (= mulligans taken).
  mulligan() {
    this.snapshot();
    this.mulligans++;
    for (const c of this.zones.hand) { c.tapped = false; this.zones.library.push(c); }
    this.zones.hand = [];
    this.shuffleLibrary();
    this.drawN(7, { record: false });
    // London: put `mulligans` cards from hand back on the bottom of the library.
    const n = Math.min(this.mulligans, this.zones.hand.length);
    if (n > 0) {
      toast(`London mulligan #${this.mulligans}: put ${n} card${n > 1 ? "s" : ""} on bottom`);
    }
    // Auto-bottom the last N drawn (player can re-order via moves afterward).
    for (let i = 0; i < n; i++) {
      const c = this.zones.hand.pop();
      if (c) this.zones.library.push(c);
    }
    this.render();
  }

  newTurn() {
    this.snapshot();
    this.turn++;
    for (const c of this.zones.battlefield) c.tapped = false;
    this.drawN(1, { record: false });
  }

  tapAll(tapped) {
    this.snapshot();
    for (const c of this.zones.battlefield) c.tapped = tapped;
    this.render();
  }

  toggleTap(uid) {
    const c = this.find(uid);
    if (!c) return;
    this.snapshot();
    c.tapped = !c.tapped;
    this.render();
  }

  adjLife(d) {
    this.snapshot();
    this.life += d;
    // P7 — update the left-rail Life value in place (header no longer holds it).
    if (this.lifeValEl) this.lifeValEl.textContent = String(this.life);
  }
  adjMana(color, d) {
    this.snapshot();
    this.mana[color] = Math.max(0, this.mana[color] + d);
    this.renderToolbar();
  }
  clearMana() { this.snapshot(); for (const k of Object.keys(this.mana)) this.mana[k] = 0; this.renderToolbar(); }

  // PT13 — generic per-card highlight toggle + clear-all.
  toggleSelect(uid) {
    const c = this.find(uid);
    if (!c) return;
    c.selected = !c.selected;
    this.render();
    if (this._libModalRefresh) this._libModalRefresh();
  }
  clearSelections() {
    for (const c of Object.values(this.zones).flat()) c.selected = false;
    this.render();
    if (this._libModalRefresh) this._libModalRefresh();
  }
  // PT13 — Pick: randomly highlight N cards in a zone (adds to the shared
  // `selected` highlight used by the per-card toggle + Clear selections).
  pickRandom(zone, n) {
    const list = this.zones[zone] || [];
    if (!list.length) { this.showResult(`Pick → <b>${ZONES[zone]} empty</b>`); return; }
    for (const c of list) c.selected = false;
    const pool = shuffle(list.slice());
    const k = Math.min(Math.max(1, n), pool.length);
    for (let i = 0; i < k; i++) pool[i].selected = true;
    this.render();
    if (this._libModalRefresh) this._libModalRefresh();
    this.showResult(`Pick → <b>${k} in ${ZONES[zone]}</b>`);
  }

  // PT7 — create a token onto the battlefield from a token def (source is the
  // card that made it, used only for the bead colour).
  createToken(def, source) {
    this.snapshot();
    const inst = {
      uid: ++cardSeq,
      name: def.name,
      scryfallId: def.scryfallId || null,
      img: def.image || null,
      imgLoaded: !!def.image,
      tapped: false,
      counters: 0,
      stones: 0,
      beadColor: source ? source.beadColor : "var(--text-faint)",
      isCommander: false,
      cardType: "",
      cardTypes: null,
      entryId: null,       // tokens have no deck entry
      inclusionState: null,
      isToken: true,        // PT8 — leaving the battlefield removes it
      selected: false,
    };
    this.zones.battlefield.push(inst);
    this.render();
    toast(`Created ${def.name}`);
  }

  // PT4 — the 5 inclusion bubbles shown on hover when the overlay is on. Changing
  // inclusion persists to the real deck entry AND updates the in-sim card. The
  // card stays in the sim until Restart (only visually flagged when set "out").
  inclusionBubblesEl(card) {
    const wrap = el("div", { class: "pt-incl-bubbles" });
    for (const st of INCL_ORDER) {
      const b = el("button", {
        class: "pt-incl-bubble cs-" + st + (card.inclusionState === st ? " active" : ""),
        style: `--ib-color:${INCL_STATE_COLOR[st]}`,
        title: INCL_LABELS[st],
      });
      b.innerHTML = INCL_ICONS[st];
      b.addEventListener("click", (e) => { e.stopPropagation(); this.setInclusion(card, st); });
      wrap.append(b);
    }
    return wrap;
  }
  async setInclusion(card, newState) {
    if (!card.entryId || card.inclusionState === newState) return;
    // Update EVERY in-sim instance of this deck entry, plus the underlying deck
    // entry object, so the change is reflected everywhere (and picked up on
    // Restart's rebuild).
    const prev = card.inclusionState;
    for (const c of Object.values(this.zones).flat()) {
      if (c.entryId === card.entryId) c.inclusionState = newState;
    }
    const entry = this.deck.cards.find((e) => e.id === card.entryId);
    if (entry) entry.inclusionState = newState;
    this.render();
    if (this._libModalRefresh) this._libModalRefresh();
    try {
      await api.updateCard(this.deck.id, card.entryId, { inclusionState: newState });
    } catch (e) {
      // roll back the in-sim + entry state on failure
      for (const c of Object.values(this.zones).flat()) {
        if (c.entryId === card.entryId) c.inclusionState = prev;
      }
      if (entry) entry.inclusionState = prev;
      this.render();
      toast("Couldn't update inclusion: " + e.message);
    }
  }

  // R6 — add/remove a generic round-stone play marker on a card.
  adjStones(uid, d) {
    const c = this.find(uid);
    if (!c) return;
    this.snapshot();
    // (R15) clamp to [0, 12] — the display capped at 8 (now 12, 3 columns x 4
    // rows) but the STORED value had no ceiling, so past 8 (now would be past
    // 12) a "−" click changed the real count but the rendered count never
    // moved, making removal look broken.
    c.stones = Math.max(0, Math.min(12, (c.stones || 0) + d));
    this.render();
  }

  // PT10 — one-click removal of a token from the battlefield (same end result
  // as a token leaving the battlefield via move()/moveToIndex(): it ceases to
  // exist rather than being placed elsewhere).
  removeToken(uid) {
    const c = this.find(uid);
    if (!c || !c.isToken) return;
    const i = this.zones.battlefield.findIndex((x) => x.uid === uid);
    if (i < 0) return;
    this.snapshot();
    this.zones.battlefield.splice(i, 1);
    this.render();
    if (this._libModalRefresh) this._libModalRefresh();
  }

  // ---- image resolution (lazy) -----------------------------------------
  async resolveImg(card, imgEl) {
    if (!card.scryfallId) return;
    if (card.img) { imgEl.src = card.img; return; }
    try {
      const data = await loadCardData(card.scryfallId);
      const url = data?.image?.normal;
      if (url) { card.img = url; card.imgLoaded = true; imgEl.src = url; }
    } catch { /* leave placeholder */ }
  }

  // =======================================================================
  // Rendering
  // =======================================================================
  open() {
    injectStyles();
    this.overlay = el("div", { class: "pt-overlay" });
    this.overlay.style.setProperty("--pt-card-w", this.cardW + "px");

    this.headerEl = el("div", { class: "pt-topbar" });
    this.toolbarEl = el("div", { class: "pt-toolbar" });
    this.mainEl = el("div", { class: "pt-main" });
    this.sideEl = el("div", { class: "pt-side" });      // left: Command Zone
    this.zonesEl = el("div", { class: "pt-zones" });    // centre: Hand/Battlefield (or GY+Exile expand)
    this.railEl = el("div", { class: "pt-rail" });      // right: Library + Graveyard + Exile stacks
    this.mainEl.append(this.sideEl, this.zonesEl, this.railEl);
    this.overlay.append(this.headerEl, this.toolbarEl, this.mainEl);
    document.body.append(this.overlay);

    // initial deal
    this.shuffleLibrary();
    this.drawN(7, { record: false });
    this.undoStack = []; // don't let the opening deal be "undone"

    // global handlers (scoped to this session)
    this._keyHandler = (e) => this.onKey(e);
    document.addEventListener("keydown", this._keyHandler);
    this._docClick = () => this.closeMenu();
    document.addEventListener("click", this._docClick);

    this.render();
  }

  close() {
    document.removeEventListener("keydown", this._keyHandler);
    document.removeEventListener("click", this._docClick);
    this.closeMenu();
    this.overlay.remove();
  }

  onKey(e) {
    if (e.key === "Escape") { this.closeMenu(); return; }
    // ignore when typing in an input
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === "d") { e.preventDefault(); this.drawN(1); }
    else if (k === "u") { e.preventDefault(); this.tapAll(false); }
    else if (k === "t") { e.preventDefault(); this.tapAll(true); }
    else if (k === "n") { e.preventDefault(); this.newTurn(); }
    else if (k === "z") { e.preventDefault(); this.undo(); }
  }

  // (R20) render() rebuilds every card's DOM node from scratch, so clicking a
  // hover-only control (＋/− Counter, ＋ Token — anything that calls render())
  // replaces the very card you're hovering, and CSS :hover doesn't reliably
  // re-match a freshly-inserted element at the same cursor position without
  // the mouse actually moving — the hover-only buttons/rings just vanish
  // ("the card flickers") until you nudge the mouse. Bridge that gap: capture
  // which card was hovered before rebuilding, then force its look with a
  // class instead of waiting on the browser's own hover recalculation; the
  // class self-removes on the next real mouse movement, once native :hover
  // has caught up for real.
  render() {
    const hoveredUid = this.overlay?.querySelector(".pt-card:hover")?.dataset.uid;
    this.renderHeader();
    this.renderToolbar();
    this.renderZones();
    if (hoveredUid) {
      const node = this.overlay.querySelector(`.pt-card[data-uid="${hoveredUid}"]`);
      if (node) {
        node.classList.add("pt-force-hover");
        this.overlay.addEventListener("mousemove", () => node.classList.remove("pt-force-hover"), { once: true });
      }
    }
  }

  // (R17) three-section layout mirroring the main page's #topbar: brand text
  // left, deck title + commander centred, card count + Back button right.
  renderHeader() {
    const h = this.headerEl;
    h.innerHTML = "";
    h.append(
      el("div", { class: "pt-topbar-left" },
        el("span", { class: "pt-brand" }, "MTG Deck Builder | Playtester")),
      el("div", { class: "pt-topbar-center" },
        el("div", { class: "pt-title" }, this.deckName),
        this.deck.commander ? el("div", { class: "pt-commander-sub" }, this.deck.commander) : null),
      el("div", { class: "pt-topbar-right" },
        // (R18) format shown as a reminder alongside the card count.
        el("span", { class: "pt-sub" },
          el("span", { html: `<b>${this.includedCount}</b> Card${this.includedCount === 1 ? "" : "s"}` }),
          ` · ${formatLabel(this.format)}`),
        // P6 — "Back to Deck" lives at the TOP-RIGHT of the playtest top bar.
        el("button", { class: "pt-btn", onclick: () => this.close() }, "Back to Deck →")),
    );
  }

  // PT-P7 — build a labelled toolbar section: an uppercase label row on top and
  // a controls row beneath (mirrors the main gallery's .toolbar-label pattern).
  tbSection(label, ...controls) {
    return el("div", { class: "pt-tb-section" },
      el("div", { class: "pt-tb-label" }, label),
      el("div", { class: "pt-tb-controls" }, ...controls));
  }

  renderToolbar() {
    const t = this.toolbarEl;
    t.innerHTML = "";
    const vsep = () => el("div", { class: "vsep" });

    // PT4/PT5 — GAME: Restart, Mulligan (Untap All / Tap All / Undo moved out —
    // per-card tap/untap remains in the right-click context menu; Undo moves to
    // the Turn section below).
    const gameSec = this.tbSection("Game",
      el("button", { class: "pt-btn primary", onclick: () => { this.resetDeal(); } }, "Restart"),
      el("button", { class: "pt-btn", onclick: () => this.mulligan() }, "Mulligan"),
    );

    // PT-P7/PT5 — TURN: New Turn (+ current turn number) → Undo.
    const turnSec = this.tbSection("Turn",
      el("button", { class: "pt-btn primary", onclick: () => this.newTurn() }, "New Turn"),
      el("span", { class: "pt-turn" },
        el("span", { class: "pt-turn-lbl" }, "#"),
        el("span", { class: "pt-turn-val" }, String(this.turn))),
      el("button", { class: "pt-btn", onclick: () => this.undo() }, "Undo"),
    );

    // PT-P7 — RANDOM: mode select + mode options + action + readout.
    // (R15) plain .pt-btn (not .sm) — these were noticeably shorter than
    // every other toolbar control at the smaller size.
    const modeSel = el("select", { class: "pt-btn" });
    for (const [v, lbl] of [["die", "Roll Die"], ["coin", "Flip Coin"], ["pick", "Select Cards"]]) {
      modeSel.append(el("option", { value: v }, lbl));
    }
    modeSel.value = this.randMode;
    modeSel.addEventListener("change", () => { this.randMode = modeSel.value; this.renderToolbar(); });

    const opts = el("div", { class: "pt-group" });
    let actionBtn;
    if (this.randMode === "die") {
      const diceSel = el("select", { class: "pt-btn" });
      for (const d of [4, 6, 8, 10, 12, 20]) diceSel.append(el("option", { value: String(d) }, "d" + d));
      diceSel.value = String(this.randDie);
      diceSel.addEventListener("change", () => { this.randDie = parseInt(diceSel.value, 10); });
      opts.append(diceSel);
      actionBtn = el("button", { class: "pt-btn", onclick: () => this.rollDie(this.randDie) }, "Roll");
    } else if (this.randMode === "coin") {
      actionBtn = el("button", { class: "pt-btn", onclick: () => this.flipCoin() }, "Flip");
    } else { // pick
      const zoneSel = el("select", { class: "pt-btn" });
      for (const zk of Object.keys(ZONES)) {
        // PT7 — Library and Command Zone are excluded from "Select Cards".
        if (zk === "command" || zk === "library") continue;
        zoneSel.append(el("option", { value: zk }, ZONES[zk]));
      }
      zoneSel.value = "hand";
      // PT-P6 — replace the number input + spinner with − [n] + controls styled
      // like the Mana counters. The count persists on this.pickCount.
      const valEl = el("span", { class: "val" }, String(this.pickCount));
      const setCount = (n) => { this.pickCount = Math.max(1, n); valEl.textContent = String(this.pickCount); };
      const counter = el("div", { class: "pt-counter" },
        el("button", { title: "Fewer", onclick: () => setCount(this.pickCount - 1) }, "−"),
        valEl,
        el("button", { title: "More", onclick: () => setCount(this.pickCount + 1) }, "+"));
      opts.append(zoneSel, counter);
      actionBtn = el("button", { class: "pt-btn",
        onclick: () => this.pickRandom(zoneSel.value, this.pickCount) }, "Pick");
    }
    const randomSec = this.tbSection("Random",
      modeSel, opts, actionBtn,
      el("span", { class: "pt-result", id: "pt-result",
        html: this.lastResult || `<span style="color:var(--text-faint)">— no roll yet —</span>` }),
    );

    // PT-P7 — MANA: the six coloured mana counters + Clear.
    const manaCtl = el("div", { class: "pt-group pt-mana" });
    for (const c of ["W", "U", "B", "R", "G", "C"]) {
      manaCtl.append(
        el("div", { class: "pt-counter" },
          el("button", { onclick: () => this.adjMana(c, -1) }, "−"),
          el("span", { class: "val val-mana-" + c, title: c }, String(this.mana[c])),
          el("button", { onclick: () => this.adjMana(c, 1) }, "+")),
      );
    }
    manaCtl.append(el("button", { class: "pt-btn", onclick: () => this.clearMana() }, "Clear"));
    const manaSec = this.tbSection("Mana", manaCtl);

    // PT-P7/(R20) — MODES (renamed from "Settings", moved to the RIGHT of
    // Mana): Inclusion toggle, Select toggle, Clear selections.
    const settingsSec = this.tbSection("Modes",
      el("button", {
        class: "pt-btn" + (this.inclusionOverlay ? " primary" : ""),
        title: "Show inclusion state + inline change controls on each card",
        onclick: () => { this.inclusionOverlay = !this.inclusionOverlay; this.render(); },
      }, "Inclusion"),
      el("button", {
        class: "pt-btn" + (this.selectMode ? " primary" : ""),
        title: "While on, click any card to toggle its highlight",
        onclick: () => { this.selectMode = !this.selectMode; this.render(); },
      }, "Select"),
      el("button", { class: "pt-btn", title: "Clear all card highlights", onclick: () => this.clearSelections() }, "Clear selections"),
    );

    // PT-P7 — SIZE: the card-size slider.
    const size = el("input", { type: "range", min: "120", max: "280", step: "5", value: String(this.cardW) });
    size.addEventListener("input", () => {
      this.cardW = parseInt(size.value, 10);
      this.overlay.style.setProperty("--pt-card-w", this.cardW + "px");
      saveCardW(this.cardW);
      // P5 — if the View-Library popup is open, resize its splay too (it lives
      // outside .pt-overlay so it doesn't inherit the slider width).
      if (this._libModalOverlay) this._libModalOverlay.style.setProperty("--pt-card-w", this.cardW + "px");
    });
    const sizeSec = this.tbSection("Size", size);

    // PT8 — Game/Turn/Random pack left; a flex spacer eats the remaining width
    // so Mana/Settings/Size pack against the right edge.
    t.append(
      gameSec, vsep(),
      turnSec, vsep(),
      randomSec, vsep(),
      el("div", { class: "pt-tb-spacer" }),
      manaSec, vsep(),
      settingsSec, vsep(),
      sizeSec,
    );
  }

  renderZones() {
    const z = this.zonesEl;
    z.innerHTML = "";
    this.sideEl.innerHTML = "";
    this.railEl.innerHTML = "";

    // J5/P7 — Left rail: Command Zone → Library → Life (life moved below).
    // PT5 — the Command Zone is only shown in the commander format.
    if (this.isCommanderFormat) this.sideEl.append(this.commandZoneEl());
    this.sideEl.append(this.libraryEl(), this.lifeZoneEl());

    // J6 — center (Hand+Battlefield) and right (Graveyard+Exile) panels. The
    // focused side renders ALL its cards; the other collapses to a top-card
    // pile. Both sides use the SAME panel renderer at each size, so a pile is
    // just the expanded view shrunk to its top card. The .pt-main focus class
    // controls which column gets the width.
    const centerExpanded = this.focus === "center";
    this.mainEl.classList.toggle("focus-center", centerExpanded);
    this.mainEl.classList.toggle("focus-right", !centerExpanded);
    this.zonesEl.append(this.panelEl("center", centerExpanded));
    this.railEl.append(this.panelEl("right", !centerExpanded));
  }

  // J6 — a panel is one of two groups of zones. When expanded it shows each
  // zone in full; when collapsed it shows each zone as a clickable top-card
  // pile. Clicking a collapsed panel makes it the focused (expanded) one.
  panelEl(side, expanded) {
    const zones = side === "center"
      ? [["hand", { row: true }], ["battlefield", {}]]
      : [["graveyard", {}], ["exile", {}]];

    if (expanded) {
      const wrap = el("div", { class: "pt-expand" });
      for (const [zone, opts] of zones) wrap.append(this.genericZoneEl(zone, opts));
      return wrap;
    }

    // Collapsed: a clickable column of top-card piles; clicking anywhere in the
    // panel expands it (and collapses the other).
    const wrap = el("div", { class: "pt-expand", style: "cursor:pointer" });
    wrap.title = "Click to expand this panel";
    wrap.addEventListener("click", () => this.setFocus(side));
    for (const [zone] of zones) wrap.append(this.pileEl(zone));
    return wrap;
  }

  setFocus(side) {
    if (this.focus === side) return;
    this.focus = side;
    this.renderZones();
  }

  // J4 — zone header with the zone's coloured identity icon + label + count.
  // R6 — `count` may be a node (or array of nodes) instead of a number, so the
  // battlefield can show two labelled counts (Permanents N · Lands M).
  zoneHeadEl(zone, count) {
    const id = ZONE_IDENTITY[zone];
    const head = el("div", { class: "pt-zone-head" });
    if (id) {
      head.append(el("span", { class: "pt-zone-icon", style: `color:${id.color}` }, zoneIconNode(id)));
    }
    head.append(el("b", {}, ZONES[zone]));
    if (Array.isArray(count)) head.append(...count);
    else head.append(count instanceof Node ? count : `${count}`);
    return head;
  }

  libraryEl() {
    const wrap = el("div", { class: "pt-zone" });
    this.attachDrop(wrap, "library-bottom");
    wrap.append(this.zoneHeadEl("library", this.zones.library.length));
    // D2 — face is clearly a draw affordance with a visible "Click to draw" CTA.
    const face = el("div", { class: "pt-libface", title: "Click to draw · right-click for options" },
      el("b", {}, String(this.zones.library.length)), "cards",
      el("div", { class: "pt-draw-cta" }, el("span", { html: SVG_DRAW }), "Draw"));
    face.addEventListener("click", () => this.drawN(1));
    face.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      this.openMenu(e.clientX, e.clientY, [
        { label: "Draw 1", fn: () => this.drawN(1) },
        { label: "Draw 7", fn: () => this.drawN(7) },
        { label: "View Library", fn: () => this.viewLibrary() },
        { label: "Shuffle", fn: () => this.shuffleLibraryAction() },
      ]);
    });
    wrap.append(face);
    // J7 — clickable affordance below the pile to view ALL library cards in
    // order (opens the existing View Library modal).
    // X4 — wrap the icon and the text in their own spans so the flex `gap`
    // separates them (previously two adjacent text nodes rendered jammed).
    const expand = el("div", { class: "pt-lib-expand", title: "View all library cards in order" },
      el("span", { class: "pt-lib-expand-icon" }, ZONE_IDENTITY.library.icon),
      el("span", {}, "Library"));
    expand.addEventListener("click", () => this.viewLibrary());
    wrap.append(expand);
    // PT2 — Scry button directly below "View Library" (same style as Shuffle):
    // opens the splay with every card except the TOP face-down.
    const scry = el("div", { class: "pt-lib-shuffle", title: "Scry — peek from the top, cards face-down" },
      el("span", { class: "pt-lib-shuffle-icon" }, "◎"),
      el("span", {}, "Scry"));
    scry.addEventListener("click", () => this.viewLibrary({ scry: true }));
    wrap.append(scry);
    // X3 — Shuffle button directly below "View Library", same width as the pile
    // / View-Library control. Reuses the existing shuffle action (D5).
    // R6 — monochrome shuffle glyph (inherits CSS color, tinted library-blue)
    // instead of the multicolour 🔀 emoji; the "Shuffle" word stays white.
    const shuffleBtn = el("div", { class: "pt-lib-shuffle", title: "Shuffle the library" },
      el("span", { class: "pt-lib-shuffle-icon" }, "⇄"),
      el("span", {}, "Shuffle"));
    shuffleBtn.addEventListener("click", () => this.shuffleLibraryAction());
    wrap.append(shuffleBtn);
    return wrap;
  }

  // P7 — Life box in the left rail beneath the Library. Uses the same coloured
  // identity-icon header style as the card zones, with an ORANGE icon.
  lifeZoneEl() {
    const id = ZONE_IDENTITY.life;
    const wrap = el("div", { class: "pt-zone pt-life-zone" });
    const head = el("div", { class: "pt-zone-head" },
      el("span", { class: "pt-zone-icon", style: `color:${id.color}` }, zoneIconNode(id)),
      el("b", {}, "Life"));
    wrap.append(head);
    this.lifeValEl = el("span", { class: "pt-life-val" }, String(this.life));
    wrap.append(
      el("div", { class: "pt-life-controls" },
        el("button", { class: "pt-life-btn", title: "−1 life", onclick: () => this.adjLife(-1) }, "−"),
        this.lifeValEl,
        el("button", { class: "pt-life-btn", title: "+1 life", onclick: () => this.adjLife(1) }, "+")),
    );
    return wrap;
  }

  // J6 — collapsed top-card pile for a zone. Renders the SAME way as the
  // expanded zone but shows only the top card (or "Empty"). Used for whichever
  // panel isn't currently focused.
  pileEl(zone) {
    const list = this.zones[zone];
    const top = list.length ? list[list.length - 1] : null;
    const wrap = el("div", { class: "pt-zone pt-stack" });
    this.attachDrop(wrap, zone);
    wrap.append(this.zoneHeadEl(zone, list.length));

    const face = el("div", { class: "pt-stackface", title: `${ZONES[zone]} — click to expand · drag the top card off` });
    if (top) {
      if (top.scryfallId) {
        const img = el("img", { alt: top.name });
        if (top.img) img.src = top.img; else this.resolveImg(top, img);
        face.append(img);
      } else {
        face.append(el("div", { class: "pt-ph" }, top.name));
      }
      face.append(el("div", { class: "pt-stack-count" }, String(list.length)));
      // PT14 — the top card of a collapsed pile is draggable (same dragstart
      // payload as a normal card) so it can be dragged elsewhere; after it
      // leaves, the re-render reveals the next card beneath it.
      face.draggable = true;
      face.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        e.dataTransfer.setData("text/plain", String(top.uid));
        e.dataTransfer.effectAllowed = "move";
        // PT-P2 — normal-card-sized drag ghost (not the natural-size image).
        this.setCardDragImage(e.dataTransfer, top);
      });
    } else {
      face.append(el("div", { class: "pt-stack-empty" }, "Empty"));
    }
    // Click bubbles up to the panel wrapper, which calls setFocus().
    wrap.append(face);
    return wrap;
  }

  commandZoneEl() {
    const wrap = el("div", { class: "pt-zone" });
    this.attachDrop(wrap, "command");
    wrap.append(this.zoneHeadEl("command", this.zones.command.length));
    // P1/P2/P4 — pile-sized cards (not slider) + fixed-height container so the
    // box doesn't shrink/shift when the commander leaves the Command Zone.
    const cards = el("div", { class: "pt-cards pt-cmd-cards" });
    this.attachReorder(cards, "command");
    if (!this.zones.command.length) cards.append(el("div", { class: "pt-empty" }, "No commander"));
    for (const c of this.zones.command) cards.append(this.cardEl(c, "command"));
    wrap.append(cards);
    return wrap;
  }

  genericZoneEl(zone, { row = false } = {}) {
    const list = this.zones[zone];
    const wrap = el("div", { class: "pt-zone" });
    this.attachDrop(wrap, zone);

    // R6 — the battlefield partitions into permanents + lands; compute it up
    // front so the header can show BOTH counts (Permanents N · Lands M).
    const isBattlefield = zone === "battlefield";
    // J8 — partition by row. A card's row follows its type by default, but a
    // freeform drag can override it (card.bfRow = "land" | "nonland").
    const inLandRow = (c) => c.bfRow ? c.bfRow === "land" : isLandCard(c);
    const nonlands = isBattlefield ? list.filter((c) => !inLandRow(c)) : null;
    const lands = isBattlefield ? list.filter((c) => inLandRow(c)) : null;

    const headCount = isBattlefield
      ? [el("span", { class: "pt-bf-count" }, `Permanents ${nonlands.length}`),
         el("span", { class: "pt-bf-count" }, `Lands ${lands.length}`)]
      : list.length;
    const head = this.zoneHeadEl(zone, headCount);
    const actions = el("div", { class: "pt-zone-actions" });
    if (isBattlefield) {
      actions.append(
        el("button", { class: "pt-btn sm", onclick: () => this.tapAll(false) }, "Untap"),
        el("button", { class: "pt-btn sm", onclick: () => this.tapAll(true) }, "Tap"));
    }
    head.append(actions);
    wrap.append(head);

    if (isBattlefield) {
      // J8 — non-lands on top, lands in their own row beneath. Each row is a
      // drop/reorder target; the underlying battlefield array stays in one
      // piece, partitioned only at render time (stable order within each row).
      const rows = el("div", { class: "pt-bf-rows" });

      const nlCards = el("div", { class: "pt-cards" });
      this.attachReorder(nlCards, zone, "nonland");
      if (!nonlands.length) nlCards.append(el("div", { class: "pt-empty" }, "No permanents"));
      for (const c of nonlands) nlCards.append(this.cardEl(c, zone));

      const landCards = el("div", { class: "pt-cards" });
      this.attachReorder(landCards, zone, "land");
      if (!lands.length) landCards.append(el("div", { class: "pt-empty" }, "No lands"));
      for (const c of lands) landCards.append(this.cardEl(c, zone));

      rows.append(
        el("div", {}, el("div", { class: "pt-bf-row-label" }, "Permanents"), nlCards),
        el("div", { class: "pt-bf-lands" },
          el("div", { class: "pt-bf-row-label" }, "Lands"), landCards),
      );
      wrap.append(rows);
      return wrap;
    }

    const cards = el("div", { class: "pt-cards" + (row ? " row" : "") });
    this.attachReorder(cards, zone);
    if (!list.length) cards.append(el("div", { class: "pt-empty" }, "Empty"));
    for (const c of list) cards.append(this.cardEl(c, zone));
    wrap.append(cards);
    return wrap;
  }

  // PT2 — `faceDown` (scry) renders the card back with a click-to-flip handler
  // (supplied by the caller) instead of the art + controls.
  cardEl(card, zone, { faceDown = false, onFlip = null } = {}) {
    let cls = "pt-card" + (card.tapped ? " tapped" : "");
    // PT13 — generic selection highlight.
    if (card.selected) cls += " pt-selected";
    // PT4 — inclusion overlay: colour the border by the card's stored inclusion.
    if (this.inclusionOverlay && card.inclusionState) cls += " pt-incl-" + card.inclusionState;
    const node = el("div", { class: cls, title: card.name });
    node.dataset.uid = String(card.uid);
    node.draggable = true;

    // PT2/PT-P9 — face-down scry card: MTG-style back with a purple "◆ Reveal"
    // band across the bottom; clicking flips it face-up.
    if (faceDown) {
      const back = el("div", { class: "pt-card-back", title: "Face-down — click to reveal" },
        el("div", { class: "pt-back-reveal" }, "◆ Reveal"));
      back.addEventListener("click", (e) => { e.stopPropagation(); if (onFlip) onFlip(); });
      node.append(back);
      node.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(card.uid));
        e.dataTransfer.effectAllowed = "move";
        // PT-P2 — card-sized drag ghost (face-down card carries no art here, so
        // the placeholder shows the name).
        this.setCardDragImage(e.dataTransfer, card);
        node.classList.add("dragging");
      });
      node.addEventListener("dragend", () => node.classList.remove("dragging"));
      return node;
    }

    const inner = el("div", { class: "pt-card-inner" });
    if (card.scryfallId) {
      const img = el("img", { alt: card.name });
      if (card.img) img.src = card.img;
      else this.resolveImg(card, img);
      inner.append(img);
    } else {
      inner.append(el("div", { class: "pt-ph" }, card.name));
    }
    node.append(inner);

    // R6/PT-P3 — generic round-stone counters (battlefield only): upper-left,
    // two columns, max 8 shown, tinted to the card's colour. Adds/removes both
    // happen via the "＋ Counter"/"− Counter" hover buttons below (R14 —
    // consolidated out of a separate .pt-stones-ctl button here).
    if (zone === "battlefield" && card.stones > 0) {
      const stones = el("div", { class: "pt-stones" });
      for (let i = 0; i < Math.min(12, card.stones); i++) {
        stones.append(el("span", { class: "pt-stone", style: `--bead:${card.beadColor || "var(--text-faint)"}` }));
      }
      node.append(stones);
    }

    // D4 — hover zone-move control (round buttons, deck-builder look).
    node.append(this.zoneMoveEl(card, zone));

    // PT4 — inclusion bubbles (only when the overlay is on and the card maps to
    // a real deck entry — created tokens have no entryId).
    if (this.inclusionOverlay && card.entryId) {
      node.append(this.inclusionBubblesEl(card));
    }

    // PT7/PT-P3/PT10/R14 — hover "make" buttons (top row, right-justified —
    // PT11): "＋ Counter"/"− Counter" (battlefield only, remove needs stones>0),
    // "＋ Token" (when this card's name makes tokens), and "− Token" (when this
    // card IS a token on the battlefield — removes it from play outright,
    // regardless of whether it also makes tokens itself).
    const tokenDefs = this.tokenBySource.get(String(card.name).toLowerCase());
    const wantCounter = zone === "battlefield";
    const wantRemoveCounter = zone === "battlefield" && card.stones > 0;
    const wantRemoveToken = card.isToken === true && zone === "battlefield";
    if (wantCounter || wantRemoveCounter || (tokenDefs && tokenDefs.length) || wantRemoveToken) {
      const make = el("div", { class: "pt-hover-make" });
      if (wantCounter) {
        make.append(el("button", { title: "Add a counter",
          onclick: (e) => { e.stopPropagation(); this.adjStones(card.uid, 1); } }, "＋ Counter"));
      }
      if (wantRemoveCounter) {
        make.append(el("button", { title: "Remove a counter",
          onclick: (e) => { e.stopPropagation(); this.adjStones(card.uid, -1); } }, "− Counter"));
      }
      if (tokenDefs && tokenDefs.length === 1) {
        make.append(el("button", { title: `Create ${tokenDefs[0].name} token`,
          onclick: (e) => { e.stopPropagation(); this.createToken(tokenDefs[0], card); } }, "＋ Token"));
      } else if (tokenDefs && tokenDefs.length > 1) {
        make.append(el("button", { title: "Create a token this card makes",
          onclick: (e) => {
            e.stopPropagation();
            this.openMenu(e.clientX, e.clientY, tokenDefs.map((td) => ({
              label: "Create " + td.name, fn: () => this.createToken(td, card),
            })));
          } }, "＋ Token"));
      }
      if (wantRemoveToken) {
        make.append(el("button", { title: "Remove this token from play",
          onclick: (e) => { e.stopPropagation(); this.removeToken(card.uid); } }, "− Token"));
      }
      node.append(make);
    }

    // PT13 — generic per-card highlight toggle.
    const selCtl = el("div", { class: "pt-select-ctl" },
      el("button", { title: card.selected ? "Remove highlight" : "Highlight this card",
        onclick: (e) => { e.stopPropagation(); this.toggleSelect(card.uid); } }, "★"));
    node.append(selCtl);

    // left click: in Select mode, toggle highlight (any zone) — otherwise the
    // usual battlefield tap/untap.
    node.addEventListener("click", (e) => {
      if (this.selectMode) { e.stopPropagation(); this.toggleSelect(card.uid); return; }
      if (zone === "battlefield") { e.stopPropagation(); this.toggleTap(card.uid); }
    });
    // X1 — double-click a Hand card → move it to the Battlefield. move() clears
    // any bfRow override, so the battlefield partition auto-places it into the
    // lands row (lands) or the permanents row (everything else), exactly like
    // the per-card "→ Battlefield" button does.
    if (zone === "hand" || zone === "command") {
      // X1 — double-click a Hand card → Battlefield. PT10 — same for a commander
      // in the Command Zone.
      node.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.move(card.uid, "battlefield");
      });
    } else if (zone === "library" || zone === "graveyard" || zone === "exile") {
      // X1 — double-click a card in the View-Library splay → Hand.
      // PT11 — double-click a Graveyard/Exile card → return to Hand.
      node.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.move(card.uid, "hand");
      });
    }
    // right click = context menu
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      this.openCardMenu(e.clientX, e.clientY, card, zone);
    });

    // drag and drop
    node.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(card.uid));
      e.dataTransfer.effectAllowed = "move";
      // PT-P2 — hand the browser a drag ghost sized to a normal on-screen card
      // (--pt-card-w) rather than the natural-size image.
      this.setCardDragImage(e.dataTransfer, card);
      node.classList.add("dragging");
    });
    node.addEventListener("dragend", () => node.classList.remove("dragging"));

    return node;
  }

  // D4/J3/J4 — hover control with a button per destination zone. The button
  // for the card's CURRENT zone is disabled. Each button uses the destination
  // zone's identity colour + icon (consistent across ALL zones). The Command
  // Zone button is shown ONLY on the commander card (J3).
  zoneMoveEl(card, zone) {
    // [moveTarget, identityZoneKey, svgOverride?, titleOverride?, labelOverride?]
    // PT1/PT-P4 — dedicated top/bottom-of-library buttons using the "stack of
    // rectangles" icons (top-filled = to top, bottom-filled = to bottom).
    const defs = [
      ["hand", "hand"],
      ["battlefield", "battlefield"],
      ["graveyard", "graveyard"],
      ["exile", "exile"],
      ["library-top", "library", SVG_LIB_TOP, "Move to top of Library"],
      ["library-bottom", "library", SVG_LIB_BOTTOM, "Move to bottom of Library"],
      ["command", "command"],
    ];
    const ctrl = el("div", { class: "pt-zonemove" });
    for (const [target, idKey, svgOverride, titleOverride] of defs) {
      // J3/PT5/PT-P8 — Command Zone destination only for the commander in
      // commander format (only the commander may occupy the Command Zone).
      if (idKey === "command" && (!card.isCommander || !this.isCommanderFormat)) continue;
      const id = ZONE_IDENTITY[idKey];
      const label = ZONES[idKey];
      // The library buttons stay enabled even inside the library (top vs bottom
      // are meaningfully different placements); other zones disable when "here".
      const here = idKey === zone && idKey !== "library";
      const btn = el("button", {
        class: "pt-zm-btn zm-" + target,
        style: `--zm-color:${id.color}`,
        title: here ? `Already in ${label}` : (titleOverride || `Move to ${label}`),
      });
      // PT-P4/PT-P5 — prefer an SVG glyph (stack icons, Hand, Graveyard);
      // fall back to the zone's text glyph otherwise.
      if (svgOverride) btn.innerHTML = svgOverride;
      else if (id.svg) btn.innerHTML = id.svg;
      else btn.textContent = id.icon;
      if (here) {
        btn.disabled = true;
      } else {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.move(card.uid, target);
        });
      }
      ctrl.append(btn);
    }
    return ctrl;
  }

  // PT-P2 — build a drag ghost the SAME size as a normal on-screen card
  // (--pt-card-w) instead of letting the browser synthesise an oversized image
  // from the natural-size <img>. The element is appended off-screen, handed to
  // setDragImage, then removed on the next tick (once the browser has snapshotted
  // it). `src` may be an image URL or null (falls back to a placeholder).
  setCardDragImage(dataTransfer, card) {
    if (!dataTransfer || !dataTransfer.setDragImage) return;
    const w = this.cardW || 86;
    const ghost = el("div", {
      style: `position:fixed;top:-10000px;left:-10000px;width:${w}px;aspect-ratio:63/88;` +
             "border-radius:5% / 3.58%;overflow:hidden;background:var(--bg-3);" +
             "border:1px solid var(--border-strong);pointer-events:none;",
    });
    if (card.img) {
      ghost.append(el("img", { src: card.img, alt: "",
        style: "width:100%;height:100%;object-fit:cover;display:block;" }));
    } else {
      ghost.append(el("div", {
        style: "width:100%;height:100%;display:flex;align-items:center;justify-content:center;" +
               "font-size:11px;color:var(--text-dim);text-align:center;padding:4px;",
      }, card.name || ""));
    }
    document.body.append(ghost);
    try { dataTransfer.setDragImage(ghost, Math.round(w / 2), Math.round((w * 88 / 63) / 2)); } catch { /* ignore */ }
    setTimeout(() => ghost.remove(), 0);
  }

  attachDrop(wrap, target) {
    wrap.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      wrap.classList.add("drop-hover");
    });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("drop-hover"));
    wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      wrap.classList.remove("drop-hover");
      const uid = parseInt(e.dataTransfer.getData("text/plain"), 10);
      // If a card-row inside handled this drop with a position, don't double-move.
      if (e._ptReordered) return;
      if (uid && this.zoneOf(uid) !== target) this.move(uid, target);
    });
  }

  // J9 — drag-to-reorder within a zone AND drop-into-a-specific-position when
  // moving between zones. Attached to a `.pt-cards` container; it figures out
  // the insertion index from the pointer's position relative to the card
  // elements, shows a before/after indicator, and on drop inserts at that
  // index. The mapping zoneKey is the underlying zone array (battlefield rows
  // both map to "battlefield"; the index is resolved against that array).
  attachReorder(cards, zone, bfRow = null) {
    const clearMarks = () => {
      for (const c of cards.querySelectorAll(".pt-card"))
        c.classList.remove("drop-before", "drop-after");
    };
    // Returns { refUid, after } describing where to insert relative to a card,
    // or null (empty zone) to append at the end.
    // (R15) When a zone wraps into multiple rows (flex-wrap), this used to
    // scan every card in DOM order and match on X alone for the "insert
    // before" case — so a card on row 2/3 whose horizontal midpoint was past
    // the pointer's X would match first even though the pointer was hovering
    // a completely different row, always resolving into row 1. Fixed: first
    // find the row whose vertical band the pointer is actually closest to,
    // then only compare X within that row's cards.
    const locate = (e) => {
      const kids = [...cards.querySelectorAll(".pt-card")];
      if (!kids.length) return null;
      const rects = kids.map((kid) => ({ kid, r: kid.getBoundingClientRect() }));
      let nearest = rects[0], nearestDist = Infinity;
      for (const item of rects) {
        const mid = (item.r.top + item.r.bottom) / 2;
        const dist = Math.abs(e.clientY - mid);
        if (dist < nearestDist) { nearestDist = dist; nearest = item; }
      }
      // Cards sharing the same wrapped row line up almost exactly on `top`.
      const row = rects.filter((item) => Math.abs(item.r.top - nearest.r.top) < 4);
      for (const item of row) {
        if (e.clientX < item.r.left + item.r.width / 2) {
          return { refUid: parseInt(item.kid.dataset.uid, 10), after: false };
        }
      }
      const last = row[row.length - 1];
      return { refUid: parseInt(last.kid.dataset.uid, 10), after: true };
    };

    cards.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      clearMarks();
      const loc = locate(e);
      if (loc) {
        const node = cards.querySelector(`.pt-card[data-uid="${loc.refUid}"]`);
        if (node) node.classList.add(loc.after ? "drop-after" : "drop-before");
      }
    });
    cards.addEventListener("dragleave", (e) => {
      if (e.target === cards) clearMarks();
    });
    cards.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e._ptReordered = true; // signal to the enclosing zone's attachDrop
      clearMarks();
      const uid = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (!uid) return;
      const loc = locate(e);
      let index = this.zones[zone].length; // default: end
      if (loc) {
        const refIdx = this.zones[zone].findIndex((c) => c.uid === loc.refUid);
        if (refIdx >= 0) index = loc.after ? refIdx + 1 : refIdx;
      }
      this.moveToIndex(uid, zone, index, bfRow);
    });
  }

  // J9 — move a card into `zone` at a specific index. Handles the same-zone
  // reorder case (index adjusts for the removed card) and cross-zone inserts.
  // bfRow ("land"|"nonland"|null) is a freeform battlefield-row override set
  // when the user drags a card directly into a specific row (J8).
  moveToIndex(uid, zone, index, bfRow = null) {
    if (!this.zones[zone]) return;
    // PT-P8 — only the commander may be dropped into the Command Zone.
    if (zone === "command" && !this.canEnterCommand(this.find(uid))) {
      toast("Only the commander can go to the Command Zone");
      return;
    }
    const fromZone = this.zoneOf(uid);
    if (fromZone == null) return;
    this.snapshot();
    // Remove from wherever it is.
    const fromArr = this.zones[fromZone];
    const fromIdx = fromArr.findIndex((c) => c.uid === uid);
    if (fromIdx < 0) { this.undoStack.pop(); return; }
    const [card] = fromArr.splice(fromIdx, 1);
    // PT8 — a token dragged off the battlefield leaves the game entirely.
    if (card.isToken && fromZone === "battlefield" && zone !== "battlefield") {
      this.render();
      if (this._libModalRefresh) this._libModalRefresh();
      return;
    }
    // If reordering within the same zone and the original position was before
    // the target, the target index shifts left by one after removal.
    if (fromZone === zone && fromIdx < index) index--;
    // Tapped state resets when leaving the battlefield (matches move()).
    if (zone !== "battlefield" && fromZone === "battlefield") card.tapped = false;
    // PT9 — counters + stones clear on a zone change (not a same-zone reorder).
    if (zone !== fromZone) { card.counters = 0; card.stones = 0; }
    // J8 — freeform row placement only on the battlefield; clear it otherwise
    // so a card returning later auto-sorts by type again.
    if (zone === "battlefield") {
      if (bfRow) card.bfRow = bfRow;
    } else {
      delete card.bfRow;
    }
    index = Math.max(0, Math.min(index, this.zones[zone].length));
    this.zones[zone].splice(index, 0, card);
    this.render();
    // PT-P10 — keep the View-Library / Scry splay in sync after a reorder or a
    // move into the library.
    if (this._libModalRefresh) this._libModalRefresh();
  }

  // ---- context menus ----------------------------------------------------
  openCardMenu(x, y, card, zone) {
    const items = [{ head: card.name }];
    for (const [t, label] of MOVE_TARGETS) {
      const cur = (t === "library-top" || t === "library-bottom") ? "library" : t;
      // PT5/PT-P8 — Command Zone target only for the commander (and only in the
      // commander format).
      if (t === "command" && !this.canEnterCommand(card)) continue;
      // PT1 — even when the card is already in the library, still offer
      // "to bottom" (a meaningful reposition); only skip "to top" as a no-op.
      if (cur === zone && t !== "library-bottom") continue;
      items.push({ label: "→ " + label, fn: () => this.move(card.uid, t) });
    }
    items.push({ div: true });
    // PT-P3 — generic counters (the round-stone markers) are battlefield-only.
    // Adds happen via the hover "＋ Counter" button; removal is offered here.
    if (zone === "battlefield") {
      items.push({ label: card.tapped ? "Untap" : "Tap", fn: () => this.toggleTap(card.uid) });
      items.push({ label: "Add counter", fn: () => this.adjStones(card.uid, 1) });
      if (card.stones > 0) items.push({ label: "Remove counter", fn: () => this.adjStones(card.uid, -1) });
    }
    // (R15) token create/remove — mirrors the hover "＋ Token"/"− Token"
    // buttons, which weren't reachable from the right-click menu at all.
    const tokenDefs = this.tokenBySource.get(String(card.name).toLowerCase());
    if (tokenDefs && tokenDefs.length) {
      for (const td of tokenDefs) {
        items.push({ label: "Create " + td.name + " token", fn: () => this.createToken(td, card) });
      }
    }
    if (card.isToken === true && zone === "battlefield") {
      items.push({ label: "Remove this token from play", fn: () => this.removeToken(card.uid) });
    }
    this.openMenu(x, y, items);
  }

  openMenu(x, y, items) {
    this.closeMenu();
    const menu = el("div", { class: "pt-menu" });
    for (const it of items) {
      if (it.head) { menu.append(el("div", { class: "head" }, it.head)); continue; }
      if (it.div) { menu.append(el("div", { class: "div" })); continue; }
      const item = el("div", { class: "item" + (it.dim ? " dim" : "") }, it.label);
      item.addEventListener("click", (e) => { e.stopPropagation(); this.closeMenu(); it.fn(); });
      menu.append(item);
    }
    document.body.append(menu);
    // keep on screen
    const r = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - r.width - 6);
    const py = Math.min(y, window.innerHeight - r.height - 6);
    menu.style.left = Math.max(4, px) + "px";
    menu.style.top = Math.max(4, py) + "px";
    this.menuEl = menu;
  }

  closeMenu() {
    if (this.menuEl) { this.menuEl.remove(); this.menuEl = null; }
  }

  // ---- shuffle action (D5) ---------------------------------------------
  shuffleLibraryAction() {
    this.snapshot();
    this.shuffleLibrary();
    this.render();
    toast("Library shuffled");
  }

  // ---- View Library (D7 / P5) -------------------------------------------
  // Splays ALL library cards in current order (top → bottom) like an open zone:
  // cards are sized by the size slider (--pt-card-w), the layout WRAPS (no
  // horizontal scrollbar), the library identity icon is shown, and each card
  // carries the standard per-card zone-move controls so it can be moved out of
  // the library straight from the popup.
  viewLibrary({ scry = false } = {}) {
    // PT2 — in scry mode every card except the TOP starts face-down; a set of
    // revealed uids tracks which the player has flipped face-up.
    const revealed = new Set();
    if (scry && this.zones.library.length) revealed.add(this.zones.library[0].uid);
    const overlay = el("div", { class: "pt-modal-overlay" });
    // P5 — the modal is appended to <body> (outside .pt-overlay), so propagate
    // the size-slider width + zone identity colours it needs to render cards.
    overlay.style.setProperty("--pt-card-w", this.cardW + "px");
    overlay.style.setProperty("--pt-zc-command", "#e0b341");
    overlay.style.setProperty("--pt-zc-hand", "#3fb950");
    overlay.style.setProperty("--pt-zc-battlefield", "#f0566b");
    overlay.style.setProperty("--pt-zc-library", "#4c9aff");
    overlay.style.setProperty("--pt-zc-graveyard", "#b07bd9");
    overlay.style.setProperty("--pt-zc-exile", "#e8e8ec");
    this._libModalOverlay = overlay;
    const close = () => { this._libModalRefresh = null; this._libModalOverlay = null; overlay.remove(); };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

    const modal = el("div", { class: "pt-modal" });
    // P5 — header with the Library identity icon next to the title.
    const id = ZONE_IDENTITY.library;
    const titleEl = el("h3", {});
    modal.append(el("div", { class: "pt-modal-head" },
      el("span", { class: "pt-zone-icon", style: `color:${id.color}` }, zoneIconNode(id)),
      titleEl));

    const splay = el("div", { class: "pt-lib-splay" });
    modal.append(splay);
    // PT-P10 — allow drag-to-reorder of the library within the splay (works
    // while scrying too). The splay is rendered top→bottom and maps to the
    // "library" zone array, so reordering updates the real library order.
    // Attached once to the persistent splay element (renderSplay only replaces
    // its children).
    this.attachReorder(splay, "library");

    // P5 — rebuild the splay in place (used on first render and after any move
    // out of the library, so the popup stays in sync without reopening).
    const renderSplay = () => {
      const cards = this.zones.library;
      titleEl.textContent = scry
        ? `Scry — ${cards.length} card${cards.length === 1 ? "" : "s"}`
        : `Library — ${cards.length} card${cards.length === 1 ? "" : "s"}`;
      splay.innerHTML = "";
      if (!cards.length) {
        splay.append(el("div", { class: "pt-empty" }, "Library is empty"));
        return;
      }
      cards.forEach((card, i) => {
        // Reuse the standard card element so the hover zone-move controls behave
        // exactly as they do in the zones (the Library button is auto-disabled
        // since the card is already in the library).
        // PT2 — scry: cards not yet revealed render face-down; clicking flips.
        const faceDown = scry && !revealed.has(card.uid);
        const cell = el("div", {});
        const node = this.cardEl(card, "library", faceDown
          ? { faceDown: true, onFlip: () => { revealed.add(card.uid); renderSplay(); } }
          : {});
        cell.append(node, el("div", { class: "pt-lib-idx" }, `${i + 1}`));
        splay.append(cell);
      });
    };
    // Expose the refresher so move() can keep the popup in sync.
    this._libModalRefresh = renderSplay;
    renderSplay();

    overlay.append(modal);
    document.body.append(overlay);
  }

  // ---- dice / coin (D6 — visible readout) -------------------------------
  // Update the readout in place so the die selector keeps its value.
  showResult(html) {
    this.lastResult = html;
    const out = this.toolbarEl?.querySelector("#pt-result");
    if (out) {
      out.innerHTML = html;
      out.classList.add("flash");
      clearTimeout(this._resultTimer);
      this._resultTimer = setTimeout(() => out.classList.remove("flash"), 600);
    }
    toast(html.replace(/<[^>]+>/g, ""));
  }
  rollDie(sides) {
    const r = 1 + Math.floor(Math.random() * sides);
    this.showResult(`d${sides} → <b>${r}</b>`);
  }
  flipCoin() {
    this.showResult(`Coin → <b>${Math.random() < 0.5 ? "Heads" : "Tails"}</b>`);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
let activeSession = null;

export function openPlaytest() {
  const deck = getState().deck;
  if (!deck) { toast("Open a deck first"); return; }
  if (activeSession) { activeSession.close(); activeSession = null; }

  const session = new Playtest(deck);
  if (session.includedCount === 0) {
    toast("No included cards to play — mark some cards In first");
    return;
  }
  // wrap close so we clear the module reference
  const origClose = session.close.bind(session);
  session.close = () => { origClose(); if (activeSession === session) activeSession = null; };
  activeSession = session;
  session.open();
}

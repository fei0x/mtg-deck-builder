// state.js — single app-state object with a tiny pub/sub.
// Components subscribe(render) and call setState(patch) to trigger re-render.
// UI preferences (not deck data) persist to localStorage.

const LS_KEY = "cdb.ui";

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || {};
  } catch {
    return {};
  }
}

const prefs = loadPrefs();

const state = {
  // data
  decks: [],            // [{id,name,commander,inDeckCount,totalCount}]
  currentDeckId: prefs.currentDeckId || null,
  deck: null,           // full current deck object
  // view
  bucketingMode: "tag", // tag | type | cost | rarity | pt
  selectedCardId: null,
  drawerOpen: false,
  drawerView: null,     // 'card' | 'search' | null
  // ui prefs (persisted)
  zoom: prefs.zoom ?? 1,
  showInfoStrip: prefs.showInfoStrip ?? true,
  inclusionSort: prefs.inclusionSort ?? true,
  currency: prefs.currency || "CAD",   // CAD | USD
  // transient
  fxRate: 1.36,                          // USD->CAD (refreshed from /api/fx at boot)
  fxSource: "fallback",
  loading: false,
  loadingMsg: null,                      // context label for the loading spinner
  saveStatus: "idle",                    // idle | saving | saved | error (U2 Save indicator)
  toast: null,
};

const PERSIST_KEYS = ["currentDeckId", "zoom", "showInfoStrip", "inclusionSort", "currency"];
const listeners = new Set();

function persist() {
  const out = {};
  for (const k of PERSIST_KEYS) out[k] = state[k];
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(out));
  } catch {
    /* ignore quota errors */
  }
}

export function getState() {
  return state;
}

export function setState(patch) {
  Object.assign(state, patch);
  persist();
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Convenience: derived deck count from the loaded deck (source of truth = inclusion state).
const IN_STATES = new Set(["locked_in", "in"]);

// Is a card legal for the deck's current format? Unknown legality → legal.
export function isLegal(entry, deck = state.deck) {
  const fmt = deck?.format || "commander";
  const leg = entry.legalities;
  if (leg && typeof leg === "object" && Object.keys(leg).length) return leg[fmt] === "legal";
  if (typeof entry.commanderLegal === "boolean" && fmt === "commander") return entry.commanderLegal;
  return true;
}

// Copy limits (WS1): singleton formats allow 1 of each card, 60-card formats 4.
const SINGLETON_FORMATS = new Set(["commander", "oathbreaker", "duel", "brawl"]);
const BASIC_LANDS = new Set(["plains", "island", "swamp", "mountain", "forest", "wastes"]);
export function copyLimit(format) {
  return SINGLETON_FORMATS.has(format || "commander") ? 1 : 4;
}
// Does this card exceed its format's copy limit? Basic lands + "any number" cards exempt.
export function overCopyLimit(entry, deck = state.deck) {
  const qty = entry.quantity || 1;
  if (qty <= copyLimit(deck?.format)) return false;
  const name = (entry.name || "").toLowerCase();
  if (BASIC_LANDS.has(name) || name.startsWith("snow-covered ")) return false;
  if ((entry.oracleText || "").toLowerCase().includes("any number of cards named")) return false;
  return true;
}

export function inDeckCount(deck = state.deck) {
  if (!deck) return 0;
  return deck.cards
    .filter((c) => IN_STATES.has(c.inclusionState) && isLegal(c, deck))
    .reduce((n, c) => n + (c.quantity || 1), 0);
}
export function deckPrice(deck = state.deck) {
  if (!deck) return 0;
  let t = 0;
  for (const c of deck.cards) {
    if (!IN_STATES.has(c.inclusionState) || !isLegal(c, deck)) continue;
    const usd = parseFloat(c.price?.usd);
    if (!isNaN(usd)) t += usd * (c.quantity || 1);
  }
  return Math.round(t * 100) / 100; // always USD base
}

// Format a USD price string in the active currency (CAD via fxRate, or USD).
export function formatPrice(usd) {
  const v = parseFloat(usd);
  if (isNaN(v)) return null;
  if (state.currency === "USD") return `$${v.toFixed(2)}`;
  return `C$${(v * state.fxRate).toFixed(2)}`;
}
// Deck total in the active currency (number).
export function deckPriceDisplay(deck = state.deck) {
  const usd = deckPrice(deck);
  return state.currency === "USD" ? usd : Math.round(usd * state.fxRate * 100) / 100;
}

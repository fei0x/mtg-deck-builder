// api.js — thin wrapper over the /api REST surface (Contract B in plan/00).
// All network access goes through here; throws Error({message}) on non-2xx.

const BASE = "/api";

// --- write tracking (U2: Save dirty/saving indicator) ---------------------- //
// Every persistence call routes through tracked() so the topbar can show
// "Saving…/Saved/● Unsaved" without each call site wiring it. app.js registers
// the listener at boot; it receives "start" | "ok" | "error".
let _writeListener = null;
export function onApiWrite(fn) { _writeListener = fn; }
function tracked(p) {
  if (_writeListener) _writeListener("start");
  return p.then(
    (r) => { if (_writeListener) _writeListener("ok"); return r; },
    (e) => { if (_writeListener) _writeListener("error"); throw e; },
  );
}

async function request(path, { method = "GET", body, query } = {}) {
  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += "?" + qs;
  }
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const ct = resp.headers.get("content-type") || "";
  const data = ct.includes("json") ? await resp.json() : await resp.text();
  if (!resp.ok) {
    const msg = (data && data.error) || `Request failed (${resp.status})`;
    const err = new Error(msg);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request("/health"),

  // Decks
  listDecks: () => request("/decks").then((d) => d.decks),
  createDeck: (payload) => request("/decks", { method: "POST", body: payload }),
  getDeck: (id) => request(`/decks/${id}`),
  saveDeck: (deck) => tracked(request(`/decks/${deck.id}`, { method: "PUT", body: deck })),
  patchDeck: (id, patch) => tracked(request(`/decks/${id}`, { method: "PATCH", body: patch })),
  deleteDeck: (id) => request(`/decks/${id}`, { method: "DELETE" }),

  // Cards in a deck (build workflow — 04). Mutations are write-tracked (U2).
  addCard: (deckId, payload) => tracked(request(`/decks/${deckId}/cards`, { method: "POST", body: payload })),
  updateCard: (deckId, cardId, patch) =>
    tracked(request(`/decks/${deckId}/cards/${cardId}`, { method: "PATCH", body: patch })),
  removeCard: (deckId, cardId) =>
    tracked(request(`/decks/${deckId}/cards/${cardId}`, { method: "DELETE" })),
  refineTags: (deckId, opts) => tracked(request(`/decks/${deckId}/refine-tags`, { method: "POST", body: opts || {} })),
  reenrich: (deckId) => tracked(request(`/decks/${deckId}/reenrich`, { method: "POST" })),
  reprice: (deckId) => tracked(request(`/decks/${deckId}/reprice`, { method: "POST" })),
  addEdhrecForCard: (deckId, card) => tracked(request(`/decks/${deckId}/add-edhrec-card`, { method: "POST", body: { card } })),
  refreshMeta: (deckId) => tracked(request(`/decks/${deckId}/reprice`, { method: "POST", query: { meta_only: 1 } })),
  reloadEdhrec: (deckId) => tracked(request(`/decks/${deckId}/reload-edhrec`, { method: "POST" })),
  enrichCard: (deckId, cardId) =>
    request(`/decks/${deckId}/cards/${cardId}/enrich`, { method: "POST" }),

  // Card data (Scryfall proxy — 02)
  autocomplete: (q) => request("/cards/autocomplete", { query: { q } }).then((d) => d.data),
  search: (q, opts = {}) => request("/cards/search", { query: { q, ...opts } }).then((d) => d.cards),
  cardDetail: (id) => request(`/cards/${id}`),
  printings: (id) => request(`/cards/${id}/printings`).then((d) => d.printings),
  printingsByName: (name, kind) => request("/cards/printings", { query: kind ? { name, kind } : { name } }).then((d) => d.printings),
  rulings: (id) => request(`/cards/${id}/rulings`).then((d) => d.rulings),

  // Import / export (05)
  exportDeck: (id, payload) => request(`/decks/${id}/export`, { method: "POST", body: payload }),
  importText: (payload) => request("/import", { method: "POST", body: payload }),
  importArchidekt: (url) => request("/import/archidekt", { method: "POST", body: { url } }),

  // Reference
  tags: () => request("/tags").then((d) => d.tags),
  fx: () => request("/fx"),
  deckTokens: (deckId) => request(`/decks/${deckId}/tokens`).then((d) => d.tokens),
};

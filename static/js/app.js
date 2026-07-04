// app.js — bootstrap + shell render loop.
// Owns the top-level wiring; the gallery (07), drawer (09), top-panel dialogs
// (10), stats (11) and playtest (12) modules will progressively take over the
// placeholder renders below.

import { api, onApiWrite } from "./api.js";
import { getState, setState, subscribe, inDeckCount, deckPriceDisplay } from "./state.js";
import { renderToolbar, renderGallery, invalidateGallerySig } from "./gallery.js";
import { renderDrawerBody } from "./drawer.js";
import { loadCardData } from "./card.js";
import { openStats } from "./stats.js";
import { openPlaytest } from "./playtest.js";
import { STATE_ICONS, STATE_LABELS, STATE_ORDER, setCardState } from "./cardstate.js";

// Bump this on release (see the "Putting this on GitHub" README section for
// tagging) — shown at the top of the gear menu.
const APP_VERSION = "1.0.0";

// ---- tiny DOM helpers ----
const $ = (sel) => document.querySelector(sel);
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "onclick") n.addEventListener("click", v);
    else if (k === "html") n.innerHTML = v;
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid?.nodeType ? kid : document.createTextNode(kid ?? ""));
  return n;
}
function toast(msg) {
  const t = el("div", { class: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
const COMING = (step) => () => toast(`Coming in build step ${step}`);

// ---- top panel ----
function renderTopbar(s) {
  const sel = $("#deck-select");
  sel.innerHTML = "";
  sel.append(el("option", { value: "" }, s.decks.length ? "— select deck —" : "— no decks —"));
  for (const d of s.decks) {
    if (d.broken) {
      // Couldn't parse this deck file — show it (don't just silently drop it
      // from the list) as a disabled, red-flagged entry; hovering explains why.
      sel.append(el("option", {
        value: "", disabled: true, class: "opt-broken",
        title: `Couldn't load "${d.name}.json" — ${d.error}`,
      }, `⚠ ${d.name} (unreadable)`));
      continue;
    }
    const o = el("option", { value: d.id }, `${d.name} · ${formatLabel(d.format)} (${d.inDeckCount})`);
    if (d.id === s.currentDeckId) o.selected = true;
    if (d.inDeckCount === formatSize(d.format)) o.classList.add("full");
    sel.append(o);
  }

  const titleEl = $("#deck-title");
  titleEl.textContent = s.deck ? s.deck.name : "";
  $("#deck-commander").textContent = s.deck?.commander || "";

  const countEl = $("#deck-count");
  if (s.deck) {
    const n = inDeckCount(s.deck);
    const total = s.deck.cards.reduce((a, c) => a + (c.quantity || 1), 0);
    const target = formatSize(s.deck.format);
    const complete = n === target;
    countEl.textContent = `${n} / ${total}`;
    countEl.className = "deck-count" + (complete ? " full" : "");
    countEl.title = `${n} in your deck (target ${target}) · ${total} cards in workspace`;
    titleEl.classList.toggle("full", complete);
    const price = deckPriceDisplay(s.deck);
    const sym = s.currency === "USD" ? "$" : "C$";
    $("#deck-price").textContent = price ? `${sym}${price.toFixed(2)}` : "";
  } else {
    countEl.textContent = "";
    countEl.className = "deck-count";
    titleEl.classList.remove("full");
    $("#deck-price").textContent = "";
  }

  // enable/disable deck-scoped actions
  for (const id of ["#btn-save", "#btn-import", "#btn-export", "#btn-stats", "#btn-playtest", "#btn-tokens", "#btn-gear"]) {
    $(id).disabled = !s.deck;
  }

  // Save status (U2). Edits auto-persist; the indicator TEXT always reflects
  // reality (green "✓ Saved" is the common case, incl. "idle" — a freshly
  // opened, unmodified deck genuinely IS saved, so it shows the same green
  // confirmation immediately rather than sitting blank until the first
  // edit). (R19/R20) only the BUTTON's visibility is conditional: it shows
  // for "saving" (which, per wireSaveTracking, is now only ever set if a
  // write is genuinely still pending 3s later) or "error" — never for
  // "saved"/idle. No timer here: since a normal save never touches
  // saveStatus at all, there's nothing to race against re-renders from
  // unrelated actions (e.g. clicking a card) the way a hide-after-N-seconds
  // approach was.
  const ind = $("#save-indicator");
  const btn = $("#btn-save");
  btn.classList.remove("saving", "dirty");
  if (!s.deck) { ind.textContent = ""; ind.className = "save-indicator"; btn.classList.add("idle-hidden"); }
  else if (s.saveStatus === "saving") {
    ind.textContent = "Saving…"; ind.className = "save-indicator saving"; btn.classList.add("saving");
    btn.classList.remove("idle-hidden");
  } else if (s.saveStatus === "error") {
    ind.textContent = "● Unsaved"; ind.className = "save-indicator dirty";
    ind.title = "A change didn't save — click Save to retry"; btn.classList.add("dirty");
    btn.classList.remove("idle-hidden");
  } else {
    ind.textContent = "✓ Saved"; ind.className = "save-indicator saved"; ind.title = "All changes saved";
    btn.classList.add("idle-hidden");
  }
}

// ---- gallery area: loading / empty / delegate to gallery module ----
function renderGalleryArea(s) {
  const toolbar = $("#gallery-toolbar");
  const body = $("#gallery-body");
  if (s.loading) {
    toolbar.innerHTML = "";
    body.innerHTML = "";
    body.append(el("div", { class: "empty-state" }, el("span", { class: "spinner" }),
      el("div", {}, s.loadingMsg || "Working…")));
    invalidateGallerySig(); // this write bypassed renderGallery — its memoized signature is now stale
    return;
  }
  if (!s.deck) {
    toolbar.innerHTML = "";
    body.innerHTML = "";
    body.append(
      el("div", { class: "empty-state" },
        el("h2", {}, "No deck open"),
        el("div", {}, "Create a deck to pull EDHREC recommendations and start building."),
        el("button", { class: "btn btn-accent", onclick: newDeckFlow }, "+ New Deck"))
    );
    invalidateGallerySig();
    return;
  }
  renderToolbar(s);
  renderGallery(s);
}

// Full card detail drawer lives in drawer.js (imported above as renderDrawerBody).

// ---- drawer ----
function openDrawer(view = "card") {
  // Freeze the walk order NOW, not lazily on first Next/Prev — an inclusion
  // change (numpad or otherwise) can reorder the gallery before Next/Prev is
  // ever pressed, and a lazy capture would freeze the ALREADY-reordered list.
  navOrder = [...document.querySelectorAll("#gallery-body .card")].map((c) => c.dataset.cardId);
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  setState({ drawerOpen: true, drawerView: view });
}
function closeDrawer() {
  document.querySelector(".help-popover")?.remove();
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  setState({ drawerOpen: false, drawerView: null });
}

// ---- actions ----
async function loadDecks() {
  const decks = await api.listDecks();
  setState({ decks });
  return decks;
}
async function openDeck(id) {
  if (!id) {
    setState({ currentDeckId: null, deck: null });
    return;
  }
  setState({ loading: true, loadingMsg: "Loading deck…" });
  try {
    let deck = await api.getDeck(id);
    // Re-enrich legacy decks made before the per-format `legalities` map existed
    // (R5 A1/A2) so legality-by-format works immediately. One-time per old deck.
    const needsReenrich = deck.cards.some(
      (c) => c.scryfallId && (!c.legalities || !Object.keys(c.legalities).length));
    if (needsReenrich) {
      setState({ loadingMsg: "Updating card data…" });
      try { const r = await api.reenrich(id); if (r.deck) deck = r.deck; }
      catch { /* non-fatal — legality just stays permissive until next try */ }
    }
    setState({ deck, currentDeckId: id, loading: false,
      bucketingMode: deck.bucketingMode || "tag", selectedCardId: null });
  } catch (e) {
    setState({ loading: false });
    toast(e.message);
  }
}
// Deck formats (Scryfall legality keys → label). Default commander.
const FORMATS = [
  ["commander", "Commander"], ["oathbreaker", "Oathbreaker"], ["duel", "Duel Commander"],
  ["brawl", "Brawl"], ["modern", "Modern"], ["pioneer", "Pioneer"], ["standard", "Standard"],
  ["legacy", "Legacy"], ["vintage", "Vintage"], ["pauper", "Pauper"], ["premodern", "Premodern"],
];
function formatLabel(key) {
  const f = FORMATS.find(([v]) => v === (key || "commander"));
  return f ? f[1] : (key || "Commander");
}
// Exact deck size each format targets — drives the "complete deck" gold
// highlight in the deck picker and topbar. Commander/Duel are 100 (99 +
// commander); the other singleton formats and the 60-card constructed
// formats target 60.
const FORMAT_SIZE = {
  commander: 100, duel: 100, oathbreaker: 60, brawl: 60,
  modern: 60, pioneer: 60, standard: 60, legacy: 60, vintage: 60,
  pauper: 60, premodern: 60,
};
function formatSize(key) { return FORMAT_SIZE[key || "commander"] ?? 100; }

// ---- modal helper ----
function openModal({ title, body, footer, large }) {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal" + (large ? " modal-lg" : "") });
  const close = () => overlay.remove();
  modal.append(
    el("div", { class: "modal-header" },
      el("h3", {}, title || ""),
      el("button", { class: "btn btn-icon", onclick: close }, "✕")));
  const bodyEl = el("div", { class: "modal-body" });
  if (body) bodyEl.append(body);
  modal.append(bodyEl);
  if (footer) modal.append(el("div", { class: "modal-footer" }, footer));
  overlay.append(modal);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  $("#modal-root").append(overlay);
  return { close, bodyEl };
}

function field(labelText, inputEl) {
  return el("div", { class: "field" }, el("label", {}, labelText), inputEl);
}

// ---- New Deck modal (EDHREC build) ----
function newDeckFlow() {
  let commanderName = "";
  const nameField = el("input", { type: "text", placeholder: "e.g. Lathril Elfball" });
  const cmdField = el("input", { type: "text", placeholder: "Start typing a commander…", autocomplete: "off" });
  const acList = el("div", { class: "autocomplete-list" });
  const preview = el("div", { class: "cmd-preview" });
  const status = el("div", { class: "modal-status" });
  const createBtn = el("button", { class: "btn btn-accent" }, "Create Deck");

  let acTimer = null;
  cmdField.addEventListener("input", () => {
    commanderName = "";
    preview.innerHTML = "";
    const q = cmdField.value.trim();
    clearTimeout(acTimer);
    if (q.length < 2) { acList.innerHTML = ""; return; }
    acTimer = setTimeout(async () => {
      try {
        const names = await api.autocomplete(q);
        acList.innerHTML = "";
        for (const nm of names.slice(0, 8))
          acList.append(el("div", { class: "autocomplete-item", onclick: () => selectCommander(nm) }, nm));
      } catch { /* ignore */ }
    }, 220);
  });

  async function selectCommander(nm) {
    commanderName = nm;
    cmdField.value = nm;
    acList.innerHTML = "";
    if (!nameField.value.trim()) nameField.value = nm.split(",")[0];
    preview.innerHTML = "Loading preview…";
    try {
      const cards = await api.search(`!"${nm}"`);
      const img = cards[0]?.image?.normal;
      preview.innerHTML = img ? `<img src="${img}" alt="${nm}">` : "";
    } catch { preview.innerHTML = ""; }
  }

  const fmtSel = el("select", { class: "deck-select" });
  for (const [v, l] of FORMATS) fmtSel.append(el("option", { value: v }, l));
  const prefill = el("input", { type: "checkbox" }); prefill.checked = true;
  const prefillLabel = el("label", { class: "cbx" }, prefill,
    document.createTextNode(" Prefill with EDHREC recommendations"));

  const body = el("div", {});
  body.append(field("Deck name", nameField), field("Format", fmtSel), field("Commander", cmdField),
    acList, preview, prefillLabel, status);
  const m = openModal({ title: "New Deck", body, footer: createBtn });
  setTimeout(() => nameField.focus(), 0);

  async function doCreate(forceEmpty) {
    const name = nameField.value.trim();
    if (!name) { status.textContent = "Please enter a deck name."; return; }
    const commander = commanderName || cmdField.value.trim();
    const empty = forceEmpty || !prefill.checked;
    createBtn.disabled = true;
    status.innerHTML = empty
      ? `<span class="spinner"></span> Creating deck…`
      : `<span class="spinner"></span> Building from EDHREC… (~10s)`;
    try {
      const deck = await api.createDeck({ name, commander: commander || null, format: fmtSel.value, empty });
      await loadDecks();
      setState({ deck, currentDeckId: deck.id, loading: false,
        bucketingMode: deck.bucketingMode || "tag", selectedCardId: null });
      m.close();
      if (!empty && commander) autoRefine(deck.id);
    } catch (e) {
      createBtn.disabled = false;
      if (e.data?.code === "edhrec_not_found") {
        status.innerHTML = "";
        status.append(el("div", { class: "warn-text" }, e.message),
          el("button", { class: "btn", onclick: () => doCreate(true) }, "Start with an empty deck"));
      } else {
        status.textContent = e.message;
      }
    }
  }
  createBtn.addEventListener("click", () => doCreate(false));
}

async function autoRefine(id, opts) {
  setState({ loading: true, loadingMsg: "Recalculating tags…" });
  try {
    const r = await api.refineTags(id, opts);
    if (getState().currentDeckId === id && r.deck) setState({ deck: r.deck, loading: false });
    else setState({ loading: false });
    toast("Tags recalculated");
  } catch (e) { setState({ loading: false }); toast(e.message); }
}
async function saveDeck() {
  const s = getState();
  if (!s.deck) return;
  try {
    await api.saveDeck(s.deck);
    await loadDecks();
    toast("Saved");
  } catch (e) {
    toast(e.message);
  }
}

function refineDeck() {
  const s = getState();
  if (!s.deck) return;
  confirmModal(
    "Refine re-derives every card's tags from Archidekt + heuristics. This OVERWRITES any custom tags or primary-tag choices you've made. Continue?",
    "Refine tags",
    () => autoRefine(s.deck.id));
}

// ---- Reload card metadata (same enrichment as build): scalars/legalities/oracle
// pool-wide + cheapest price for included cards + warm skins ----
async function reloadMetadata() {
  const s = getState();
  if (!s.deck) return;
  setState({ loading: true, loadingMsg: "Reloading card metadata…" });
  try {
    const r = await api.reprice(s.deck.id);
    setState({ deck: r.deck || s.deck, loading: false });
    const n = r.updated || s.deck.cards.length;
    toast(`Reloaded card data for ${n} cards${r.repriced ? ` · re-priced ${r.repriced} to cheapest` : ""}`);
  } catch (e) {
    setState({ loading: false });
    toast(e.message);
  }
}

// ---- Ensure oracle text is populated (for the Oracle search toggle). Runs the
// cheap metadata-only batch once if any card is missing it. ----
async function ensureOracleText() {
  const s = getState();
  if (!s.deck) return;
  const missing = s.deck.cards.some((c) => c.scryfallId && !c.oracleText);
  if (!missing) return;
  setState({ loading: true, loadingMsg: "Loading oracle text…" });
  try {
    const r = await api.refreshMeta(s.deck.id);
    setState({ deck: r.deck || s.deck, loading: false });
  } catch (e) {
    setState({ loading: false });
    toast(e.message);
  }
}

// ---- Reload EDHREC data: refresh synergy/inclusion + add newly-recommended cards ----
async function reloadEdhrec() {
  const s = getState();
  if (!s.deck) return;
  setState({ loading: true, loadingMsg: "Reloading EDHREC recommendations…" });
  try {
    const r = await api.reloadEdhrec(s.deck.id);
    setState({ deck: r.deck || s.deck, loading: false });
    await loadDecks();
    toast(r.added
      ? `EDHREC reload: added ${r.added} new recommended card(s)`
      : "EDHREC reload: synergy/inclusion refreshed, no new cards");
  } catch (e) {
    setState({ loading: false });
    toast(e.message);
  }
}

// ---- Tags pop-up (G1): reorder tag buckets + "Recalculate all tags" ----
function openTagsModal() {
  const s = getState();
  if (!s.deck) return;
  const tagInfo = s.tagInfo || {};
  const disp = (t) => tagInfo[t]?.display || t.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // distinct tags present in the deck = the possible Tag-mode buckets
  const present = new Set();
  for (const c of s.deck.cards) {
    if (c.isCommander) continue;
    if (c.primaryTag) present.add(c.primaryTag);
    for (const t of c.tags || []) present.add(t);
  }
  const saved = (s.deck.settings?.tagOrder || []).filter((t) => present.has(t));
  const rest = [...present].filter((t) => !saved.includes(t)).sort();
  let order = [...saved, ...rest];

  const list = el("div", { class: "tag-order-list" });
  const render = () => {
    list.innerHTML = "";
    order.forEach((tag, i) => {
      const row = el("div", { class: "tag-order-row", draggable: "true" },
        el("span", { class: "tag-drag", title: "Drag to reorder" }, "⠿"),
        el("span", {}, disp(tag)));
      row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", String(i)); row.classList.add("dragging"); });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (e) => e.preventDefault());
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
        if (isNaN(from) || from === i) return;
        const [m] = order.splice(from, 1);
        order.splice(i, 0, m);
        render();
      });
      list.append(row);
    });
  };
  render();

  const save = el("button", { class: "btn btn-accent" }, "Save order");
  save.addEventListener("click", async () => {
    s.deck.settings = { ...s.deck.settings, tagOrder: order };
    try { await api.patchDeck(s.deck.id, { settings: s.deck.settings }); } catch (e) { toast(e.message); }
    setState({});
    m.close();
    toast("Tag order saved");
  });
  // Recalculate options (R7): default is safe (augment — add newly-derived tags,
  // keep existing tags + primary). The two checkboxes opt into destructive modes.
  const removeStale = checkboxField("Remove tags no longer derived", false);
  const resetPrimary = checkboxField("Reset primary tag to the derived one", false);
  const recalc = el("button", { class: "btn" }, "Recalculate all tags");
  recalc.addEventListener("click", () => {
    m.close();
    autoRefine(s.deck.id, { removeStale: removeStale.input.checked, resetPrimary: resetPrimary.input.checked });
  });

  const body = el("div", {});
  body.append(
    el("div", { class: "modal-status" }, "Drag to reorder how tag buckets appear in Tag grouping."),
    list,
    el("hr", { class: "modal-sep" }),
    el("div", { class: "modal-status" }, "Recalculate re-derives every card's tags from the latest heuristics. By default it only ADDS missing tags (your custom tags + primary are kept)."),
    removeStale.lab, resetPrimary.lab,
    recalc,
  );
  const m = openModal({ title: "Tags", body, footer: el("div", { class: "row" }, save) });
}

// ---- gear (⚙) menu: tags / delete / format / currency ----
function toggleGearMenu() {
  const open = document.querySelector(".gear-menu");
  if (open) { open.remove(); return; }
  const s = getState();
  const menu = el("div", { class: "gear-menu" });
  menu.append(
    el("div", { class: "gear-version" }, `MTG Deck Builder v${APP_VERSION}`),
    el("div", { class: "gear-sep" }),
    el("button", { class: "gear-item", onclick: () => { menu.remove(); openTagsModal(); } }, "Tags…"),
    el("button", { class: "gear-item", onclick: () => { menu.remove(); reloadMetadata(); } }, "Reload Card Metadata"),
    el("button", { class: "gear-item", onclick: () => { menu.remove(); reloadEdhrec(); } }, "Reload EDHREC Data"),
    el("button", { class: "gear-item", onclick: () => { menu.remove(); openKeyboardShortcutsModal(); } }, "Keyboard Shortcuts…"),
    el("button", { class: "gear-item danger", onclick: () => { menu.remove(); deleteDeck(); } }, "Delete deck"),
    el("div", { class: "gear-sep" }),
    el("div", { class: "gear-label" }, "Format"),
  );
  const fmtSel = el("select", { class: "deck-select" });
  for (const [v, l] of FORMATS) {
    const o = el("option", { value: v }, l);
    if ((s.deck.format || "commander") === v) o.selected = true;
    fmtSel.append(o);
  }
  fmtSel.addEventListener("change", async () => {
    menu.remove();
    const fmt = fmtSel.value;
    s.deck.format = fmt;
    try { await api.patchDeck(s.deck.id, { format: fmt }); } catch (e) { toast(e.message); }
    // Re-evaluate legality immediately. If any card lacks the legalities map
    // (legacy deck), re-enrich behind a brief spinner; else just re-render so the
    // red borders / no-symbols update at once (A2).
    const needs = s.deck.cards.some((c) => c.scryfallId && (!c.legalities || !Object.keys(c.legalities).length));
    if (needs) {
      setState({ loading: true, loadingMsg: "Checking card legality…" });
      try { const r = await api.reenrich(s.deck.id); if (r.deck) { setState({ deck: r.deck, loading: false }); return; } }
      catch (e) { toast(e.message); }
      setState({ loading: false });
    } else {
      setState({});
    }
  });
  menu.append(fmtSel, el("div", { class: "gear-sep" }), el("div", { class: "gear-label" }, "Currency"));
  const cad = el("button", { class: "seg-btn" + (s.currency === "CAD" ? " active" : "") }, "CAD");
  const usd = el("button", { class: "seg-btn" + (s.currency === "USD" ? " active" : "") }, "USD");
  cad.addEventListener("click", () => { setState({ currency: "CAD" }); cad.classList.add("active"); usd.classList.remove("active"); });
  usd.addEventListener("click", () => { setState({ currency: "USD" }); usd.classList.add("active"); cad.classList.remove("active"); });
  menu.append(el("div", { class: "segmented" }, cad, usd),
    el("div", { class: "gear-rate" }, `1 USD = ${(s.fxRate || 1.36).toFixed(2)} CAD${s.fxSource === "fallback" ? " (offline est.)" : ""}`));
  $("#topbar").append(menu);
  const r = $("#btn-gear").getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  setTimeout(() => document.addEventListener("mousedown", function h(ev) {
    if (!menu.contains(ev.target) && ev.target !== $("#btn-gear")) { menu.remove(); document.removeEventListener("mousedown", h); }
  }), 0);
}

// ---- tokens panel ----
async function openTokensModal() {
  const s = getState();
  if (!s.deck) return;
  const body = el("div", { class: "tokens-body" });
  body.append(el("div", {}, el("span", { class: "spinner" }), " Loading tokens…"));
  openModal({ title: "Tokens this deck needs", body, large: true });
  try {
    const tokens = await api.deckTokens(s.deck.id);
    body.innerHTML = "";
    if (!tokens.length) { body.append(el("div", { class: "drawer-note" }, "The included cards don't create any tokens.")); return; }
    const grid = el("div", { class: "tokens-grid" });
    for (const t of tokens) grid.append(tokenCard(t));
    body.append(grid);
  } catch (e) {
    body.innerHTML = ""; body.append(el("div", { class: "drawer-note" }, "Couldn't load tokens: " + e.message));
  }
}

function tokenCard(t) {
  // Designations / dungeons (Monarch, Initiative, City's Blessing, …) aren't real
  // cards — no scryfallId/image. Render a labeled placeholder tile instead (V1).
  if (!t.scryfallId) {
    return el("div", { class: "token-card token-extra" },
      el("div", { class: "token-extra-badge" }, t.kind === "dungeon" ? "🏰" : "👑"),
      el("div", { class: "token-name" }, t.name || "—"),
      el("div", { class: "token-extra-kind" }, t.kind === "dungeon" ? "Dungeon" : "Game designation"),
      el("div", { class: "token-by" }, el("b", { class: "token-by-label" }, "From:"), " " + (t.createdBy || []).join(", ")));
  }
  const img = el("img", { class: "token-img", alt: t.name || "token" });
  if (t.image) img.src = t.image;
  // Printing/skin picker: preload all printings of this token, dropdown + arrows
  // swap the image (tokens aren't deck entries, so no persistence) (H1).
  const prev = el("button", { class: "btn btn-icon", title: "Previous printing", disabled: "" }, "◀");
  const next = el("button", { class: "btn btn-icon", title: "Next printing", disabled: "" }, "▶");
  const sel = el("select", { class: "deck-select print-sel" });
  sel.append(el("option", { value: "" }, "…"));
  let prints = null, idx = 0;
  const sync = () => { prev.disabled = !prints || idx <= 0; next.disabled = !prints || idx >= prints.length - 1; };
  const rebuild = () => {
    sel.innerHTML = "";
    prints.forEach((p, i) => {
      const o = el("option", { value: String(i) }, `${p.setName || p.set} (${(p.set || "").toUpperCase()})`);
      if (i === idx) o.selected = true;
      sel.append(o);
    });
    sync();
  };
  const show = (i) => {
    if (!prints || i < 0 || i >= prints.length) return;
    idx = i; const p = prints[i];
    if (p.image?.normal) img.src = p.image.normal;
    rebuild();
  };
  prev.addEventListener("click", () => show(idx - 1));
  next.addEventListener("click", () => show(idx + 1));
  sel.addEventListener("change", () => prints && show(parseInt(sel.value, 10)));
  // Fetch printings by NAME (robust) so the skin dropdown is populated. This
  // entity IS a token (not a real card) — request token/emblem printings, not
  // the real card's, since some share an exact name (e.g. the token Fanatic
  // of Rhonas's Eternalize makes is itself named "Fanatic of Rhonas").
  api.printingsByName(t.name, "token").then((ps) => {
    prints = ps || [];
    idx = Math.max(0, prints.findIndex((p) => p.id === t.scryfallId));
    if (prints.length) rebuild();
  }).catch(() => {});

  // Print-quantity control: how many of this token to append to exports. Stored
  // on the deck (settings.tokenQty, keyed by token name); default 1, 0 = omit.
  const tq = getState().deck.settings?.tokenQty || {};
  let qty = tq[t.name] ?? 1;
  const qtyVal = el("span", { class: "qty-val" }, String(qty));
  const setQty = async (n) => {
    if (n < 0) return;
    qty = n; qtyVal.textContent = String(n);
    const s = getState();
    const next = { ...(s.deck.settings?.tokenQty || {}), [t.name]: n };
    s.deck.settings = { ...s.deck.settings, tokenQty: next };
    try { await api.patchDeck(s.deck.id, { settings: { tokenQty: next } }); } catch (e) { toast(e.message); }
  };
  const qMinus = el("button", { class: "btn btn-icon" }, "−"); qMinus.addEventListener("click", () => setQty(qty - 1));
  const qPlus = el("button", { class: "btn btn-icon" }, "+"); qPlus.addEventListener("click", () => setQty(qty + 1));

  // (R18) "From:" moves below the controls — its length varies a lot card to
  // card, and above the controls it pushed the printing-picker/copies rows
  // down by a different amount per card, misaligning them across a row.
  return el("div", { class: "token-card" }, img,
    el("div", { class: "token-name" }, t.name || "—"),
    el("div", { class: "token-prints" }, prev, sel, next),
    el("div", { class: "token-qty qty-row" }, el("span", { class: "token-qty-label" }, "Copies"), qMinus, qtyVal, qPlus),
    el("div", { class: "token-by" }, el("b", { class: "token-by-label" }, "From:"), " " + (t.createdBy || []).join(", ")));
}

// ---- add a single card by name (T1 — toolbar quick-add) ----
async function addCardByName(name) {
  const s = getState();
  if (!s.deck || !name) return;
  // If the card is already in the deck, bump its quantity instead of creating a
  // duplicate entry with a different printing (E2 — same rule as bulk-add).
  const existing = s.deck.cards.find((c) => (c.name || "").toLowerCase() === name.toLowerCase());
  try {
    if (existing) {
      const q = (existing.quantity || 1) + 1;
      await api.updateCard(s.deck.id, existing.id, { quantity: q });
      existing.quantity = q;
      setState({ selectedCardId: existing.id });
      await loadDecks();
      toast(`${existing.name} ×${q}`);
      return;
    }
    const entry = await api.addCard(s.deck.id, { name });
    s.deck.cards.push(entry);
    // B6: prime the image so the new card shows art immediately (before it's
    // ever opened in the drawer).
    if (entry.scryfallId) { try { await loadCardData(entry.scryfallId); } catch { /* observer will retry */ } }
    setState({ selectedCardId: entry.id });
    await loadDecks();
    toast(`Added ${entry.name}`);
  } catch (e) { toast(e.message); }
}

// ---- bulk-add panel (T2) — paste many cards, merge into the current deck ----
function openBulkAddModal() {
  const s = getState();
  if (!s.deck) return;
  const textArea = el("textarea", { class: "io-text", rows: "12",
    placeholder: "Paste cards — one per line (plain text, MTGA, or Archidekt format)…\n\n1 Sol Ring\nLightning Greaves\n3 Forest" });
  const dupe = checkboxField("Add cards already in the deck", false); // default OFF → skip dupes
  const status = el("div", { class: "modal-status" });
  const addBtn = el("button", { class: "btn btn-accent" }, "Add to deck");

  addBtn.addEventListener("click", async () => {
    const text = textArea.value.trim();
    if (!text) { status.textContent = "Paste some cards first."; return; }
    addBtn.disabled = true;
    status.innerHTML = `<span class="spinner"></span> Adding…`;
    try {
      const res = await api.importText({
        text,
        options: { deckId: s.deck.id, conflict: "merge", skipDuplicates: !dupe.input.checked },
      });
      if (res.deck) setState({ deck: res.deck });
      await loadDecks();
      m.close();
      const added = res.added != null ? res.added : (res.cards?.length || 0);
      const merged = res.merged ? ` · ${res.merged} merged into qty` : "";
      const skipped = res.skipped ? ` · ${res.skipped} already in deck skipped` : "";
      const notfound = res.warnings?.length ? ` · ${res.warnings.length} not found` : "";
      toast(`Added ${added} card(s)${merged}${skipped}${notfound}`);
    } catch (e) { addBtn.disabled = false; status.textContent = e.message; }
  });

  // O2 — second mode: add all EDHREC recommendations for a given card.
  // (R10) same typeahead pattern as the toolbar's quick-add / the New Deck
  // modal's commander field — a dropdown of matching real card names.
  // (R12) the modal has `overflow: auto` for its own scrolling, which was
  // CLIPPING the dropdown (an absolutely-positioned descendant still gets
  // clipped/scrolled by an ancestor's overflow, unlike the toolbar's quick-add,
  // which isn't nested in any scrolling container) — you had to scroll the
  // whole modal to see results instead of them popping up over everything.
  // Fix: render the dropdown at the `document.body` level with `position:
  // fixed`, positioned from the input's live bounding rect — the same escape
  // hatch cardstate.js's confirm-popover already uses for this exact problem.
  let edhChosen = "";
  const edhInput = el("input", { type: "text", placeholder: "Card name, e.g. Sol Ring", autocomplete: "off" });
  const edhWrap = el("div", { class: "edh-add-wrap" }, edhInput);
  const edhStatus = el("div", { class: "modal-status" });
  const edhBtn = el("button", { class: "btn btn-accent" }, "Add recommendations");

  let edhAc = null; // only exists in the DOM while suggestions are showing
  const closeEdhAc = () => { edhAc?.remove(); edhAc = null; };
  const chooseEdh = (nm) => { edhChosen = nm; edhInput.value = nm; closeEdhAc(); };
  const openEdhAc = (names) => {
    closeEdhAc();
    if (!names.length) return;
    edhAc = el("div", { class: "autocomplete-list edh-add-ac" });
    const r = edhInput.getBoundingClientRect();
    Object.assign(edhAc.style, { position: "fixed", top: `${r.bottom + 2}px`, left: `${r.left}px`, width: `${r.width}px` });
    for (const nm of names.slice(0, 8))
      edhAc.append(el("div", { class: "autocomplete-item", onclick: () => chooseEdh(nm) }, nm));
    document.body.append(edhAc);
  };
  let edhTimer = null;
  edhInput.addEventListener("input", () => {
    edhChosen = "";
    const q = edhInput.value.trim();
    clearTimeout(edhTimer);
    if (q.length < 2) { closeEdhAc(); return; }
    edhTimer = setTimeout(async () => {
      try { openEdhAc(await api.autocomplete(q)); } catch { /* ignore */ }
    }, 220);
  });
  edhInput.addEventListener("blur", () => setTimeout(closeEdhAc, 150));

  edhBtn.addEventListener("click", async () => {
    const name = edhChosen || edhInput.value.trim();
    if (!name) { edhStatus.textContent = "Enter a card name."; return; }
    edhBtn.disabled = true;
    edhStatus.innerHTML = `<span class="spinner"></span> Fetching EDHREC recommendations…`;
    try {
      const res = await api.addEdhrecForCard(s.deck.id, name);
      if (res.deck) setState({ deck: res.deck });
      await loadDecks();
      m.close();
      toast(`Added ${res.added} recommended card(s) for ${name}`);
    } catch (e) { edhBtn.disabled = false; edhStatus.textContent = e.message; }
  });

  const body = el("div", {});
  body.append(
    field("Paste a card list", textArea), dupe.lab, status,
    el("div", { class: "row row-end" }, addBtn),   // right-justify the Add button (E1)
    el("hr", { class: "modal-sep" }),
    field("…or add EDHREC recommendations for a card", edhWrap), edhStatus,
    el("div", { class: "row row-end" }, edhBtn),
  );
  const m = openModal({ title: "Bulk-add cards", body });
  setTimeout(() => textArea.focus(), 0);
}

// ---- remove the drawer's selected card (with confirm) ----
function removeSelectedCard() {
  const s = getState();
  const card = s.deck?.cards.find((c) => c.id === s.selectedCardId);
  if (!card) return;
  confirmModal(`Remove "${card.name}" from the deck?`, "Remove", async () => {
    try {
      await api.removeCard(s.deck.id, card.id);
      s.deck.cards = s.deck.cards.filter((c) => c.id !== card.id);
      closeDrawer();
      setState({});
      await loadDecks();
    } catch (e) { toast(e.message); }
  });
}

// ---- prev/next card navigation (drawer top-left) ----
// Walking order is frozen when the drawer opens on a fresh card (see openDrawer)
// rather than re-read from the live DOM on every call. A sort like "In first"
// reorders the gallery the instant an inclusion state changes — without
// freezing, setting a state on card A while stepping through with the numpad
// would silently redefine what "next" even means before Next/Prev is ever
// pressed, skipping/repeating cards instead of landing on whatever was
// actually lined up next when you started.
let navOrder = null;
function navDrawer(dir) {
  if (!navOrder) { // defensive fallback — openDrawer should already have set this
    navOrder = [...document.querySelectorAll("#gallery-body .card")].map((c) => c.dataset.cardId);
  }
  const cur = getState().selectedCardId;
  const i = navOrder.indexOf(cur);
  if (i < 0) { navOrder = null; return; } // fell out of the frozen order — let the next click re-anchor
  const j = Math.max(0, Math.min(navOrder.length - 1, i + dir));
  if (navOrder[j] && navOrder[j] !== cur) {
    setState({ selectedCardId: navOrder[j] });
    setTimeout(() => document.querySelector(`.card[data-card-id="${navOrder[j]}"]`)
      ?.scrollIntoView({ block: "center", behavior: "auto" }), 60);
  }
}

// ---- drawer help popover (explains primary/secondary types & tags) ----
function toggleDrawerHelp() {
  const existing = document.querySelector(".help-popover");
  if (existing) { existing.remove(); return; }
  const pop = el("div", { class: "help-popover" });
  pop.innerHTML =
    "<b>Types &amp; Tags</b>" +
    "<p>Cards are bucketed by their <b>primary</b> tag (and type). The highlighted bubble is primary — " +
    "<b>click another bubble</b> to make it primary and move the card to that bucket.</p>" +
    "<p>Use the <b>✎ pencil</b> to add or remove your own custom tags.</p>" +
    "<p>To list multi-tag/multi-type cards in <i>all</i> their buckets at once, turn on " +
    "<b>“All associations”</b> in the toolbar's Group section (secondary copies show a 🔗 badge).</p>" +
    "<p><b>Pricing &amp; printings:</b> changing a card's printing (“skin”) updates its image but <b>keeps the " +
    "original price</b> — the cost is frozen to the card's default printing, so swapping art never changes " +
    "your deck's total. (mtgprint export still uses your chosen printing's set + collector number.)</p>" +
    "<p><b>◀/▶ (or arrow keys) ordering:</b> Next/Prev walks the order the gallery was in when you opened " +
    "this card. Setting an inclusion state along the way (e.g. with the numpad) can move a card elsewhere in " +
    "the list under “In first” sort, but it won't change what Next/Prev takes you to — close and reopen the " +
    "drawer to pick up a fresh order.</p>";
  document.querySelector("#drawer").append(pop);
  setTimeout(() => document.addEventListener("mousedown", function hd(ev) {
    if (!pop.contains(ev.target) && ev.target !== document.querySelector("#drawer-help")) {
      pop.remove(); document.removeEventListener("mousedown", hd);
    }
  }), 0);
}

// ---- confirm modal (no window.confirm) ----
function confirmModal(message, yesLabel, onYes) {
  const yes = el("button", { class: "btn btn-danger" }, yesLabel);
  const no = el("button", { class: "btn" }, "Cancel");
  const m = openModal({ title: "Please confirm", body: el("div", {}, message),
    footer: el("div", { class: "row" }, no, yes) });
  no.addEventListener("click", m.close);
  yes.addEventListener("click", () => { m.close(); onYes(); });
}

function deleteDeck() {
  const s = getState();
  if (!s.deck) return;
  confirmModal(`Delete "${s.deck.name}"? This permanently removes the deck file.`, "Delete", async () => {
    try {
      await api.deleteDeck(s.deck.id);
      const decks = await api.listDecks();
      setState({ decks, deck: null, currentDeckId: null, selectedCardId: null });
      if (decks[0]) openDeck(decks[0].id);
      toast("Deck deleted");
    } catch (e) { toast(e.message); }
  });
}

// ---- inline rename (click the deck title) ----
function wireRename() {
  const t = $("#deck-title");
  t.addEventListener("click", () => {
    if (!getState().deck || t.isContentEditable) return;
    t.contentEditable = "true";
    t.focus();
    getSelection()?.selectAllChildren(t);
  });
  t.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); t.blur(); } });
  t.addEventListener("blur", async () => {
    t.contentEditable = "false";
    const s = getState();
    if (!s.deck) return;
    const name = t.textContent.trim();
    if (name && name !== s.deck.name) {
      s.deck.name = name;
      try { await api.patchDeck(s.deck.id, { name }); await loadDecks(); } catch (e) { toast(e.message); }
      setState({});
    } else {
      t.textContent = s.deck.name;
    }
  });
}

// ---- Export modal ----
function checkboxField(text, checked) {
  const input = el("input", { type: "checkbox" });
  input.checked = !!checked;
  const lab = el("label", { class: "cbx" }, input, document.createTextNode(" " + text));
  return { lab, input };
}

// (R9 WS7) A round icon-bubble toggle — same look as the gallery's inclusion
// filter (`.incl-btn cs-<state>`). Keeps a real (visually hidden) checkbox for
// state/events so existing `.input.checked` / `.input.disabled` /
// `.input.addEventListener("change", …)` call sites need no other changes.
const TOKEN_BUBBLE_SVG =
  '<svg viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="8" fill="none" ' +
  'stroke="currentColor" stroke-width="2"/><circle cx="11" cy="11" r="3.2" fill="currentColor"/></svg>';
function bubbleField(iconHtml, stateClass, title, checked) {
  const input = el("input", { type: "checkbox", class: "bubble-cbx" });
  input.checked = !!checked;
  // `incl-md` must be on an ANCESTOR of `.incl-btn` (the shared CSS sizes it via
  // a `.incl-md .incl-btn` descendant selector, same structure `inclusionControl`
  // uses) — putting both classes on the same element leaves the button unsized.
  const bubble = el("span", { class: "incl-btn " + stateClass + (input.checked ? " active" : "") });
  bubble.innerHTML = iconHtml;
  const lab = el("label", { class: "cbx bubble-lab incl-md", title }, input, bubble);
  input.addEventListener("change", () => bubble.classList.toggle("active", input.checked));
  return { lab, input };
}

function openExportModal() {
  const s = getState();
  if (!s.deck) return;
  // Each entry maps a menu choice → backend format + options. Set-code behaviour
  // is baked into the choice now (R5 — no more checkboxes); headers are never emitted.
  const FORMATS = [
    ["plain_text", "Plain text", { format: "plain_text", options: {} }],
    ["plain_text_sets", "Plain text (with set codes)", { format: "plain_text", options: { set_codes: true } }],
    ["mtga", "MTG Arena", { format: "mtga", options: {} }],
    ["mtgprint", "mtgprint.net", { format: "mtgprint", options: {} }],
    ["archidekt", "Archidekt", { format: "archidekt", options: {} }],
    ["archidekt_roundtrip", "Archidekt (lossless round-trip)", { format: "archidekt_roundtrip", options: {} }],
    ["json_internal", "JSON (internal backup)", { format: "json_internal", options: {} }],
  ];
  const SPEC = Object.fromEntries(FORMATS.map(([v, , spec]) => [v, spec]));
  const fmt = el("select", { class: "deck-select" });
  for (const [v, l] of FORMATS) fmt.append(el("option", { value: v }, l));
  // (R9 WS7) brownish bubble, matching the other inclusion-state bubbles' look.
  const tokens = bubbleField(TOKEN_BUBBLE_SVG, "cs-tokens", "Include tokens", false);
  // O3 — choose which inclusion states to export; default the two "ins". (R9 WS7)
  // same round bubble toggles as the gallery's inclusion filter, not checkboxes.
  const stateBoxes = STATE_ORDER.map((k) =>
    [k, bubbleField(STATE_ICONS[k], "cs-" + k, "Include " + STATE_LABELS[k], k === "locked_in" || k === "in")]);
  const preview = el("textarea", { class: "io-text", readonly: "true", rows: "14" });

  // Token list is only meaningful for the plain decklist formats (mtgprint et al.),
  // not the structured Archidekt/JSON ones — disable + skip there.
  const TOKENABLE = new Set(["plain_text", "plain_text_sets", "mtga", "mtgprint"]);
  let tokenCache = null; // printable token names, fetched once
  const tokenLines = async () => {
    if (!tokenCache) {
      try {
        const list = await api.deckTokens(s.deck.id);
        tokenCache = list.filter((t) => t.scryfallId && t.name).map((t) => t.name);
      } catch { tokenCache = []; }
    }
    if (!tokenCache.length) return "";
    const tq = s.deck.settings?.tokenQty || {};
    const lines = tokenCache.map((n) => { const q = tq[n] ?? 1; return q > 0 ? `${q} ${n}` : null; }).filter(Boolean);
    return lines.length ? "\n\n// Tokens\n" + lines.join("\n") : "";
  };

  const refresh = async () => {
    const canToken = TOKENABLE.has(fmt.value);
    tokens.input.disabled = !canToken;
    tokens.lab.classList.toggle("disabled", !canToken);
    preview.value = "…";
    try {
      const spec = SPEC[fmt.value];
      const states = stateBoxes.filter(([, b]) => b.input.checked).map(([k]) => k);
      const r = await api.exportDeck(s.deck.id, { format: spec.format, options: { ...spec.options, states } });
      let text = r.text;
      if (canToken && tokens.input.checked) text += await tokenLines();
      preview.value = text;
    } catch (e) { preview.value = "Error: " + e.message; }
  };
  fmt.addEventListener("change", refresh);
  tokens.input.addEventListener("change", refresh);
  for (const [, b] of stateBoxes) b.input.addEventListener("change", refresh);

  const copy = el("button", { class: "btn btn-accent" }, "Copy");
  copy.addEventListener("click", () => { navigator.clipboard?.writeText(preview.value); toast("Copied to clipboard"); });
  const dl = el("button", { class: "btn" }, "Download");
  dl.addEventListener("click", () => {
    const ext = fmt.value === "json_internal" ? "json" : "txt";
    const slug = (str) => str.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    const fname = `${slug(s.deck.name || "deck")}-${slug(formatLabel(s.deck.format))}.${ext}`;
    const a = el("a", { href: URL.createObjectURL(new Blob([preview.value], { type: "text/plain" })),
      download: fname });
    a.click();
  });

  const body = el("div", {});
  body.append(
    field("Format", fmt),
    // (R16) tokens bubble joins the same row as the inclusion-state bubbles
    // (same spacing/wrapping), instead of sitting on its own row below.
    field("Include which cards", el("div", { class: "row" }, ...stateBoxes.map(([, b]) => b.lab), tokens.lab)),
    field("Preview", preview),
  );
  openModal({ title: "Export deck", body, footer: el("div", { class: "row" }, dl, copy) });
  refresh();
}

// ---- Import modal ----
function openImportModal() {
  const textArea = el("textarea", { class: "io-text", rows: "9",
    placeholder: "Paste a decklist (plain text, MTGA, or Archidekt format)…" });
  const nameInput = el("input", { type: "text", placeholder: "New deck name (optional)" });
  const urlInput = el("input", { type: "text", placeholder: "https://archidekt.com/decks/12345/…" });
  const status = el("div", { class: "modal-status" });

  const pasteBtn = el("button", { class: "btn btn-accent" }, "Import as new deck");
  pasteBtn.addEventListener("click", async () => {
    const text = textArea.value.trim();
    if (!text) { status.textContent = "Paste a decklist first."; return; }
    pasteBtn.disabled = true;
    status.innerHTML = `<span class="spinner"></span> Importing…`;
    try {
      const res = await api.importText({ text, options: { createDeck: { name: nameInput.value.trim() || "Imported Deck" } } });
      await loadDecks();
      if (res.deck) setState({ deck: res.deck, currentDeckId: res.deck.id, bucketingMode: res.deck.bucketingMode || "tag", selectedCardId: null });
      m.close();
      toast(res.warnings?.length ? `Imported (${res.warnings.length} card(s) not found)` : "Imported");
    } catch (e) { pasteBtn.disabled = false; status.textContent = e.message; }
  });

  const urlBtn = el("button", { class: "btn" }, "Import from Archidekt URL");
  urlBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) { status.textContent = "Paste an Archidekt deck URL."; return; }
    urlBtn.disabled = true;
    status.innerHTML = `<span class="spinner"></span> Fetching from Archidekt…`;
    try {
      const res = await api.importArchidekt(url);
      await loadDecks();
      if (res.deck) setState({ deck: res.deck, currentDeckId: res.deck.id, bucketingMode: res.deck.bucketingMode || "tag", selectedCardId: null });
      m.close();
      toast(res.warnings?.length ? `Imported from Archidekt (${res.warnings.length} not found)` : "Imported from Archidekt");
    } catch (e) { urlBtn.disabled = false; status.textContent = e.message; }
  });

  const body = el("div", {});
  body.append(
    field("Paste a decklist", textArea),
    field("New deck name", nameInput),
    pasteBtn,
    el("hr", { class: "modal-sep" }),
    field("…or pull from an Archidekt deck URL", urlInput),
    urlBtn,
    status,
  );
  const m = openModal({ title: "Import deck", body });
}

// ---- Keyboard Shortcuts modal (R9 WS3) ----------------------------------
function kbdKey(label, cls = "") {
  return el("span", { class: "kbd-key " + cls }, label);
}
function openKeyboardShortcutsModal() {
  const body = el("div", { class: "kbd-help" });

  const arrowGrid = el("div", { class: "kbd-arrows" },
    el("span", {}), kbdKey("↑", "active"), el("span", {}),
    kbdKey("←", "active"), kbdKey("↓", "active"), kbdKey("→", "active"));
  body.append(el("div", { class: "kbd-row" }, arrowGrid,
    el("div", { class: "kbd-desc" },
      el("div", {}, el("b", {}, "← / →"), " — previous / next card"),
      el("div", {}, el("b", {}, "↑ / ↓"), " — previous / next printing (skin)"))));

  body.append(el("div", { class: "kbd-sep" }));

  const numGrid = el("div", { class: "kbd-numpad-wrap" },
    el("div", { class: "kbd-numpad" },
      kbdKey("7", "dim"), kbdKey("8", "dim"), kbdKey("9", "dim"),
      kbdKey("4", "active"), kbdKey("5", "dim"), kbdKey("6", "active"),
      kbdKey("1", "active"), kbdKey("2", "active"), kbdKey("3", "active")),
    el("div", { class: "kbd-numpad-bottomrow" }, kbdKey("0", "dim"), kbdKey("Enter", "active wide")));
  const legend = el("div", { class: "kbd-legend" },
    el("div", {}, kbdKey("1", "active sm"), " Set ", el("b", {}, "In")),
    el("div", {}, kbdKey("2", "active sm"), " Set ", el("b", {}, "Undecided")),
    el("div", {}, kbdKey("3", "active sm"), " Set ", el("b", {}, "Out")),
    el("div", {}, kbdKey("4", "active sm"), " Set ", el("b", {}, "Locked In")),
    el("div", {}, kbdKey("6", "active sm"), " Set ", el("b", {}, "Locked Out")),
    el("div", { class: "kbd-note" },
      "If the card is currently Locked In/Out, the usual confirm popup appears — press the same key again or ",
      kbdKey("Enter", "sm"), " to confirm."));
  body.append(el("div", { class: "kbd-row" }, numGrid, legend));

  body.append(el("div", { class: "kbd-sep" }),
    el("div", { class: "drawer-note" },
      "All shortcuts act on the card currently open in the side panel, and only when you're not typing in a text field. Numpad keys only — the regular number row is left free for typing."));

  openModal({ title: "Keyboard Shortcuts", body });
}

// ---- keyboard shortcuts (R9 WS2) ----------------------------------------
// Active only while the drawer is open and focus isn't in a text-editable
// element (so typing in the tag combobox, search box, etc. is unaffected).
// Numpad-specific key CODES only (Numpad1..Numpad6) — the plain digit-row keys
// stay free for typing, per the request.
function isTextEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
// (R16) corrected: confirmation is governed by the SAME rule as everywhere
// else — needed only when LEAVING a locked state (setCardState's existing
// NEEDS_CONFIRM check), regardless of which key changed it. So Numpad
// 1/2/3/4/6 all just call setCardState directly; if the card's current state
// is locked_in/locked_out, the usual mouse confirm popover appears exactly
// like it does when clicking an inclusion bubble — no separate "press again"
// arm step of our own. The only addition: while that popover is open, the
// SAME key pressed again, or Enter, activates its default "Change" button
// (so the numpad stays fully keyboard-driven without a mouse).
function handleShortcutKeydown(e) {
  const s = getState();
  if (!s.drawerOpen || !s.selectedCardId) return;
  if (isTextEditable(document.activeElement)) return;
  const card = s.deck?.cards.find((c) => c.id === s.selectedCardId);
  if (!card) return;

  if (e.code === "ArrowLeft") { e.preventDefault(); navDrawer(-1); return; }
  if (e.code === "ArrowRight") { e.preventDefault(); navDrawer(1); return; }
  if (e.code === "ArrowUp") {
    e.preventDefault();
    document.querySelector('.drawer-printrow button[title="Previous printing"]')?.click();
    return;
  }
  if (e.code === "ArrowDown") {
    e.preventDefault();
    document.querySelector('.drawer-printrow button[title="Next printing"]')?.click();
    return;
  }

  const STATE_BY_KEY = { Numpad1: "in", Numpad2: "undecided", Numpad3: "out", Numpad4: "locked_in", Numpad6: "locked_out" };
  const targetState = STATE_BY_KEY[e.code];
  if (!targetState) return;
  e.preventDefault();
  const anchor = document.querySelector(`.drawer-info .incl-btn.cs-${targetState}`);
  setCardState(card, targetState, anchor);
  const pop = document.querySelector(".confirm-popover");
  if (!pop) return; // no confirmation needed — already applied
  const triggerCode = e.code;
  const onKey = (ev) => {
    if (!document.body.contains(pop)) { document.removeEventListener("keydown", onKey, true); return; }
    if (ev.code === triggerCode || ev.key === "Enter") {
      ev.preventDefault();
      pop.querySelector(".btn-accent")?.click();
      document.removeEventListener("keydown", onKey, true);
    }
  };
  document.addEventListener("keydown", onKey, true);
}

// ---- wire static controls ----
function wireControls() {
  $("#deck-select").addEventListener("change", (e) => openDeck(e.target.value));
  $("#btn-new-deck").addEventListener("click", newDeckFlow);
  $("#btn-save").addEventListener("click", saveDeck);
  $("#btn-import").addEventListener("click", openImportModal);
  $("#btn-export").addEventListener("click", openExportModal);
  $("#btn-stats").addEventListener("click", () => openStats());
  $("#btn-playtest").addEventListener("click", () => openPlaytest());
  $("#btn-tokens").addEventListener("click", openTokensModal);
  $("#btn-gear").addEventListener("click", toggleGearMenu);
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-help").addEventListener("click", toggleDrawerHelp);
  $("#drawer-remove").addEventListener("click", removeSelectedCard);
  $("#drawer-prev").addEventListener("click", () => navDrawer(-1));
  $("#drawer-next").addEventListener("click", () => navDrawer(1));
  wireRename();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && getState().drawerOpen) { closeDrawer(); return; }
    handleShortcutKeydown(e);
  });
  // Click outside the drawer (gallery/menu whitespace) closes it — but NOT when
  // interacting with the drawer/cards/modals/menus. Decided from MOUSEDOWN: the
  // target is captured before any re-render can detach it, so in-drawer controls
  // (qty +/-, tag ✎, etc.) that setState no longer accidentally close the drawer.
  let _downKeepsDrawer = false;
  document.addEventListener("mousedown", (e) => {
    _downKeepsDrawer = !!(e.target.closest("#drawer") || e.target.closest(".card")
      || e.target.closest(".modal-overlay") || e.target.closest(".gear-menu")
      || e.target.closest(".help-popover"));
  });
  document.addEventListener("click", () => {
    if (getState().drawerOpen && !_downKeepsDrawer) closeDrawer();
  });
}

// ---- render loop ----
function render(s) {
  renderTopbar(s);
  renderGalleryArea(s);
  renderDrawerBody(s);
}

// Track in-flight deck writes → drive the Save indicator (U2).
// (R19) autosave is nearly instant almost always, so flipping to "saving" the
// moment a write starts made the button pop up (and restart its hide timer)
// on completely unrelated actions like clicking a card, every single time —
// since renderTopbar re-evaluates "is saveStatus currently saved" on every
// render, not "did it just NOW become saved". Fix: don't surface "saving" at
// all unless a write is still pending 3s later (genuinely slow) — a normal
// sub-3s save never touches saveStatus, so the button simply never appears
// for it. A failure always surfaces immediately, since that needs attention.
let _pendingWrites = 0;
let _slowSaveTimer = null;
function wireSaveTracking() {
  onApiWrite((ev) => {
    if (ev === "start") {
      _pendingWrites++;
      if (_pendingWrites === 1) {
        clearTimeout(_slowSaveTimer);
        _slowSaveTimer = setTimeout(() => setState({ saveStatus: "saving" }), 3000);
      }
    } else if (ev === "ok") {
      _pendingWrites = Math.max(0, _pendingWrites - 1);
      if (_pendingWrites === 0) {
        clearTimeout(_slowSaveTimer);
        // Once the in-flight batch settles successfully, we're saved (clears a prior error).
        setState({ saveStatus: "saved" });
      }
    } else if (ev === "error") {
      _pendingWrites = Math.max(0, _pendingWrites - 1);
      clearTimeout(_slowSaveTimer);
      setState({ saveStatus: "error" });
    }
  });
}

async function boot() {
  wireControls();
  wireSaveTracking();
  subscribe(render);
  render(getState());
  try {
    await api.health();
    api.tags().then((tags) => {
      const tagInfo = {};
      for (const t of tags) tagInfo[t.key] = t;
      setState({ tagInfo });
    }).catch(() => {});
    api.fx().then((f) => setState({ fxRate: f.usdCad || 1.36, fxSource: f.source }))
      .catch(() => {});
    await loadDecks();
    const id = getState().currentDeckId;
    if (id && getState().decks.some((d) => d.id === id)) {
      await openDeck(id);
    } else {
      render(getState());
    }
  } catch (e) {
    toast("Server not reachable: " + e.message);
  }
}

// expose a couple of hooks for later modules
window.cdb = { openDrawer, closeDrawer, openDeck, loadDecks, toast, addCardByName, openBulkAddModal, ensureOracleText };

boot();

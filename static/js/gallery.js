// gallery.js — renders the sticky toolbar + the bucketed card sections.
// Sort/filter controls and the hover state-control are added in step 08.

import { api } from "./api.js";
import { getState, setState } from "./state.js";
import { bucketize, sectionCounts } from "./bucketing.js";
import { cardEl, loadVisibleImages } from "./card.js";
import { STATE_LABELS, STATE_ICONS } from "./cardstate.js";

const MODES = [
  ["all", "All"], ["tag", "Tag"], ["type", "Type"], ["cost", "Cost"], ["rarity", "Rarity"],
];
const INCLUSION = ["locked_in", "in", "undecided", "out", "locked_out"];
const TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Land", "Battle", "Other"];
const COLORS = [["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"], ["C", "Colorless"]];
const collapsed = new Set(); // `${mode}:${sectionKey}` collapsed this session
// (R18) last-rendered signature — every API write (any write, not just this
// deck's — e.g. changing a card's printing) pings saveStatus via setState,
// which used to unconditionally blow away and rebuild the ENTIRE gallery body
// (losing scroll position and flashing every card) even though nothing about
// what should be ON SCREEN had actually changed yet. Skip the rebuild when
// this signature — everything that actually affects what renderGallery draws
// — is unchanged since last time.
let lastGallerySig = null;
// app.js's renderGalleryArea bypasses renderGallery entirely and writes
// #gallery-body directly for the "loading" and "no deck" states — call this
// whenever it does, so the NEXT real renderGallery() call can't mistake
// "same deck content as last time" (e.g. reopening the same already-current
// deck, which the auto-restore-on-boot + a user action can both trigger
// back to back) for "the DOM still shows it" and wrongly skip rendering,
// leaving that direct write (e.g. the loading spinner) stuck on screen.
export function invalidateGallerySig() { lastGallerySig = null; }

// Shared with renderGallery below — anything that can change what it draws.
function computeGallerySig(s) {
  return JSON.stringify({
    deck: s.deck, bucketingMode: s.bucketingMode, selectedCardId: s.selectedCardId,
    drawerOpen: !!s.drawerOpen, zoom: s.zoom, showInfoStrip: s.showInfoStrip,
    currency: s.currency, showAllBuckets: !!s.showAllBuckets, tagInfo: s.tagInfo,
    filters: { text: filters.text, colors: [...filters.colors], types: [...filters.types], oracle: filters.oracle },
    collapsed: [...collapsed].sort(),
  });
}

// A caller that patches a card's DOM node in place (the drawer's printing
// picker) mutates `deck` — which the signature above hashes wholesale — so
// the VERY NEXT unrelated render (e.g. the save-status ping firing once the
// write settles) would see a "changed" signature and blow away + rebuild all
// 238+ card nodes for a change that's already reflected on screen. Call this
// right after such an in-place patch to fold the mutation into the signature
// without rebuilding, so that next render is correctly a no-op.
export function resyncGallerySig() { lastGallerySig = computeGallerySig(getState()); }

// Transient view filters (not persisted; state filter lives in deck.settings).
// colors/types are multi-select Sets of the SHOWN categories (WS5): default = all
// selected (no filtering); uncheck to hide. `oracle` widens the text search (R5).
const filters = {
  text: "",
  colors: new Set(COLORS.map(([v]) => v)),
  types: new Set(TYPES),
  oracle: false,
};

function visibleCards(deck) {
  const sf = new Set(deck.settings?.stateFilter || INCLUSION);
  const text = filters.text.trim().toLowerCase();
  const allColors = filters.colors.size === COLORS.length;
  const allTypes = filters.types.size === TYPES.length;
  return deck.cards.filter((c) => {
    if (!sf.has(c.inclusionState)) return false;
    if (text) {
      // Oracle mode widens the search to name + oracle text; otherwise just name.
      const hay = (filters.oracle ? (c.name + " " + (c.oracleText || "")) : c.name).toLowerCase();
      if (!hay.includes(text)) return false;
    }
    if (!allTypes && !filters.types.has(c.cardType || "Other")) return false;
    if (!allColors) {
      const ci = c.colorIdentity || [];
      const match = ci.length === 0 ? filters.colors.has("C")
        : ci.some((x) => filters.colors.has(String(x).toUpperCase()));
      if (!match) return false;
    }
    return true;
  });
}

function patchDeckSettings(patch) {
  const s = getState();
  if (!s.deck) return;
  Object.assign(s.deck, patch.deckLevel || {});
  if (patch.settings) s.deck.settings = { ...s.deck.settings, ...patch.settings };
  api.patchDeck(s.deck.id, patch.deckLevel?.bucketingMode != null
    ? { bucketingMode: s.deck.bucketingMode, settings: s.deck.settings }
    : { settings: s.deck.settings }).catch(() => {});
}

function divider() {
  const d = document.createElement("span");
  d.className = "tb-divider";
  return d;
}

// A labeled toolbar section: header + its controls grouped together. `title` may
// be a string (rendered as a .toolbar-label) or a DOM node (used as-is, e.g. the
// inclusion-count row). Every section reserves a header band (nbsp fallback) so
// all sections stay the same height → titles line up on row 1, controls on row 2.
function section(title, ...controls) {
  const wrap = document.createElement("div");
  wrap.className = "tb-section";
  wrap.append(title && title.nodeType ? title : label(title || " "));
  const inner = document.createElement("div");
  inner.className = "tb-section-controls";
  for (const c of controls) if (c) inner.append(c);
  wrap.append(inner);
  return wrap;
}

export function renderToolbar(s) {
  const bar = document.getElementById("gallery-toolbar");
  bar.innerHTML = "";
  if (!s.deck) return;

  const row = document.createElement("div");
  row.className = "toolbar-row";
  bar.append(row);

  // ---- Group ----
  const seg = document.createElement("div");
  seg.className = "segmented";
  for (const [key, lbl] of MODES) {
    const b = document.createElement("button");
    b.textContent = lbl;
    if (s.bucketingMode === key) b.classList.add("active");
    b.addEventListener("click", () => {
      setState({ bucketingMode: key });
      patchDeckSettings({ deckLevel: { bucketingMode: key } });
    });
    seg.append(b);
  }
  let cmcBox = null;
  if (s.bucketingMode === "cost") {
    // WS6 — CMC breakpoints as the compact multi-select widget (was a long checkbox row).
    const bps = new Set((s.deck.settings?.cmcBreakpoints || []).map(String));
    cmcBox = multiSelect("Breakpoints", Array.from({ length: 11 }, (_, n) => [String(n), String(n)]), bps, () => {
      // re-bucket the gallery WITHOUT rebuilding the toolbar (keeps the popover open).
      patchDeckSettings({ settings: { cmcBreakpoints: [...bps].map(Number).sort((a, b) => a - b) } });
      renderGallery(getState());
    });
  }
  // "All associations" = show each card in ALL of the current grouping's matching
  // buckets (secondary instances badged), not just its primary one.
  const allAssoc = toggle("All associations", s.showAllBuckets, (v) => setState({ showAllBuckets: v }));
  row.append(section("Group", seg, cmcBox, allAssoc));
  row.append(divider());

  // ---- Sort ----
  const SORTS = [
    ["name", "Name"], ["cmc", "Mana value"], ["inclusion", "EDHREC inclusion"],
    ["synergy", "EDHREC synergy"], ["price", "Price"], ["rarity", "Rarity"],
  ];
  const sortSel = select(SORTS, s.deck.settings?.secondarySort || "name", (v) => {
    patchDeckSettings({ settings: { secondarySort: v } }); setState({});
  });
  const inFirst = toggle("In first", s.deck.settings?.inclusionSort !== false, (v) => {
    patchDeckSettings({ settings: { inclusionSort: v } }); setState({});
  });
  row.append(section("Sort", sortSel, inFirst));
  row.append(divider());

  // ---- Filters ----
  // Filter changes re-render only the gallery (+ update the in-view count in place)
  // WITHOUT rebuilding the toolbar — so an open multi-select popover survives a
  // selection and only closes when you click away. (R20) hoisted above every
  // control that filters cards — the search box used to call renderGallery()
  // directly and never touch .tb-inview at all, so typing a search left the
  // 👁 count stuck at the deck's TOTAL instead of reflecting the filtered view.
  const reflowGallery = () => {
    renderGallery(getState());
    const n = visibleCards(getState().deck).reduce((a, c) => a + (c.quantity || 1), 0);
    const iv = document.querySelector(".tb-inview");
    if (iv) iv.textContent = `👁${n}`;
  };

  const txt = document.createElement("input");
  txt.type = "search"; txt.placeholder = filters.oracle ? "name or oracle text…" : "name…";
  txt.className = "filter-text";
  txt.value = filters.text;
  txt.addEventListener("input", () => { filters.text = txt.value; reflowGallery(); });
  // Toggle: search oracle text instead of names (e.g. find every card mentioning
  // "indestructible"). Turning it on lazily populates oracle text if missing.
  const oracleTog = toggle("Oracle", filters.oracle, async (v) => {
    filters.oracle = v;
    if (v) await window.cdb?.ensureOracleText?.();
    reflowGallery();
  });
  oracleTog.title = "Also search each card's oracle text";

  const sf = new Set(s.deck.settings?.stateFilter || INCLUSION);
  // Count cards in each inclusion state (I1). The counts render as the toggle
  // section's HEADER row (aligned over each button) so they sit on the title line
  // with Group/Sort/Filters/… instead of adding a band inside the controls.
  const stateCounts = Object.fromEntries(INCLUSION.map((st) => [st, 0]));
  for (const c of s.deck.cards) if (c.inclusionState in stateCounts) stateCounts[c.inclusionState]++;
  // The counts float ABSOLUTELY just above the toggle buttons (into the header
  // band) so they line up with the section titles and add zero height to the
  // controls row. The toggles stay inside the single Filters section as before.
  const countsHeader = document.createElement("div");
  countsHeader.className = "filter-state-counts";
  const fc = document.createElement("div");
  fc.className = "incl-control incl-md filter-states";
  for (const st of INCLUSION) {
    const cnt = document.createElement("span");
    cnt.className = "toolbar-label filter-state-count";
    cnt.textContent = String(stateCounts[st]);
    cnt.title = `${stateCounts[st]} ${STATE_LABELS[st]}`;
    countsHeader.append(cnt);
    const b = document.createElement("button");
    b.className = "incl-btn cs-" + st + (sf.has(st) ? " active" : "");
    b.title = (sf.has(st) ? "Showing — click to hide " : "Hidden — click to show ") + STATE_LABELS[st]
      + ` (${stateCounts[st]})`;
    b.innerHTML = STATE_ICONS[st];
    // (R20) toggle this button's own look in place + reflow (was a full
    // setState({}) toolbar rebuild — worked, but bypassed reflowGallery so
    // it's inconsistent with the rest of the Filters section; this also
    // avoids rebuilding the whole toolbar for a single button's state).
    b.addEventListener("click", () => {
      const next = new Set(getState().deck.settings?.stateFilter || INCLUSION);
      const nowShowing = !next.has(st);
      next.has(st) ? next.delete(st) : next.add(st);
      patchDeckSettings({ settings: { stateFilter: INCLUSION.filter((x) => next.has(x)) } });
      b.classList.toggle("active", nowShowing);
      b.title = (nowShowing ? "Showing — click to hide " : "Hidden — click to show ") + STATE_LABELS[st]
        + ` (${stateCounts[st]})`;
      reflowGallery();
    });
    fc.append(b);
  }
  const statesWrap = document.createElement("div");
  statesWrap.className = "filter-states-wrap";
  statesWrap.append(countsHeader, fc);

  const colorSel = multiSelect("Colors", COLORS, filters.colors, reflowGallery);
  const typeSel = multiSelect("Types", TYPES.map((t) => [t, t]), filters.types, reflowGallery);
  const clear = document.createElement("button");
  clear.className = "btn"; clear.textContent = "Clear";
  clear.addEventListener("click", () => {
    filters.text = "";
    filters.colors.clear(); COLORS.forEach(([v]) => filters.colors.add(v));
    filters.types.clear(); TYPES.forEach((t) => filters.types.add(t));
    patchDeckSettings({ settings: { stateFilter: [...INCLUSION] } });
    setState({});
  });
  // (R9 WS1) "VIEWING: N" sits right next to the "Filters" title instead of
  // trailing in its own section further down the row.
  const inView = visibleCards(s.deck).reduce((a, c) => a + (c.quantity || 1), 0);
  const inViewLabel = label(`👁${inView}`);
  inViewLabel.classList.add("tb-inview");
  const filtersTitle = document.createElement("div");
  filtersTitle.className = "tb-title-row";
  filtersTitle.append(label("Filters"), inViewLabel);
  row.append(section(filtersTitle, txt, oracleTog, statesWrap, colorSel, typeSel, clear));

  // ---- spacer + add controls + view controls (pushed right) ----
  const spacer = document.createElement("div");
  spacer.className = "tb-spacer";
  row.append(spacer);

  // ---- Add (T1 quick-add + T2 bulk) ----
  row.append(addSection());
  row.append(divider());

  // collapse / expand all
  const collapseAll = document.createElement("button");
  collapseAll.className = "btn btn-icon"; collapseAll.title = "Collapse all sections"; collapseAll.textContent = "⊟";
  collapseAll.addEventListener("click", () => {
    const secs = bucketize({ ...s.deck, cards: visibleCards(s.deck) }, s.bucketingMode, s.deck.settings, s.tagInfo, !!s.showAllBuckets);
    for (const sec of secs) collapsed.add(`${s.bucketingMode}:${sec.key}`);
    setState({});
  });
  const expandAll = document.createElement("button");
  expandAll.className = "btn btn-icon"; expandAll.title = "Expand all sections"; expandAll.textContent = "⊞";
  expandAll.addEventListener("click", () => { collapsed.clear(); setState({}); });
  row.append(section("View", collapseAll, expandAll,
    toggle("Card info", s.showInfoStrip, (v) => setState({ showInfoStrip: v }))));

  // Size — its own labeled section (header above the slider), separated by a divider
  row.append(divider());
  const range = document.createElement("input");
  range.type = "range"; range.min = "0.6"; range.max = "1.8"; range.step = "0.1";
  range.value = String(s.zoom);
  range.className = "zoom-range";
  range.addEventListener("input", () => setState({ zoom: parseFloat(range.value) }));
  row.append(section("Size", range));
}

// Quick-add (T1): autocomplete a card name → add to deck. Bulk (T2): open paste panel.
function addSection() {
  const box = document.createElement("div");
  box.className = "quick-add";
  const input = document.createElement("input");
  input.type = "text"; input.className = "filter-text quick-add-input";
  input.placeholder = "+ add card…"; input.autocomplete = "off";
  const ac = document.createElement("div");
  ac.className = "autocomplete-list quick-add-ac";
  box.append(input, ac);

  let timer = null, items = [], active = -1;
  const clear = () => { ac.innerHTML = ""; items = []; active = -1; };
  const choose = (name) => { clear(); input.value = ""; window.cdb?.addCardByName?.(name); };
  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) { clear(); return; }
    timer = setTimeout(async () => {
      try {
        const names = await api.autocomplete(q);
        clear();
        items = names.slice(0, 8);
        items.forEach((nm) => {
          const it = document.createElement("div");
          it.className = "autocomplete-item"; it.textContent = nm;
          it.addEventListener("mousedown", (e) => { e.preventDefault(); choose(nm); });
          ac.append(it);
        });
      } catch { /* ignore */ }
    }, 200);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(items.length - 1, active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); choose(items[active] || input.value.trim()); return; }
    else if (e.key === "Escape") { clear(); return; }
    [...ac.children].forEach((c, i) => c.classList.toggle("active", i === active));
  });
  input.addEventListener("blur", () => setTimeout(clear, 150));

  const bulk = document.createElement("button");
  bulk.className = "btn"; bulk.textContent = "Bulk…"; bulk.title = "Paste many cards at once";
  bulk.addEventListener("click", () => window.cdb?.openBulkAddModal?.());

  return section("Add", box, bulk);
}

function select(options, current, onChange) {
  const sel = document.createElement("select");
  sel.className = "deck-select";
  for (const [v, lab] of options) {
    const o = document.createElement("option");
    o.value = v; o.textContent = lab; if (v === current) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

// Compact multi-select (WS5/WS6): a button showing "Label: All" / "Label: n/N"
// that opens a popover of checkboxes + All / None quick buttons. `selected` is a
// Set of chosen VALUES that the widget mutates in place; onChange fires after any
// change. Values are compared as strings.
function multiSelect(labelText, options, selected, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "ms-wrap";
  const btn = document.createElement("button");
  btn.className = "btn ms-btn";
  const sync = () => {
    const n = selected.size, total = options.length;
    btn.textContent = `${labelText}: ${(n === total || n === 0) ? "All" : n + "/" + total}`;
  };
  sync();
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (wrap.querySelector(".ms-popover")) { wrap.querySelector(".ms-popover").remove(); return; }
    document.querySelectorAll(".ms-popover").forEach((p) => p.remove());
    const pop = document.createElement("div");
    pop.className = "ms-popover";
    const refresh = () => {
      pop.querySelectorAll("input").forEach((cb, i) => { cb.checked = selected.has(String(options[i][0])); });
      sync(); onChange();
    };
    const mk = (t, fn) => { const b = document.createElement("button"); b.className = "btn btn-icon"; b.textContent = t; b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); }); return b; };
    const quick = document.createElement("div");
    quick.className = "ms-quick";
    quick.append(mk("All", () => { options.forEach(([v]) => selected.add(String(v))); refresh(); }),
      mk("None", () => { selected.clear(); refresh(); }));
    pop.append(quick);
    for (const [v, l] of options) {
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = selected.has(String(v));
      cb.addEventListener("change", () => { cb.checked ? selected.add(String(v)) : selected.delete(String(v)); sync(); onChange(); });
      pop.append(el("label", { class: "ms-item cbx" }, cb, document.createTextNode(" " + l)));
    }
    wrap.append(pop);
    setTimeout(() => document.addEventListener("mousedown", function h(ev) {
      if (!wrap.contains(ev.target)) { pop.remove(); document.removeEventListener("mousedown", h); }
    }), 0);
  });
  wrap.append(btn);
  return wrap;
}

// tiny element helper (mirrors the one in app.js) for multiSelect labels
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") n.className = v; else if (v != null) n.setAttribute(k, v); }
  for (const kid of kids) n.append(kid?.nodeType ? kid : document.createTextNode(kid ?? ""));
  return n;
}

function label(text) {
  const s = document.createElement("span");
  s.className = "toolbar-label";
  s.textContent = text;
  return s;
}

function toggle(text, checked, onChange) {
  const l = document.createElement("label");
  l.className = "toggle";
  const input = document.createElement("input");
  input.type = "checkbox"; input.checked = !!checked;
  input.addEventListener("change", () => onChange(input.checked));
  const track = document.createElement("span"); track.className = "track";
  l.append(input, track, document.createTextNode(text));
  return l;
}

export function renderGallery(s) {
  const body = document.getElementById("gallery-body");
  // Everything that can change what this function draws: the whole deck
  // (cards + settings + format, all in one object), the view/toolbar state,
  // and the two bits of gallery-local module state (filters, collapsed
  // sections) that mutate outside of `s` itself.
  const sig = computeGallerySig(s);
  if (sig === lastGallerySig) return;
  lastGallerySig = sig;

  const scrollTop = body.scrollTop; // preserve position across a real rebuild
  body.style.setProperty("--card-w", `${Math.round(150 * (s.zoom || 1))}px`);
  body.innerHTML = "";

  const visible = visibleCards(s.deck);
  const sections = bucketize({ ...s.deck, cards: visible }, s.bucketingMode, s.deck.settings, s.tagInfo, !!s.showAllBuckets);
  if (!sections.length) {
    const msg = s.deck.cards.length ? "No cards match the current filters." : "No cards in this deck yet.";
    body.innerHTML = `<div class="empty-state"><div>${msg}</div></div>`;
    body.scrollTop = scrollTop;
    return;
  }

  for (const sec of sections) {
    const counts = sectionCounts(sec.items);
    const colKey = `${s.bucketingMode}:${sec.key}`;
    const isCollapsed = collapsed.has(colKey);

    const section = document.createElement("section");
    section.className = "gallery-section";

    const header = document.createElement("div");
    header.className = "section-header";
    header.innerHTML =
      `<span class="chevron">${isCollapsed ? "▸" : "▾"}</span>` +
      `<span class="section-name">${sec.label}</span>` +
      `<span class="section-count">${counts.in} in / ${counts.total} total</span>`;
    header.addEventListener("click", () => {
      isCollapsed ? collapsed.delete(colKey) : collapsed.add(colKey);
      setState({}); // re-render
    });
    section.append(header);

    if (!isCollapsed) {
      const grid = document.createElement("div");
      grid.className = "section-cards";
      for (const item of sec.items) grid.append(cardEl(item));
      section.append(grid);
    }
    body.append(section);
  }
  body.scrollTop = scrollTop;
  // After layout settles, load images for the cards now on screen — the
  // IntersectionObserver can miss cards observed before their height applied.
  requestAnimationFrame(() => loadVisibleImages(body));
}

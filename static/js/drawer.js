// drawer.js — full card detail view. Two-column top (image+printing on the left,
// ordered controls on the right), full-width oracle/keywords/rulings below.
// Right-column order: Title(+legality icon, title links to Scryfall) → Cost →
// Types → Tags → Quantity → Inclusion → EDH stats → Pricing.
// Rebuilds only on a field-signature change.

import { api } from "./api.js";
import { getState, setState, formatPrice, isLegal, overCopyLimit, copyLimit } from "./state.js";
import { inclusionControl, WARNING_SVG } from "./cardstate.js";
import { loadCardData, refreshCardLegality } from "./card.js";
import { resyncGallerySig } from "./gallery.js";
import { tagLabel } from "./bucketing.js";

let lastSig = null;
let renderToken = 0;
let glossary = null;

async function getGlossary() {
  if (glossary) return glossary;
  try { glossary = await (await fetch("/data/keywords.json")).json(); }
  catch { glossary = {}; }
  return glossary;
}

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}

const escapeHtml = (s) => (s || "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));

function manaHtml(text) {
  return escapeHtml(text).replace(/\{([^}]+)\}/g, (m, sym) => {
    const raw = sym.replace(/\//g, "");
    const key = raw.toLowerCase();
    const cls = ["w", "u", "b", "r", "g", "c"].includes(key) ? `mana mana-${key}` : "mana mana-generic";
    return `<span class="${cls}">${escapeHtml(raw)}</span>`;
  });
}

function coarseType(typeLine) {
  const t = (typeLine || "").toLowerCase();
  if (t.includes("creature")) return "Creature";
  if (t.includes("planeswalker")) return "Planeswalker";
  if (t.includes("instant")) return "Instant";
  if (t.includes("sorcery")) return "Sorcery";
  if (t.includes("artifact")) return "Artifact";
  if (t.includes("enchantment")) return "Enchantment";
  if (t.includes("land")) return "Land";
  if (t.includes("battle")) return "Battle";
  return "Other";
}

// Legality as an icon (hover tooltip), for the deck's current format. Both icons
// are the same size; legal is a "verified"-style scalloped seal, illegal is a
// clean centred circle-slash. SVG (currentColor) keeps them crisp + centred.
const LEGAL_SVG =
  '<svg viewBox="0 0 22 22" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" ' +
  'd="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897' +
  '-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587' +
  '-.704-1.086-1.245-1.44C11.647 1.621 11 1.604 11 1.604s-.647.017-1.188.371c-.54.355-.972.853-1.245 1.44' +
  '-.607-.223-1.264-.27-1.897-.14-.634.132-1.217.437-1.687.882-.445.47-.75 1.053-.882 1.687-.13.633-.083 1.29.14 1.897' +
  '-.587.274-1.085.705-1.44 1.246C2.187 9.725 1.99 10.354 1.972 11c.018.646.215 1.275.57 1.816.355.54.853.972 1.44 1.246' +
  '-.223.607-.27 1.264-.14 1.897.132.634.437 1.217.882 1.687.47.445 1.053.75 1.687.882.633.13 1.29.083 1.897-.14' +
  '.274.587.705 1.085 1.245 1.44.541.354 1.188.371 1.188.371s.647-.017 1.188-.371c.54-.355.972-.853 1.245-1.44' +
  '.607.223 1.264.27 1.897.14.634-.132 1.217-.437 1.687-.882.445-.47.75-1.053.882-1.687.13-.633.083-1.29-.14-1.897' +
  '.587-.274 1.085-.705 1.44-1.246.354-.541.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072' +
  ' 4.4-4.794 1.347 1.246-5.68 6.206z"/></svg>';
const ILLEGAL_SVG =
  '<svg viewBox="0 0 22 22" aria-hidden="true">' +
  '<circle cx="11" cy="11" r="8.4" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<line x1="5.6" y1="5.6" x2="16.4" y2="16.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function legalityIcon(legalities, fmt) {
  const legal = (legalities || {})[fmt] === "legal";
  const fmtLabel = String(fmt || "commander").replace(/\b\w/g, (c) => c.toUpperCase());
  const span = h("span", {
    class: "legality-icon " + (legal ? "legal" : "illegal"),
    title: (legal ? "Legal in " : "Illegal in ") + fmtLabel,
  });
  span.innerHTML = legal ? LEGAL_SVG : ILLEGAL_SVG;
  return span;
}

function typesRow(card, data) {
  const faceLines = (data.faces && data.faces.length > 1)
    ? data.faces.map((f) => f.typeLine).filter(Boolean)
    : [data.typeLine].filter(Boolean);
  const wrap = h("div", { class: "drawer-bubbles" });
  let primaryIdx = faceLines.findIndex((tl) => coarseType(tl) === card.cardType);
  if (primaryIdx < 0) primaryIdx = 0;
  faceLines.forEach((tl, i) => {
    const chip = h("button", { class: "chip type-chip" + (i === primaryIdx ? " primary" : "") }, tl);
    if (faceLines.length > 1 && i !== primaryIdx) {
      chip.addEventListener("click", async () => {
        const coarse = coarseType(tl);
        const cardTypes = [coarse, ...[...new Set(faceLines.map(coarseType))].filter((c) => c !== coarse)];
        card.cardType = coarse; card.cardTypes = cardTypes; lastSig = null; setState({});
        try { await api.updateCard(getState().deck.id, card.id, { cardType: coarse, cardTypes }); }
        catch (e) { window.cdb?.toast?.(e.message); }
      });
    }
    wrap.append(chip);
  });
  // (R5) The per-card "Show in all type buckets" toggle is removed — it's now a
  // single grouping-agnostic view toggle in the gallery toolbar.
  return h("div", { class: "drawer-field-tight" }, wrap);
}

function tagsRow(card) {
  const tagInfo = getState().tagInfo;
  const wrap = h("div", { class: "drawer-bubbles" });
  let editing = false;
  const persist = async () => {
    try { await api.updateCard(getState().deck.id, card.id, { tags: card.tags, primaryTag: card.primaryTag }); }
    catch (e) { window.cdb?.toast?.(e.message); }
  };
  const render = () => {
    wrap.innerHTML = "";
    for (const t of card.tags || []) {
      const chip = h("button", { class: "chip" + (t === card.primaryTag ? " primary" : "") }, tagLabel(t, tagInfo));
      if (editing) {
        const x = h("span", { class: "chip-x", title: "Remove" }, "×");
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          card.tags = card.tags.filter((y) => y !== t);
          if (card.primaryTag === t) card.primaryTag = card.tags[0] || "other";
          persist(); render();
        });
        chip.append(x);
      }
      if (t !== card.primaryTag) chip.addEventListener("click", () => { card.primaryTag = t; lastSig = null; persist(); setState({}); });
      wrap.append(chip);
    }
    const pencil = h("button", { class: "chip chip-edit", title: editing ? "Done" : "Edit tags" }, editing ? "✓" : "✎");
    pencil.addEventListener("click", () => { editing = !editing; render(); if (!editing) { lastSig = null; setState({}); } });
    wrap.append(pencil);
    if (editing) {
      // (R9 WS5) filter-as-you-type combobox: lists known tags (from tagInfo)
      // matching what's typed; Enter picks the highlighted one, or submits the
      // typed text as a brand-new tag when nothing is highlighted (same slugify
      // path as before). Mirrors the toolbar's card quick-add autocomplete.
      const inputWrap = h("div", { class: "tag-add-wrap" });
      const input = h("input", { type: "text", class: "tag-add", placeholder: "add tag, Enter", autocomplete: "off" });
      const ac = h("div", { class: "autocomplete-list tag-add-ac" });
      inputWrap.append(input, ac);
      let items = [], active = -1;
      const closeAc = () => { ac.innerHTML = ""; items = []; active = -1; };
      const commit = (raw) => {
        const slug = String(raw).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (slug && !card.tags.includes(slug)) { card.tags.push(slug); persist(); }
        input.value = ""; closeAc(); render(); wrap.querySelector(".tag-add")?.focus();
      };
      const refreshAc = () => {
        closeAc();
        const q = input.value.trim().toLowerCase();
        if (!q) return;
        items = Object.keys(tagInfo || {}).filter((k) => {
          if ((card.tags || []).includes(k)) return false;
          const disp = (tagInfo[k]?.display || k).toLowerCase();
          return k.includes(q) || disp.includes(q);
        }).slice(0, 8);
        items.forEach((k) => {
          const it = h("div", { class: "autocomplete-item" }, tagLabel(k, tagInfo));
          it.addEventListener("mousedown", (e) => { e.preventDefault(); commit(k); });
          ac.append(it);
        });
      };
      input.addEventListener("input", refreshAc);
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(items.length - 1, active + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); }
        else if (e.key === "Enter") { e.preventDefault(); commit(active >= 0 && items[active] ? items[active] : input.value); return; }
        else if (e.key === "Escape") { closeAc(); return; }
        else return;
        [...ac.children].forEach((c, i) => c.classList.toggle("active", i === active));
      });
      input.addEventListener("blur", () => setTimeout(closeAc, 150));
      wrap.append(inputWrap);
    }
  };
  render();
  // (R5) The per-card "Show in all tag buckets" toggle is removed — superseded by
  // the single grouping-agnostic view toggle in the gallery toolbar.
  return h("div", { class: "drawer-field-tight" }, wrap);
}

function qtyRow(card) {
  const val = h("span", { class: "qty-val" }, String(card.quantity || 1));
  const set = async (q) => {
    if (q < 1) return;
    card.quantity = q; lastSig = null; setState({});
    try { await api.updateCard(getState().deck.id, card.id, { quantity: q }); }
    catch (e) { window.cdb?.toast?.(e.message); }
  };
  const minus = h("button", { class: "btn btn-icon" }, "−");
  const plus = h("button", { class: "btn btn-icon" }, "+");
  minus.addEventListener("click", () => set((card.quantity || 1) - 1));
  plus.addEventListener("click", () => set((card.quantity || 1) + 1));
  const row = h("div", { class: "qty-row" }, minus, val, plus);  // no label (R3)
  // (R10) copy-limit warning, to the right of the + button.
  if (overCopyLimit(card)) {
    const fmt = getState().deck?.format || "commander";
    const warn = h("span", { class: "badge badge-warn qty-warn",
      title: `${card.quantity} copies — ${fmt} allows ${copyLimit(fmt)}` });
    warn.innerHTML = WARNING_SVG;
    row.append(warn);
  }
  return row;
}

// Inclusion control — shrunk to match the quantity row. (WS9) Editable even for
// illegal cards; a note reminds you legality still trumps for the deck totals.
function inclusionRow(card) {
  const ctl = inclusionControl(card, { size: "md" });
  if (!isLegal(card)) {
    const fmt = String(getState().deck?.format || "this format").replace(/\b\w/, (c) => c.toUpperCase());
    return h("div", {}, ctl,
      h("div", { class: "drawer-locked" }, `Illegal in ${fmt} — excluded from the deck regardless of this setting`));
  }
  return ctl;
}

// Printing picker — preloads printings on drawer load; ◀▶ disabled at the ends.
function printingPicker(card, imgEl) {
  const prev = h("button", { class: "btn btn-icon", title: "Previous printing", disabled: "" }, "◀");
  const next = h("button", { class: "btn btn-icon", title: "Next printing", disabled: "" }, "▶");
  const sel = h("select", { class: "deck-select print-sel" });
  sel.append(h("option", { value: "" }, (card.editionCode || "current").toUpperCase()));
  let prints = null, idx = 0, reqToken = 0;
  const sync = () => {
    prev.disabled = !prints || idx <= 0;
    next.disabled = !prints || idx >= prints.length - 1;
  };
  const rebuild = () => {
    sel.innerHTML = "";
    prints.forEach((p, i) => {
      const o = h("option", { value: String(i) },
        `${p.setName || p.set} (${(p.set || "").toUpperCase()})${p.prices?.usd ? ` — $${p.prices.usd}` : ""}`);
      if (i === idx) o.selected = true;
      sel.append(o);
    });
    sync();
  };
  // Persist a printing selection WITHOUT rebuilding the drawer. Rebuilding reset
  // the picker (arrows "bounced" between same-name printings) and flashed the
  // gallery card blank on a fresh card; instead we patch the drawer + gallery
  // images in place. `persist=false` is used for the self-heal on load.
  async function apply(i, persist = true) {
    if (!prints || i < 0 || i >= prints.length) return;
    idx = i; rebuild();
    const p = prints[i];
    if (imgEl && p.image?.normal) imgEl.src = p.image.normal;
    if (!persist) return;
    // Requests can resolve out of order when arrows are clicked faster than the
    // round trip (e.g. skipping past a token/promo printing) — a stale response
    // landing last would overwrite a newer one's image/legality on the card and
    // in the gallery. Only the most recently FIRED call is allowed to apply.
    const myToken = ++reqToken;
    try {
      // Pin the exact printing by id (a set code isn't unique). Price stays
      // frozen server-side; scryfallId/editionCode/collectorNumber update.
      const updated = await api.updateCard(getState().deck.id, card.id,
        { printingId: p.id, editionCode: p.set });
      if (myToken !== reqToken) return; // superseded by a later click — discard
      Object.assign(card, updated);
      // Update the gallery card's image in place — no full re-render, so the
      // picker keeps its state and a freshly-added card doesn't flash blank.
      const gImg = document.querySelector(`#gallery-body .card[data-card-id="${card.id}"] img`);
      if (gImg) { if (p.image?.normal) gImg.src = p.image.normal; gImg.dataset.scryfallId = card.scryfallId; }
      refreshCardLegality(card); // legality can differ per printing (e.g. a token print of the same name)
      if (imgEl) imgEl.parentElement.classList.toggle("illegal", !isLegal(card));
      // The mutation above changed `deck`, which the gallery's rebuild-skip
      // signature hashes wholesale — without this, the save-status ping that
      // fires once this write settles would see "deck changed" and blow away
      // + rebuild every card node (a full-page flicker) for a change already
      // reflected on screen by the patches above.
      resyncGallerySig();
      loadCardData(card.scryfallId).catch(() => {}); // prime cache for later renders
    }
    catch (e) { if (myToken === reqToken) window.cdb?.toast?.(e.message); }
  }
  prev.addEventListener("click", () => apply(idx - 1));
  next.addEventListener("click", () => apply(idx + 1));
  sel.addEventListener("change", () => prints && apply(parseInt(sel.value, 10)));
  // preload — fetch ALL printings of the ENTRY's NAME (robust: never depends on a
  // possibly-stale scryfallId). Match the current selection by id.
  api.printingsByName(card.name).then((ps) => {
    prints = ps || [];
    if (!prints.length) return;
    const want = card.printingId || card.scryfallId;
    idx = prints.findIndex((p) => p.id === want);
    if (idx >= 0) { rebuild(); return; }
    // The stored printing isn't a printing of this card's name (corrupted entry,
    // e.g. a reskin that changed the name) — self-heal to the default printing.
    idx = Math.max(0, prints.findIndex((p) => p.set === card.editionCode));
    if (idx < 0) idx = 0;
    apply(idx, true);
  }).catch(() => {});
  return h("div", { class: "drawer-printrow" }, prev, sel, next);
}

function rulingsSection(card) {
  const det = h("details", { class: "drawer-section" });
  det.append(h("summary", {}, "Rulings"));
  let loaded = false;
  det.addEventListener("toggle", async () => {
    if (!det.open || loaded) return;
    loaded = true;
    const box = h("div", { class: "rulings" }, "Loading…");
    det.append(box);
    try {
      const rs = await api.rulings(card.scryfallId);
      box.innerHTML = rs.length
        ? rs.map((r) => `<p class="ruling"><span class="ruling-date">${escapeHtml(r.published_at || "")}</span> ${escapeHtml(r.comment || "")}</p>`).join("")
        : "No rulings.";
    } catch { box.textContent = "Couldn't load rulings."; }
  });
  return det;
}

async function keywordsSection(keywords) {
  if (!keywords || !keywords.length) return null;
  const gloss = await getGlossary();
  const det = h("details", { class: "drawer-section" });
  det.open = true;
  det.append(h("summary", {}, `Keywords (${keywords.length})`));
  const list = h("div", { class: "kw-list" });
  for (const kw of keywords) {
    list.append(h("div", { class: "kw" },
      h("span", { class: "kw-name" }, kw),
      h("span", { class: "kw-desc" }, gloss[kw.toLowerCase()] || "(no description on file yet)")));
  }
  det.append(list);
  return det;
}

export async function renderDrawerBody(s) {
  const body = document.getElementById("drawer-body");
  if (!s.drawerOpen || s.drawerView !== "card") { lastSig = null; return; }
  const card = s.deck?.cards.find((c) => c.id === s.selectedCardId);
  if (!card) { body.innerHTML = ""; lastSig = null; return; }

  // NB: `editionCode`/printing is deliberately NOT in the signature — a printing
  // ("skin") change updates the drawer + gallery images in place (see
  // printingPicker.apply) and must NOT rebuild the drawer, or the picker resets
  // (arrows "bounce") and a fresh card flashes blank when the write-tracker's
  // Saving/Saved setState re-renders.
  const sig = [card.id, card.inclusionState, card.primaryTag, card.cardType,
    card.quantity, card.showInAllTagBuckets, card.showInAllTypeBuckets, s.currency, s.deck.format,
    (card.tags || []).join(","), (card.cardTypes || []).join(",")].join("|");
  if (sig === lastSig) return;
  lastSig = sig;
  const token = ++renderToken;

  body.innerHTML = "";
  // two-column top
  const left = h("div", { class: "drawer-left" });
  const imgWrap = h("div", { class: "drawer-imgwrap" + (isLegal(card) ? "" : " illegal") });
  const printSlot = h("div", {});
  left.append(imgWrap, printSlot);

  const info = h("div", { class: "drawer-info" });
  // 1. title (Scryfall link) + legality icon
  const nameLink = h("a", { class: "drawer-name", target: "_blank", rel: "noopener" }, card.name);
  const nameRow = h("div", { class: "drawer-namerow" }, nameLink);
  info.append(nameRow);
  const costSlot = h("div", {}); info.append(costSlot);        // 2. cost
  const typeSlot = h("div", {}); info.append(typeSlot);        // 3. types
  info.append(tagsRow(card));                                  // 4. tags
  info.append(qtyRow(card));                                   // 5. quantity
  info.append(inclusionRow(card));                             // 6. inclusion
  const edhSlot = h("div", {}); info.append(edhSlot);          // 7. EDH stats
  const priceSlot = h("div", {}); info.append(priceSlot);      // 8. pricing

  body.append(h("div", { class: "drawer-top" }, left, info));
  const lower = h("div", { class: "drawer-lower" });
  body.append(lower);

  if (!card.scryfallId) {
    costSlot.append(h("div", { class: "drawer-note" }, "Resolving card data…"));
    try {
      const enriched = await api.enrichCard(s.deck.id, card.id);
      if (token !== renderToken) return;
      Object.assign(card, enriched); lastSig = null; setState({});
    } catch { /* leave */ }
    return;
  }

  const data = await loadCardData(card.scryfallId);
  if (token !== renderToken) return;
  if (!data) { costSlot.append(h("div", { class: "drawer-note" }, "Couldn't load card data.")); return; }

  // image (hover flip) + scryfall link on the title
  const img = h("img", { class: "drawer-card-img", alt: card.name });
  img.src = data.image.normal || data.image.large || "";
  imgWrap.append(img);
  if (data.scryfallUri) nameLink.href = data.scryfallUri;
  nameRow.append(legalityIcon(data.legalities, s.deck.format || "commander"));
  const faceImgs = (data.faces || []).map((f) => f.image?.normal).filter(Boolean);
  const backImg = data.image.back || (faceImgs.length > 1 ? faceImgs[1] : null);
  if (backImg) {
    let front = true;
    const flip = h("button", { class: "drawer-flip", title: "Flip" }, "⟳");
    flip.addEventListener("click", () => { front = !front; img.src = front ? (data.image.normal || faceImgs[0]) : backImg; });
    imgWrap.append(flip);
  }

  // printing picker (preloaded)
  printSlot.replaceWith(printingPicker(card, img));

  // cost + P/T + rarity on one row (P/T then rarity to the right of the cost — D2/WS4)
  const costRow = h("div", { class: "drawer-costrow" });
  if (data.manaCost) costRow.append(h("div", { class: "drawer-cost", html: manaHtml(data.manaCost) }));
  const pt = data.power != null ? `${data.power} / ${data.toughness}` : (data.loyalty != null ? `Loyalty ${data.loyalty}` : null);
  if (pt) costRow.append(h("div", { class: "drawer-pt" }, pt));
  const rarity = data.rarity || card.rarity;
  if (rarity) costRow.append(h("div", { class: "drawer-rarity rarity-" + rarity }, rarity.replace(/\b\w/, (c) => c.toUpperCase())));
  costSlot.append(costRow);

  // types
  typeSlot.replaceWith(typesRow(card, data));

  // EDH stats
  const ed = card.edhrecData || {};
  const stats = [];
  if (ed.inclusion != null) stats.push(`${ed.inclusion}% decks`);
  if (ed.synergy != null) stats.push(`${Math.round(ed.synergy * 100)}% synergy`);
  if (stats.length) edhSlot.append(h("div", { class: "drawer-meta" }, stats.join(" · ")));

  // pricing (TCGPlayer only, current currency)
  const priceText = formatPrice(data.prices.usd);
  if (priceText) {
    priceSlot.append(h("div", { class: "drawer-meta" },
      h("a", { href: data.purchaseUris.tcgplayer || "#", target: "_blank", rel: "noopener" }, `${priceText} · TCGplayer`)));
  }

  // expandable sections (full width)
  if (data.oracleText) {
    const det = h("details", { class: "drawer-section" });
    det.open = true;
    det.append(h("summary", {}, "Oracle text"), h("div", { class: "oracle", html: manaHtml(data.oracleText) }));
    lower.append(det);
  }
  const kw = await keywordsSection(data.keywords);
  if (token === renderToken && kw) lower.append(kw);
  lower.append(rulingsSection(card));
}

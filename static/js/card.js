// card.js — render one card in the gallery (image, state visuals, badges, info
// strip). Images lazy-load via a shared IntersectionObserver; resolved card data
// (image URLs) is cached per scryfallId to avoid refetching on re-render.

import { api } from "./api.js";
import { getState, setState, formatPrice, isLegal, overCopyLimit, copyLimit } from "./state.js";
import { inclusionControl, LOCK_SVG, WARNING_SVG } from "./cardstate.js";

const dataCache = new Map();  // scryfallId -> normalized card (only set on success)
const inflight = new Map();   // scryfallId -> in-flight Promise (dedup concurrent loads)

// (R9) Both lock states share the LOCK_SVG shape; only the colour differs (the
// old version showed the SAME yellow lock emoji for both states — a real bug).
const LOCK_BADGE_CLASS = { locked_in: "st-locked_in", locked_out: "st-locked_out" };

async function loadCardData(id) {
  if (dataCache.has(id)) return dataCache.get(id);       // resolved (success)
  if (inflight.has(id)) return inflight.get(id);         // dedup concurrent loads
  const p = api.cardDetail(id)
    .then((data) => { dataCache.set(id, data); inflight.delete(id); return data; })
    .catch(() => { inflight.delete(id); return null; }); // failure: NOT cached → retryable
  inflight.set(id, p);
  return p;
}

// Load one card image (dedup via loadCardData). No-op if it already has a src.
function setImg(img, obs) {
  const id = img.dataset.scryfallId;
  if (!id) { if (obs) obs.unobserve(img); return; }
  if (img.getAttribute("src")) { if (obs) obs.unobserve(img); return; }
  const cached = dataCache.get(id);
  if (cached) {
    if (cached.image?.normal) { img.src = cached.image.normal; img.classList.add("loaded"); }
    addFlip(img, cached);
    if (obs) obs.unobserve(img);
    return;
  }
  if (obs) obs.unobserve(img);
  loadCardData(id).then((data) => {
    const url = data?.image?.normal;
    if (url && !img.getAttribute("src")) { img.src = url; img.classList.add("loaded"); addFlip(img, data); }
    else if (!url && img.isConnected) imgObserver.observe(img);  // failed → retry when back in view
  });
}

// Shared observer: when a card image scrolls into view, load it. NB `continue`
// (NOT `return`) per entry — the callback gets a BATCH, and a `return` would abort
// the rest, leaving cards blank until re-observed ("don't load until I touch it").
const imgObserver = new IntersectionObserver((entries, obs) => {
  for (const e of entries) {
    if (e.isIntersecting) setImg(e.target, obs);
  }
}, { rootMargin: "300px" });

// Refresh a gallery card's illegal/lock badge + red-outline class in place, for
// callers (the drawer's printing picker) that patch a card's image without a
// full gallery rebuild — a printing swap can change legality (e.g. a token
// printing of the same name), and that must not require an unrelated rebuild
// to become visible.
export function refreshCardLegality(entry) {
  const card = document.querySelector(`#gallery-body .card[data-card-id="${entry.id}"]`);
  if (!card) return;
  const legal = isLegal(entry);
  card.classList.toggle("illegal", !legal);
  const fmt = getState().deck?.format || "commander";
  if (!legal) card.title = `Illegal in ${fmt.replace(/\b\w/, (c) => c.toUpperCase())} — excluded from the deck`;
  else card.removeAttribute("title");
  // The badge stack only exists in the DOM when it has something to show
  // (see cardEl), so a card with no lock/secondary badge before now won't
  // have one — create it on demand rather than silently no-opping.
  let tl = card.querySelector(".badge-stack-tl");
  if (!tl) {
    if (legal && !LOCK_BADGE_CLASS[entry.inclusionState]) return; // still nothing to show
    tl = document.createElement("div");
    tl.className = "badge-stack-tl";
    card.querySelector(".card-img")?.prepend(tl);
  }
  tl.querySelector(".badge-illegal")?.remove();
  tl.querySelector(".badge-lock")?.remove();
  if (!legal) {
    const b = document.createElement("span");
    b.className = "badge badge-illegal";
    b.title = `Not legal in ${fmt}`;
    b.textContent = "⊘";
    tl.prepend(b);
  } else if (LOCK_BADGE_CLASS[entry.inclusionState]) {
    const b = document.createElement("span");
    b.className = "badge badge-lock " + LOCK_BADGE_CLASS[entry.inclusionState];
    b.innerHTML = LOCK_SVG;
    tl.prepend(b);
  }
}

// Fallback sweep (exported): after a render, load every card image currently in
// (or near) the viewport. Guards against the IntersectionObserver missing cards
// observed before their layout height settled on the initial paint.
export function loadVisibleImages(root) {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  for (const img of (root || document).querySelectorAll(".card img[data-scryfall-id]")) {
    if (img.getAttribute("src")) continue;
    const r = img.getBoundingClientRect();
    if (r.bottom > -300 && r.top < vh + 300) setImg(img, imgObserver);
  }
}

// Hover-flip button for double-faced gallery cards.
function addFlip(img, data) {
  const faceImgs = (data?.faces || []).map((f) => f.image?.normal).filter(Boolean);
  const back = data?.image?.back || (faceImgs.length > 1 ? faceImgs[1] : null);
  const wrap = img.parentElement;
  if (!back || !wrap || wrap.querySelector(".card-flip")) return;
  let front = true;
  const b = document.createElement("button");
  b.className = "card-flip"; b.title = "Flip"; b.textContent = "⟳";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    front = !front;
    img.src = front ? (data.image.normal || faceImgs[0]) : back;
  });
  wrap.append(b);
}

function pct(n) { return (n == null) ? null : `${n}%`; }

function infoStrip(entry) {
  const wrap = document.createElement("div");
  wrap.className = "card-info";
  const ed = entry.edhrecData || {};
  const bits = [];
  if (ed.inclusion != null) bits.push(`<span title="EDHREC inclusion">${pct(ed.inclusion)}</span>`);
  if (ed.synergy != null) {
    const s = Math.round(ed.synergy * 100);
    bits.push(`<span title="EDHREC synergy">${s >= 0 ? "+" : ""}${s}%</span>`);
  }
  const priceText = formatPrice(entry.price?.usd);
  if (priceText) {
    const url = entry.price?.tcgplayerUrl;
    bits.push(url ? `<a href="${url}" target="_blank" rel="noopener" title="TCGplayer">${priceText}</a>` : priceText);
  }
  wrap.innerHTML = bits.join(" · ") || "&nbsp;";
  return wrap;
}

export function cardEl(item) {
  const { entry, secondary } = item;
  const state = getState();

  const legal = isLegal(entry);
  const card = document.createElement("div");
  // (R16) also require drawerOpen — selectedCardId sticks around after the
  // drawer closes (so it reopens on the same card next time), which was
  // leaving the blue selection border stuck on the last-viewed card even
  // with the side panel collapsed.
  const selected = state.drawerOpen && state.selectedCardId === entry.id;
  card.className = `card s-${entry.inclusionState}` + (legal ? "" : " illegal") + (selected ? " selected" : "");
  card.dataset.cardId = entry.id;
  if (!legal) {
    const fmt = String(getState().deck?.format || "this format").replace(/\b\w/, (c) => c.toUpperCase());
    card.title = `Illegal in ${fmt} — excluded from the deck`;
  }

  // image (or placeholder)
  const imgWrap = document.createElement("div");
  imgWrap.className = "card-img";
  if (entry.scryfallId) {
    const img = document.createElement("img");
    img.alt = entry.name;
    img.loading = "lazy";
    img.dataset.scryfallId = entry.scryfallId;
    const cached = dataCache.get(entry.scryfallId);
    if (cached?.image?.normal) img.src = cached.image.normal;
    else imgObserver.observe(img);
    imgWrap.append(img);
    if (cached) addFlip(img, cached);
  } else {
    const ph = document.createElement("div");
    ph.className = "card-placeholder";
    ph.textContent = entry.name;
    imgWrap.append(ph);
  }

  // Top-left badge stack: the illegal/lock badge on top (illegal trumps the lock),
  // then the "association" badge below it (a secondary-bucket instance) — same
  // size/shape as the lock, just a different icon.
  const mkBadge = (cls, text, title) => {
    const b = document.createElement("span");
    b.className = "badge " + cls;
    if (title) b.title = title;
    b.textContent = text;
    return b;
  };
  const tl = document.createElement("div");
  tl.className = "badge-stack-tl";
  if (!legal) {
    tl.append(mkBadge("badge-illegal", "⊘", `Not legal in ${getState().deck?.format || "this format"}`));
  } else if (LOCK_BADGE_CLASS[entry.inclusionState]) {
    const b = document.createElement("span");
    b.className = "badge badge-lock " + LOCK_BADGE_CLASS[entry.inclusionState];
    b.innerHTML = LOCK_SVG;
    tl.append(b);
  }
  if (secondary) {
    tl.append(mkBadge("badge-secondary", "🔗", "Also shown here via a secondary association"));
  }
  if (tl.childElementCount) imgWrap.append(tl);

  // (R10) Top-right stack: copy-limit warning sits next to the count badge
  // (was in the top-left stack) — overCopyLimit implies quantity > 1, so the
  // count badge is always present alongside it.
  const overLimit = overCopyLimit(entry);
  if (overLimit || (entry.quantity || 1) > 1) {
    const tr = document.createElement("div");
    tr.className = "badge-stack-tr";
    if ((entry.quantity || 1) > 1) tr.append(mkBadge("badge-qty", `×${entry.quantity}`, null));
    if (overLimit) {
      const fmt = getState().deck?.format || "commander";
      const warn = mkBadge("badge-warn", "", `${entry.quantity} copies — ${fmt} allows ${copyLimit(fmt)}`);
      warn.innerHTML = WARNING_SVG;
      tr.append(warn);
    }
    imgWrap.append(tr);
  }

  // hover state control (shared 5-state control, small). (WS9) shown for illegal
  // cards too — you can set inclusion; legality still trumps for the deck totals.
  const states = inclusionControl(entry, { size: "sm" });
  states.classList.add("card-states");
  imgWrap.append(states);

  card.append(imgWrap);
  if (state.showInfoStrip) card.append(infoStrip(entry));

  // click → open detail drawer; center the card in the gallery after the drawer
  // shoves (run after the ~180ms transition so positions have settled).
  card.addEventListener("click", () => {
    setState({ selectedCardId: entry.id });
    window.cdb?.openDrawer?.("card");
    // scrollIntoView(center) recomputes against the layout at call time, so it's
    // robust to the drawer-shove reflow. Run twice (after the shove, then again)
    // to catch any late reflow.
    const center = () => document.querySelector(`.card[data-card-id="${entry.id}"]`)
      ?.scrollIntoView({ block: "center", behavior: "auto" });
    setTimeout(center, 250);
    setTimeout(center, 560);
  });

  return card;
}

export { loadCardData };

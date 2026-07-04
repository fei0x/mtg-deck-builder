// stats.js — deck statistics modal (Chart.js v4).
// Contract: `openStats()` opens a near-full-screen modal of charts computed from
// the current deck's INCLUDED cards (locked_in + in). Charts are destroyed on close.
import { getState, isLegal } from "./state.js";
import { tagLabel } from "./bucketing.js";

const IN_STATES = new Set(["locked_in", "in"]);
const STATE_LABELS = {
  locked_in: "Locked In",
  in: "In",
  undecided: "Undecided",
  out: "Out",
  locked_out: "Locked Out",
};

// Read a theme token (CSS custom property) off :root, with a fallback hex.
function token(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Color-identity palette keyed by single-letter WUBRG (+ C for colorless).
function colorPalette() {
  return {
    W: token("--mana-w", "#f8f6d8"),
    U: token("--mana-u", "#c1d7e9"),
    B: token("--mana-b", "#bab1ab"),
    R: token("--mana-r", "#e49977"),
    G: token("--mana-g", "#a3c095"),
    C: token("--text-faint", "#687180"),
  };
}

const COLOR_ORDER = ["W", "U", "B", "R", "G", "C"];
const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colorless" };

// A small distinct categorical palette for type/tag charts (legible on dark bg).
const CATEGORICAL = [
  "#4c9aff", "#3fb950", "#e0b341", "#e49977", "#b48ead",
  "#56c0c0", "#d97aa6", "#9aa3b2", "#a3c095", "#c1d7e9", "#e06c75",
];

// CMC bucket label for a numeric cmc.
function cmcBucket(cmc) {
  const n = Math.floor(Number(cmc) || 0);
  return n >= 7 ? 7 : n;
}
const CMC_LABELS = ["0", "1", "2", "3", "4", "5", "6", "7+"];

function isLand(entry) {
  return typeof entry.cardType === "string" && /land/i.test(entry.cardType);
}
function isCreature(entry) {
  return typeof entry.cardType === "string" && /creature/i.test(entry.cardType);
}

// --- module-level so we can tear down on close ---
let charts = [];
let overlayEl = null;
let escHandler = null;

function destroyCharts() {
  for (const c of charts) {
    try { c.destroy(); } catch { /* ignore */ }
  }
  charts = [];
}

function closeStats() {
  destroyCharts();
  if (escHandler) {
    document.removeEventListener("keydown", escHandler);
    escHandler = null;
  }
  if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
  overlayEl = null;
}

// Compute all stats from the included cards (quantity-weighted).
function computeStats(deck, tagInfo) {
  const stateCounts = { locked_in: 0, in: 0, undecided: 0, out: 0, locked_out: 0 };
  let totalIncluded = 0;

  const cmcCounts = new Array(8).fill(0);            // by cmc bucket (non-land)
  const colorCounts = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const typeCounts = new Map();                       // cardType -> count
  const tagCounts = new Map();                        // primaryTag -> count
  // Mana curve by color (each bucket -> per-color count). A card with >1 color
  // contributes to each of its colors (so columns can exceed the card count).
  const curveByColor = COLOR_ORDER.reduce((m, c) => (m[c] = new Array(8).fill(0), m), {});

  let nonLandCmcSum = 0, nonLandCount = 0;
  let creatureCmcSum = 0, creatureCount = 0;

  for (const c of deck.cards) {
    const state = c.inclusionState;
    const qty = c.quantity || 1;
    if (state in stateCounts) stateCounts[state] += qty;
    // Illegal-for-format cards are excluded from every stat (A3) — their
    // inclusion is treated as unknown.
    if (!IN_STATES.has(state) || !isLegal(c, deck)) continue;
    totalIncluded += qty;

    // Color identity
    const ci = Array.isArray(c.colorIdentity) ? c.colorIdentity : [];
    if (ci.length === 0) {
      colorCounts.C += qty;
    } else {
      for (const sym of ci) {
        const key = String(sym).toUpperCase();
        if (key in colorCounts) colorCounts[key] += qty;
      }
    }

    // Card type breakdown (use stored singular cardType scalar)
    const type = c.cardType || "Other";
    typeCounts.set(type, (typeCounts.get(type) || 0) + qty);

    // Tag distribution (primary tag)
    const tag = c.primaryTag || "other";
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + qty);

    // Mana curve — lands excluded (lands have no meaningful CMC for a curve).
    if (!isLand(c)) {
      const b = cmcBucket(c.cmc);
      cmcCounts[b] += qty;
      nonLandCmcSum += (Number(c.cmc) || 0) * qty;
      nonLandCount += qty;
      // by-color (each color of the identity; colorless -> C)
      const buckets = ci.length === 0 ? ["C"] : ci.map((s) => String(s).toUpperCase());
      for (const k of buckets) {
        if (curveByColor[k]) curveByColor[k][b] += qty;
      }
      if (isCreature(c)) {
        creatureCmcSum += (Number(c.cmc) || 0) * qty;
        creatureCount += qty;
      }
    }
  }

  return {
    stateCounts,
    totalIncluded,
    cmcCounts,
    colorCounts,
    typeCounts,
    tagCounts,
    curveByColor,
    avgCmcNonLand: nonLandCount ? nonLandCmcSum / nonLandCount : 0,
    avgCmcCreature: creatureCount ? creatureCmcSum / creatureCount : 0,
    nonLandCount,
    creatureCount,
    tagInfo,
  };
}

// --- small DOM helpers (self-contained; do not depend on app.js) ---
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// A titled chart/stat panel wrapper.
function panel(title, bodyEl) {
  return h("div", { class: "stats-panel", style: "background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);padding:var(--sp-3);min-width:0;" },
    h("div", { style: "font-size:var(--fs-sm);color:var(--text-dim);margin-bottom:var(--sp-2);font-weight:600;" }, title),
    bodyEl
  );
}

function canvas(height = 240) {
  const wrap = h("div", { style: `position:relative;height:${height}px;` });
  const cv = document.createElement("canvas");
  wrap.append(cv);
  return { wrap, cv };
}

function newChart(cv, config) {
  const c = new window.Chart(cv, config);
  charts.push(c);
  return c;
}

export function openStats() {
  const state = getState();
  const deck = state.deck;
  if (!deck) {
    window.cdb?.toast?.("Open a deck first");
    return;
  }
  if (!window.Chart) {
    window.cdb?.toast?.("Charts unavailable (Chart.js not loaded)");
    return;
  }

  // Global Chart defaults for the dark theme. Animation OFF — it made charts
  // (esp. the doughnut) slow and could leave them blank if the modal hadn't laid
  // out yet when the animation ran.
  window.Chart.defaults.color = token("--text-dim", "#9aa3b2");
  window.Chart.defaults.borderColor = token("--border", "#2b313c");
  window.Chart.defaults.font.family = token("--font", "system-ui, sans-serif");
  window.Chart.defaults.animation = false;

  const s = computeStats(deck, state.tagInfo || {});
  const pal = colorPalette();
  const accent = token("--accent", "#4c9aff");
  const gridColor = token("--border", "#2b313c");

  // ---- Build modal shell ----
  const closeBtn = h("button", { class: "btn btn-icon", title: "Close", "aria-label": "Close" }, "✕");
  closeBtn.addEventListener("click", closeStats);

  const header = h("div", { class: "modal-header" },
    h("h3", {}, `Deck Statistics — ${deck.name || "Untitled"}`),
    closeBtn
  );

  const grid = h("div", {
    style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:var(--sp-3);",
  });
  const body = h("div", { class: "modal-body" }, grid);

  const modal = h("div", { class: "modal modal-lg", style: "width:min(1400px,96vw);max-height:94vh;display:flex;flex-direction:column;" },
    header, body);
  // make body the scroll region
  body.style.cssText = "padding:var(--sp-4);overflow:auto;";

  const overlay = h("div", { class: "modal-overlay" }, modal);
  // Close when clicking the dimmed backdrop (but not inside the modal).
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeStats(); });

  overlayEl = overlay;
  document.body.appendChild(overlay);

  escHandler = (e) => { if (e.key === "Escape") closeStats(); };
  document.addEventListener("keydown", escHandler);

  // ===== 1. Summary =====
  const summaryRows = h("div", { style: "display:flex;flex-direction:column;gap:6px;" });
  for (const key of ["locked_in", "in", "undecided", "out", "locked_out"]) {
    summaryRows.append(h("div", { style: "display:flex;justify-content:space-between;font-size:var(--fs-md);" },
      h("span", { style: "color:var(--text-dim);" }, STATE_LABELS[key]),
      h("span", { style: "font-weight:600;" }, String(s.stateCounts[key]))
    ));
  }
  const overCap = s.totalIncluded > 100;
  summaryRows.append(h("div", {
    style: `display:flex;justify-content:space-between;margin-top:var(--sp-2);padding-top:var(--sp-2);border-top:1px solid var(--border);font-size:var(--fs-lg);`,
  },
    h("span", {}, "Total included"),
    h("span", { style: `font-weight:700;color:${overCap ? token("--danger", "#f0566b") : token("--ok", "#3fb950")};` },
      `${s.totalIncluded} / 100`)
  ));
  grid.append(panel("Deck Count Summary", summaryRows));

  // ===== 6. Averages (text stat) — placed near top for quick reading =====
  const avgBody = h("div", { style: "display:flex;flex-direction:column;gap:var(--sp-2);" },
    h("div", { style: "display:flex;justify-content:space-between;" },
      h("span", { style: "color:var(--text-dim);" }, "Avg CMC (non-land)"),
      h("span", { style: "font-weight:700;font-size:var(--fs-xl);" }, s.avgCmcNonLand.toFixed(2))),
    h("div", { style: "display:flex;justify-content:space-between;" },
      h("span", { style: "color:var(--text-dim);" }, "Avg CMC (creatures)"),
      h("span", { style: "font-weight:700;font-size:var(--fs-xl);" }, s.avgCmcCreature.toFixed(2))),
    h("div", { style: "font-size:var(--fs-xs);color:var(--text-faint);margin-top:var(--sp-1);" },
      `${s.nonLandCount} non-land · ${s.creatureCount} creatures (included)`)
  );
  grid.append(panel("CMC Averages", avgBody));

  // ===== 2. Mana curve (bar) =====
  {
    const { wrap, cv } = canvas();
    grid.append(panel("Mana Curve (lands excluded)", wrap));
    newChart(cv, {
      type: "bar",
      data: {
        labels: CMC_LABELS,
        datasets: [{
          label: "Cards",
          data: s.cmcCounts,
          backgroundColor: accent,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: "Converted Mana Cost" }, grid: { color: gridColor } },
          y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: gridColor } },
        },
      },
    });
  }

  // ===== 5b. Mana curve by color (stacked) — nice-to-have =====
  {
    const { wrap, cv } = canvas();
    grid.append(panel("Mana Curve by Color (stacked)", wrap));
    const datasets = COLOR_ORDER.map((k) => ({
      label: COLOR_NAMES[k],
      data: s.curveByColor[k],
      backgroundColor: pal[k],
    })).filter((d) => d.data.some((v) => v > 0));
    newChart(cv, {
      type: "bar",
      data: { labels: CMC_LABELS, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } } },
        scales: {
          x: { stacked: true, grid: { color: gridColor } },
          y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: gridColor } },
        },
      },
    });
  }

  // ===== 3. Color identity (doughnut) =====
  {
    const { wrap, cv } = canvas();
    grid.append(panel("Color Identity", wrap));
    const labels = [], data = [], colors = [];
    for (const k of COLOR_ORDER) {
      if (s.colorCounts[k] > 0) {
        labels.push(COLOR_NAMES[k]);
        data.push(s.colorCounts[k]);
        colors.push(pal[k]);
      }
    }
    if (!data.length) {
      wrap.style.height = "auto";
      wrap.append(h("div", { style: "color:var(--text-faint);font-size:var(--fs-sm);" },
        "No color data for the included cards."));
    } else {
      newChart(cv, {
        type: "doughnut",
        data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: token("--bg-2", "#1d222b"), borderWidth: 2 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: "right", labels: { boxWidth: 12 } } },
        },
      });
    }
  }

  // ===== 4. Card type breakdown (bar) =====
  {
    const entries = [...s.typeCounts.entries()].sort((a, b) => b[1] - a[1]);
    const { wrap, cv } = canvas(Math.max(240, entries.length * 30 + 40));
    grid.append(panel("Card Type Breakdown", wrap));
    newChart(cv, {
      type: "bar",
      data: {
        labels: entries.map(([t]) => t),
        datasets: [{
          label: "Cards",
          data: entries.map(([, n]) => n),
          backgroundColor: entries.map((_, i) => CATEGORICAL[i % CATEGORICAL.length]),
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: gridColor } },
          y: { ticks: { autoSkip: false }, grid: { color: gridColor } },
        },
      },
    });
  }

  // ===== 5. Tag distribution (bar) =====
  {
    const entries = [...s.tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    // Grow the panel so EVERY tag label is shown (autoSkip off) without overlap.
    const { wrap, cv } = canvas(Math.max(240, entries.length * 28 + 40));
    grid.append(panel("Tag Distribution (primary tag)", wrap));
    newChart(cv, {
      type: "bar",
      data: {
        labels: entries.map(([t]) => tagLabel(t, s.tagInfo)),
        datasets: [{
          label: "Cards",
          data: entries.map(([, n]) => n),
          backgroundColor: entries.map((_, i) => CATEGORICAL[i % CATEGORICAL.length]),
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: gridColor } },
          y: { ticks: { autoSkip: false }, grid: { color: gridColor } },
        },
      },
    });
  }

  // Force a reflow once layout has settled — guards against charts initialising at
  // 0 size in the just-opened modal and staying blank until a hover (WS3). Belt +
  // braces: two rAFs (after paint) AND a delayed fallback for slow grid layout.
  const reflow = () => { for (const c of charts) { try { c.resize(); } catch { /* ignore */ } } };
  requestAnimationFrame(() => requestAnimationFrame(reflow));
  setTimeout(reflow, 250);
}

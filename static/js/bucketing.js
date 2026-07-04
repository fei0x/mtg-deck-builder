// bucketing.js — pure logic to group a deck's cards into ordered sections for
// the active bucketing mode (tag | type | cost | rarity). The commander always
// gets a leading "Commander" section. Empty sections are dropped by the caller.

const STATE_ORDER = { locked_in: 0, in: 1, undecided: 2, out: 3, locked_out: 4 };

const TAG_ORDER = [
  "ramp", "card-draw", "removal", "board-wipe", "counterspell", "plus-one-counters",
  "burn", "life-gain", "free-cast", "anthem", "pump", "tokens", "tutor", "recursion", "protection", "lands", "other",
];
const TYPE_ORDER = [
  "Creature", "Instant", "Sorcery", "Artifact", "Enchantment",
  "Planeswalker", "Battle", "Land", "Other",
];
const RARITY_ORDER = ["mythic", "rare", "uncommon", "common", "special", "bonus"];

export function titleCase(s) {
  return String(s || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function tagLabel(key, tagInfo) {
  if (key === "commander") return "Commander";
  return tagInfo?.[key]?.display || titleCase(key);
}

// Legality for a format (mirrors state.isLegal; kept local so this stays pure).
function entryLegal(entry, fmt) {
  const leg = entry.legalities;
  if (leg && typeof leg === "object" && Object.keys(leg).length) return leg[fmt] === "legal";
  if (typeof entry.commanderLegal === "boolean" && fmt === "commander") return entry.commanderLegal;
  return true;
}

// ---- sorting within a section ----
export function sortItems(items, { inclusionSort = true, secondary = "name", fmt = "commander" } = {}) {
  const bySecondary = (a, b) => {
    const ea = a.entry, eb = b.entry;
    switch (secondary) {
      case "cmc": return (ea.cmc ?? 99) - (eb.cmc ?? 99) || ea.name.localeCompare(eb.name);
      case "synergy":
        return (eb.edhrecData?.synergy ?? -1) - (ea.edhrecData?.synergy ?? -1);
      case "inclusion":
        return (eb.edhrecData?.inclusion ?? -1) - (ea.edhrecData?.inclusion ?? -1);
      case "price":
        return (parseFloat(eb.price?.usd) || 0) - (parseFloat(ea.price?.usd) || 0);
      case "rarity":
        return RARITY_ORDER.indexOf(ea.rarity) - RARITY_ORDER.indexOf(eb.rarity);
      default: return ea.name.localeCompare(eb.name);
    }
  };
  return [...items].sort((a, b) => {
    if (inclusionSort) {
      // (WS10) illegal cards always sort to the END, ahead of inclusion order.
      const la = entryLegal(a.entry, fmt), lb = entryLegal(b.entry, fmt);
      if (la !== lb) return la ? -1 : 1;
      const d = STATE_ORDER[a.entry.inclusionState] - STATE_ORDER[b.entry.inclusionState];
      if (d) return d;
    }
    return bySecondary(a, b);
  });
}

// ---- CMC breakpoint buckets (per requirements 03 §CMC Bucketing) ----
export function costBuckets(breakpoints) {
  const bps = [...new Set((breakpoints || []).map(Number))].filter((n) => n >= 0).sort((a, b) => a - b);
  if (!bps.length) return [{ label: "All", lo: -Infinity, hi: Infinity }];
  const out = [];
  if (bps[0] > 0) {
    const hi = bps[0] - 1;
    out.push({ label: hi === 0 ? "0" : `< ${bps[0]}`, lo: 0, hi });
  }
  bps.forEach((bp, i) => {
    out.push({ label: String(bp), lo: bp, hi: bp });
    if (i < bps.length - 1 && bps[i + 1] > bp + 1) {
      const lo = bp + 1, hi = bps[i + 1] - 1;
      out.push({ label: lo === hi ? String(lo) : `${lo}–${hi}`, lo, hi });
    }
  });
  out.push({ label: `> ${bps[bps.length - 1]}`, lo: bps[bps.length - 1] + 1, hi: Infinity });
  return out;
}

function cmcOf(entry) {
  const v = Math.round(entry.cmc ?? 0);
  return isNaN(v) ? 0 : v;
}

// ---- main ----
export function bucketize(deck, mode, settings = {}, tagInfo = {}, showAll = false) {
  const cards = deck?.cards || [];
  const sortOpts = { inclusionSort: settings.inclusionSort !== false, secondary: settings.secondarySort || "name",
    fmt: deck?.format || "commander" };

  const commanders = cards.filter((c) => c.isCommander).map((e) => ({ entry: e, secondary: false }));
  const rest = cards.filter((c) => !c.isCommander);

  const sections = [];
  const push = (key, label, items) => { if (items.length) sections.push({ key, label, items: sortItems(items, sortOpts) }); };

  // (WS7) "All" = one long flat list (no bucketing), commander included.
  if (mode === "all") {
    const all = cards.map((e) => ({ entry: e, secondary: false }));
    return all.length ? [{ key: "all", label: "All Cards", items: sortItems(all, sortOpts) }] : [];
  }

  if (commanders.length) sections.push({ key: "commander", label: "Commander", items: commanders });

  if (mode === "type") {
    // Mirror tag mode: primary type bucket; multi-type cards also appear in their
    // other type buckets (badged) when showInAllTypeBuckets is on.
    const groups = new Map();
    const add = (key, entry, secondary) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ entry, secondary }); };
    for (const e of rest) {
      const types = (e.cardTypes && e.cardTypes.length) ? e.cardTypes : [e.cardType || "Other"];
      const primary = e.cardType || types[0];
      add(primary, e, false);
      // (R5) the global "show in all buckets" view toggle is grouping-agnostic.
      if (showAll || e.showInAllTypeBuckets) for (const t of types) if (t !== primary) add(t, e, true);
    }
    for (const t of TYPE_ORDER) if (groups.has(t)) push(t, t, groups.get(t));
    for (const [t, items] of groups) if (!TYPE_ORDER.includes(t)) push(t, titleCase(t), items);
  } else if (mode === "rarity") {
    const groups = new Map();
    for (const e of rest) { const r = e.rarity || "unknown"; (groups.get(r) || groups.set(r, []).get(r)).push({ entry: e, secondary: false }); }
    for (const r of RARITY_ORDER) if (groups.has(r)) push(r, titleCase(r), groups.get(r));
    for (const [r, items] of groups) if (!RARITY_ORDER.includes(r)) push(r, titleCase(r), items);
  } else if (mode === "cost") {
    const buckets = costBuckets(settings.cmcBreakpoints);
    for (const b of buckets) {
      const items = rest.filter((e) => { const v = cmcOf(e); return v >= b.lo && v <= b.hi; })
        .map((e) => ({ entry: e, secondary: false }));
      push(`cmc:${b.label}`, b.label, items);
    }
  } else {
    // tag mode (default): primary tag bucket; showInAllTagBuckets adds secondary instances
    const groups = new Map();
    const add = (key, entry, secondary) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ entry, secondary }); };
    for (const e of rest) {
      add(e.primaryTag || "other", e, false);
      if (showAll || e.showInAllTagBuckets) for (const t of e.tags || []) if (t !== e.primaryTag) add(t, e, true);
    }
    // (G1) honour the deck's custom tag order if set, else the canonical order.
    const order = (Array.isArray(settings.tagOrder) && settings.tagOrder.length) ? settings.tagOrder : TAG_ORDER;
    const seen = new Set();
    for (const t of order) if (groups.has(t)) { push(t, tagLabel(t, tagInfo), groups.get(t)); seen.add(t); }
    for (const [t, items] of groups) if (!seen.has(t)) push(t, tagLabel(t, tagInfo), items);
  }
  return sections;
}

const IN = new Set(["locked_in", "in"]);
// Quantity-weighted: a section with e.g. 10 Forest (one entry, qty 10) reports 10,
// not 1 — so a Lands header reflects how many lands you actually run.
export function sectionCounts(items) {
  let inN = 0, total = 0;
  for (const i of items) {
    const q = i.entry.quantity || 1;
    total += q;
    if (IN.has(i.entry.inclusionState)) inN += q;
  }
  return { in: inN, total };
}

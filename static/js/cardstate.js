// cardstate.js — change a card's inclusion state with optimistic update + a
// confirmation popover when leaving a locked state. Shared by the gallery hover
// control (08) and the drawer slider (09).

import { api } from "./api.js";
import { getState, setState } from "./state.js";

export const STATE_LABELS = {
  locked_in: "Locked In", in: "In", undecided: "Undecided",
  out: "Out", locked_out: "Locked Out",
};
// (R9) Locked In and Locked Out share the SAME drawn lock glyph (not an emoji —
// emoji can't be recoloured via CSS, which is why locked_out used to render the
// same YELLOW lock as locked_in on the gallery card badge). Colour is applied by
// the caller via CSS `color` (the path uses currentColor).
export const LOCK_SVG =
  '<svg viewBox="0 0 22 22" aria-hidden="true"><path fill="currentColor" ' +
  'd="M11 2.2c-2.34 0-4.24 1.9-4.24 4.24v2.4H5.6c-.77 0-1.4.63-1.4 1.4v8.16c0 .77.63 1.4 1.4 1.4h10.8' +
  'c.77 0 1.4-.63 1.4-1.4V10.24c0-.77-.63-1.4-1.4-1.4h-1.16v-2.4c0-2.34-1.9-4.24-4.24-4.24zm0 1.8' +
  'c1.35 0 2.44 1.1 2.44 2.44v2.4H8.56v-2.4c0-1.35 1.1-2.44 2.44-2.44zM11 13.1c.83 0 1.5.67 1.5 1.5' +
  ' 0 .58-.33 1.08-.81 1.33l.31 2.17H9.99l.32-2.17a1.5 1.5 0 0 1-.81-1.33c0-.83.67-1.5 1.5-1.5z"/></svg>';
export const STATE_ICONS = {
  locked_in: LOCK_SVG, in: "✓", undecided: "?", out: "✗", locked_out: LOCK_SVG,
};
// (R11) copy-limit warning — a red triangle + white "!" (not yellow: in this
// app's colour dialect, yellow/gold means "locked in", not "caution"). Bare
// icon, no chip background — used on the gallery card badge and the drawer's
// qty-row warning.
export const WARNING_SVG =
  '<svg viewBox="0 0 22 22" aria-hidden="true">' +
  '<path d="M11 2.4 L20.6 19.4 H1.4 Z" fill="var(--danger)" stroke="var(--danger)" stroke-width="1.4" stroke-linejoin="round"/>' +
  '<rect x="9.7" y="8.3" width="2.6" height="6.4" rx="1.3" fill="#fff"/>' +
  '<circle cx="11" cy="16.6" r="1.5" fill="#fff"/></svg>';
export const STATE_ORDER = ["locked_in", "in", "undecided", "out", "locked_out"];
const NEEDS_CONFIRM = new Set(["locked_in", "locked_out"]);

// Shared 5-state control (round icon buttons). Used by the gallery hover overlay
// and the drawer. `size` adds a modifier class for context-specific sizing.
export function inclusionControl(entry, { size = "md" } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `incl-control incl-${size}`;
  for (const st of STATE_ORDER) {
    const b = document.createElement("button");
    b.className = "incl-btn cs-" + st + (entry.inclusionState === st ? " active" : "");
    b.title = STATE_LABELS[st];
    b.innerHTML = STATE_ICONS[st];
    b.addEventListener("click", (e) => { e.stopPropagation(); setCardState(entry, st, b); });
    wrap.append(b);
  }
  return wrap;
}

// Exported (R9 WS2) so the keyboard-shortcut handler can apply a state directly
// (optimistic update + rollback-on-failure) without going through the
// mouse-driven confirm popover in setCardState — the numpad shortcuts have
// their own keyboard-native arm/confirm step instead (see app.js).
export async function applyState(entry, newState) {
  const s = getState();
  if (!s.deck) return;
  const prev = entry.inclusionState;
  if (prev === newState) return;
  entry.inclusionState = newState; // optimistic
  setState({});
  // A sort like "In first" can move this card to a new spot in the gallery the
  // instant its state changes. If it's the card currently open in the drawer,
  // scroll to reveal where it landed instead of leaving the view pointed at
  // empty space. (This is independent of Next/Prev, which freezes its own
  // walk order across state changes and does its own post-navigation scroll.)
  if (getState().drawerOpen && getState().selectedCardId === entry.id) {
    setTimeout(() => document.querySelector(`#gallery-body .card[data-card-id="${entry.id}"]`)
      ?.scrollIntoView({ block: "center", behavior: "auto" }), 60);
  }
  try {
    await api.updateCard(s.deck.id, entry.id, { inclusionState: newState });
  } catch (e) {
    entry.inclusionState = prev; // rollback
    setState({});
    window.cdb?.toast?.("Couldn't update card: " + e.message);
  }
}

function closeConfirms() {
  document.querySelectorAll(".confirm-popover").forEach((p) => p.remove());
}

function showConfirm(anchor, message, onYes) {
  closeConfirms();
  const pop = document.createElement("div");
  pop.className = "confirm-popover";
  const msg = document.createElement("div");
  msg.textContent = message;
  const actions = document.createElement("div");
  actions.className = "actions";
  const no = document.createElement("button");
  no.className = "btn"; no.textContent = "Cancel";
  const yes = document.createElement("button");
  yes.className = "btn btn-accent"; yes.textContent = "Change";
  no.addEventListener("click", (e) => { e.stopPropagation(); closeConfirms(); });
  yes.addEventListener("click", (e) => { e.stopPropagation(); closeConfirms(); onYes(); });
  actions.append(no, yes);
  pop.append(msg, actions);
  document.body.append(pop);

  const r = anchor.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 130)}px`;
  pop.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;

  setTimeout(() => {
    document.addEventListener("mousedown", function handler(ev) {
      if (!pop.contains(ev.target)) { closeConfirms(); document.removeEventListener("mousedown", handler); }
    });
  }, 0);
}

export function setCardState(entry, newState, anchor) {
  const prev = entry.inclusionState;
  if (prev === newState) return;
  if (NEEDS_CONFIRM.has(prev)) {
    showConfirm(anchor,
      `"${entry.name}" is ${STATE_LABELS[prev]}. Change to ${STATE_LABELS[newState]}?`,
      () => applyState(entry, newState));
  } else {
    applyState(entry, newState);
  }
}

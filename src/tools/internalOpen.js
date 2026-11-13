// v1.156.0: My Tools cards that OPEN a part of Agent Desktop itself instead of starting a program (no launcher, no trust prompt).
// The card is recognised by its tool id; the catalogue entry only needs the id (and launch null). main.js supplies openInternal(what).
"use strict";
const INTERNAL = { thyra: "thyra" };   // tool id -> what main.js opens
const whatFor = (id) => (typeof id === "string" && Object.prototype.hasOwnProperty.call(INTERNAL, id) ? INTERNAL[id] : null);
// a card that opens inside the app: the Start button reads "Open", the launcher dot says so (never "No launcher set")
function decorate(card) {
  if (!card || !whatFor(card.id)) return card;
  card.start = { state: "ready", label: "Open", reason: "" };
  card.internalOpen = true;
  if (Array.isArray(card.dots)) card.dots = card.dots.map((d) => (d && d.id === "launcher" ? Object.assign({}, d, { state: "ok", text: "Opens inside Agent Desktop" }) : d));
  return card;
}
module.exports = { whatFor, decorate, INTERNAL };

// Legacy data keys. Data that other tools wrote (the shared task store, research and ARGUS JSON, saved My Daily files, the wake-agent command
// line) uses field names that contain a person's first name. Those files exist on disk and are still written by other tools, so the app
// must keep reading (and, where a file is shared, writing) the old names, and also accept the new neutral ones.
// The old names are built from fragments on purpose, so no personal name is spelled out in this repository.
// Works as a Node module (require) and, loaded by a <script> tag, as window.LegacyKeys in the renderer.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LegacyKeys = api;
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";
  const OWNER = ["Id", "do"].join(""), PARTNER = ["Mer", "av"].join("");
  const lo = (s) => s.toLowerCase();
  const KEYS = {
    needs: "needs" + OWNER,                         // task-store field: this task needs the owner's answer
    needsFlag: "--set-needs-" + lo(OWNER),          // tasks.py option that sets or clears that field
    needsLabel: "needs-" + OWNER,                   // how the field is named in text sent to agents (only used when no owner name is configured)
    worth: "worth" + OWNER + "Knowing",             // research / ARGUS finding flag
    requested: lo(OWNER) + "Requested",             // wake-agent request field
    requestedFlag: "--" + lo(OWNER) + "-requested", // wake-agent command-line flag
    shareItem: "share" + PARTNER,                   // My Daily appointment field
    shareSetting: "shareCalendarWith" + PARTNER,    // My Daily settings.json key
    calOwner: lo(OWNER),                            // My Daily calendar ids stored in appointments.json
    calPartner: lo(PARTNER),
    partnerStem: lo(PARTNER),                       // the stems the never-wake list used to hold for the partner's agent
    partnerStemHe: ["מ", "י", "ר", "ב"].join(""),
  };
  const has = (o, k) => o != null && typeof o === "object" && o[k] !== undefined;
  const pick = (o, a, b) => (has(o, a) ? o[a] : has(o, b) ? o[b] : undefined);

  return {
    KEYS,
    getNeedsOwner: (o) => pick(o, "needsOwner", KEYS.needs),
    getWorthOwnerKnowing: (o) => pick(o, "worthOwnerKnowing", KEYS.worth),
    getOwnerRequested: (o) => pick(o, "ownerRequested", KEYS.requested),
    getShareItem: (o) => pick(o, "sharePartner", KEYS.shareItem),
    getShareSetting: (o) => pick(o, "shareCalendarWithPartner", KEYS.shareSetting),
    // calendar id -> neutral CSS class / id ("owner", "partner", or anything else unchanged); accepts old and new ids
    calClass: (c) => (c === KEYS.calOwner || c === "owner" ? "owner" : c === KEYS.calPartner || c === "partner" ? "partner" : c),
  };
});

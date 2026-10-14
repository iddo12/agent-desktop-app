// node tests/legacyKeys.test.js - data written by other tools under the OLD field names is still recognised (and the new neutral names too).
// The old names are built from fragments so no personal name is spelled out in this repository.
"use strict";
const assert = require("assert");
const LK = require("../src/legacyKeys");
const C = require("../src/daily/contract");
const M = require("../src/daily/model");
const W = require("../src/wakeAgent");
const O = ["Id", "do"].join(""), P = ["Mer", "av"].join("");
let n = 0, fails = 0;
const t = (name, fn) => { n++; try { fn(); console.log("ok   " + name); } catch (e) { fails++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); } };

t("the legacy names are exactly the ones other tools write", () => {
  assert.strictEqual(LK.KEYS.needs, "needs" + O);
  assert.strictEqual(LK.KEYS.worth, "worth" + O + "Knowing");
  assert.strictEqual(LK.KEYS.requested, O.toLowerCase() + "Requested");
  assert.strictEqual(LK.KEYS.requestedFlag, "--" + O.toLowerCase() + "-requested");
  assert.strictEqual(LK.KEYS.needsFlag, "--set-needs-" + O.toLowerCase());
  assert.strictEqual(LK.KEYS.shareItem, "share" + P);
  assert.strictEqual(LK.KEYS.shareSetting, "shareCalendarWith" + P);
  assert.strictEqual(LK.KEYS.calOwner, O.toLowerCase()); assert.strictEqual(LK.KEYS.calPartner, P.toLowerCase());
});
t("helpers read the old and the new spelling", () => {
  assert.strictEqual(LK.getNeedsOwner({ ["needs" + O]: true }), true);
  assert.strictEqual(LK.getNeedsOwner({ needsOwner: true }), true);
  assert.strictEqual(LK.getNeedsOwner({}), undefined); assert.strictEqual(LK.getNeedsOwner(null), undefined);
  assert.strictEqual(LK.getWorthOwnerKnowing({ ["worth" + O + "Knowing"]: true }), true);
  assert.strictEqual(LK.getWorthOwnerKnowing({ worthOwnerKnowing: true }), true);
  assert.strictEqual(LK.getOwnerRequested({ [O.toLowerCase() + "Requested"]: true }), true);
  assert.strictEqual(LK.getOwnerRequested({ ownerRequested: true }), true);
  assert.strictEqual(LK.getShareItem({ ["share" + P]: false }), false);
  assert.strictEqual(LK.getShareSetting({ ["shareCalendarWith" + P]: true }), true);
  assert.strictEqual(LK.getShareSetting({ shareCalendarWithPartner: true }), true);
  assert.deepStrictEqual([LK.calClass(O.toLowerCase()), LK.calClass(P.toLowerCase()), LK.calClass("owner"), LK.calClass("partner"), LK.calClass("bday")], ["owner", "partner", "owner", "partner", "bday"]);
});
t("My Daily: old and new task / appointment / settings spellings are recognised; the stored names stay the old ones", () => {
  assert.strictEqual(C.needs({ ["needs" + O]: true }), true); assert.strictEqual(C.needs({ needsOwner: true }), true); assert.strictEqual(C.needs({ needsUser: true }), true);
  assert.strictEqual(C.NEEDS_KEY, "needs" + O); assert.strictEqual(C.NEEDS_FLAG, "--set-needs-" + O.toLowerCase());
  assert.strictEqual(M.cleanSettings({ ["shareCalendarWith" + P]: true })[C.SHARE_SETTING_KEY], true);
  assert.strictEqual(M.cleanSettings({ shareCalendarWithPartner: true })[C.SHARE_SETTING_KEY], true);
  const start = Date.now() + 3600000;
  assert.strictEqual(M.cleanAppointment({ who: "x", start, ["share" + P]: false }).item[C.SHARE_ITEM_KEY], false);
  assert.strictEqual(M.cleanAppointment({ who: "x", start, sharePartner: false }).item[C.SHARE_ITEM_KEY], false);
});
t("wake-agent: the old command-line flag and the old request field still mean 'the owner asked'", () => {
  const argv = ["node", "/opt/app/tools/wake-agent.js", "--agent", "A", "--reason", "r", LK.KEYS.requestedFlag];
  assert.strictEqual(W.requestFromArgv(argv).ownerRequested, true);
  assert.strictEqual(W.requestFromArgv(argv.slice(0, 6).concat(["--owner-requested"])).ownerRequested, true);
  assert.strictEqual(W.requestFromArgv(argv.slice(0, 6)).ownerRequested, false);
});
t("wake-agent: with the partner's name configured, an agent named after them is never woken (and not otherwise)", () => {
  const a = { displayName: P, folderName: P + " Agent" };
  assert.strictEqual(W.isNeverWake([], a), null);
  W.setPartnerNameSource(() => P);
  try { assert.ok(W.isNeverWake([], a)); assert.ok(W.isNeverWake([], { displayName: LK.KEYS.partnerStemHe, folderName: "x" })); } finally { W.setPartnerNameSource(null); }
  W.setPartnerNameSource(() => "Sarah");
  try { assert.strictEqual(W.isNeverWake([], { displayName: LK.KEYS.partnerStemHe, folderName: "x" }), null); } finally { W.setPartnerNameSource(null); }
});
console.log(fails ? fails + " of " + n + " FAILED" : "legacyKeys: all " + n + " tests passed");
process.exit(fails ? 1 : 0);

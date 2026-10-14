"use strict";
// My Daily: names that are part of a STORED or WIRE contract (v1.121.0). They are deliberately not renamed: existing data files, the
// shared task store and the tasks.py command line already use them, and renaming would make existing data stop loading.
// Everything the person SEES (names, labels, messages to agents) comes from configuration (ownerName / partnerName) instead.
// This is the one daily file where these legacy names may appear (see tests/noHardcodedPaths.allow.json).

const L = require("../legacyKeys");
const NEEDS_KEY = L.KEYS.needs;                  // task field in the shared task store (schema agent-tasks/1)
const NEEDS_ALIAS = "needsUser";                // neutral alias accepted when reading a task
const NEEDS_FLAG = L.KEYS.needsFlag;          // tasks.py option that clears or sets the field
const NEEDS_LABEL = "needs-owner";               // how the field is named in the text we send to agents
const CAL_OWNER = L.KEYS.calOwner;                       // calendar owner id kept in appointments.json and as a CSS class
const CAL_PARTNER = L.KEYS.calPartner;                    // calendar partner id kept in appointments.json and as a CSS class
const SHARE_ITEM_KEY = L.KEYS.shareItem;            // appointment field: "the partner can see this entry"
const SHARE_SETTING_KEY = L.KEYS.shareSetting; // settings.json key: share my calendar with the partner

// Does this task (a raw store item or a mapped task) need the owner's answer?
const needs = (t) => !!(t && (t[NEEDS_KEY] || t[NEEDS_ALIAS] || L.getNeedsOwner(t)));
// Reads both the old and the new spelling of the appointment / settings keys.
const shareItem = (a) => L.getShareItem(a);
const shareSetting = (s) => L.getShareSetting(s);

module.exports = { NEEDS_KEY, NEEDS_ALIAS, NEEDS_FLAG, NEEDS_LABEL, CAL_OWNER, CAL_PARTNER, SHARE_ITEM_KEY, SHARE_SETTING_KEY, needs, shareItem, shareSetting, calClass: L.calClass };

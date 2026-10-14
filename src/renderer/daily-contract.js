// My Daily (renderer): the few names that belong to the STORED data and so must not change (v1.121.0). They are ids and field names only,
// never shown to the person: what is shown (names, labels) comes from the configuration through the load payload.
// Loaded before daily.js. This is the one renderer file where the legacy names may appear (see tests/noHardcodedPaths.allow.json).
(function () {
  "use strict";
  const L = window.LegacyKeys;   // src/legacyKeys.js, loaded before this file
  window.dailyContract = {
    CAL_OWNER: L.KEYS.calOwner,                          // calendar owner id in appointments.json and the CSS class of its colour
    CAL_PARTNER: L.KEYS.calPartner,                       // calendar partner id and colour class
    SHARE_ITEM_KEY: L.KEYS.shareItem,               // appointment field: the partner can see this entry
    SHARE_SETTING_KEY: L.KEYS.shareSetting,
    shareItem: L.getShareItem, shareSetting: L.getShareSetting, calClass: L.calClass, // settings.json key: share my calendar with the partner
    // main returns reason "needs-setup" when a helper (the task tool, Python) is not configured; this is what the person reads.
    reasonText: (reason) => (reason === "needs-setup" ? "This part needs a one-time setup. Open Setup and choose the tasks tool and Python." : reason),
  };
})();

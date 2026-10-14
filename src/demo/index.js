// Demo mode entry (v1.86.0). Without AGENT_DESKTOP_DEMO=1 this loads nothing else and the app behaves exactly as before.
"use strict";
if (process.env.AGENT_DESKTOP_DEMO === "1") module.exports = require("./runtime");
else module.exports = { ON: false };

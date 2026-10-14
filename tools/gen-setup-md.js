#!/usr/bin/env node
"use strict";
// Generates SETUP.md at the repo root from the feature registry (the same text as "Copy setup instructions for Claude" in the app),
// so the two can never drift. Run after changing src/features.js or the keys in src/appConfig.js:   node tools/gen-setup-md.js
// tests/features.test.js fails when SETUP.md is out of date.
const fs = require("fs");
const path = require("path");
const features = require("../src/features");

function render() { return features.agentInstructions(null, { generic: true }); }
module.exports = { render };

if (require.main === module) {
  const file = path.join(__dirname, "..", "SETUP.md");
  fs.writeFileSync(file, render(), "utf8");
  console.log("wrote " + file);
}

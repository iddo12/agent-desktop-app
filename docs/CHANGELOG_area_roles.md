## v1.121.0 - ARGUS works on any computer: the cast of agent roles is a setting

Text for the release notes (area: roles, completes ARGUS).

- **Agent roles are settings.** Setup > ARGUS now has optional fields for your lead agent, security agent, maintenance agent and SEO agent (the exact agent folder name; a `*` at the end matches the start of the name). Nothing is assumed: a computer without roles still gets ARGUS with every report, finding and idea it finds, just without the role-specific score tiles and "Discuss with ..." buttons.
- **Job prefixes and short names** (optional): which scheduled-job names belong to which role, and shorter display names for long agent folders.
- **ARGUS is fully set up from Setup.** On a computer where the status folder is missing it still shows the calm "Set up" card.
- The wake-agent pipe accepts callers only from the lead and security folders you configured (exact folder names; none configured = nobody can wake agents). My Library "write to the lead agent" and the maintenance agent's notes-file name follow the same settings.

Config keys: `roleCoo`, `roleSecurity`, `roleOptimization`, `roleSeo`, `argusJobPrefixes` (`PREFIX=role;PREFIX=role`, roles coo/security/optimization/seo), `argusShortNames` (`Folder=Short;...`). Original owner's values are in tests/legacyParity.json (entries role.*, argus.jobPrefixes, argus.shortNames); `tools/write-migration-config.js --from-legacy` writes them.

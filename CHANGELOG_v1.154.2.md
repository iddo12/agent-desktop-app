# v1.154.2 - My Designs sync + gallery, IRIS "Mark all read", approvals chip no longer covers the Queue button, Skip fix, spellcheck, update downgrade guard (2026-11-06, Security, branch release/1.154.2 off public main e2259e4)
- IRIS: "Mark all read (dismiss)" in the "Waiting for your ..." section clears pending deliveries without handing them to an agent (new IPC `iris-dismiss-pending`, audit event `dismissed`; inbox files stay on disk).
- My Designs: "Sync with <partner>" button and a merged gallery (own + partner designs, `M-` ids), filter fixes. The sync tool comes from the shared tools folder; the partner name comes from configuration.
- Approvals chip moved off the bottom-right corner (it covered the Queue button) to the bottom-left.
- Waiting bar (layout D): Skip hides the card until its question changes or "Show N skipped" is clicked.
- Spellcheck English + Hebrew with right-click suggestions and "Add to dictionary".
- Updates: a checkout whose public main is OLDER than the running version no longer offers a downgrade.
- Status line: sweeps orphan rate-limit .tmp files older than 10 minutes.
- Tests: designs.test.js extended (merged gallery, sync flow). Rollback: git revert the release commit.
- Review fixes (Software Engineering, same day): `iris-dismiss-pending` goes through guard() (main window only); the partner folder/origin/script names are neutral (`partner`, `sync_designs_with_partner.py`), no person's name in the source; the flaky `iris.test.js` identity assertion (random base64 could contain "Sk") now checks the secret is absent from the public part.

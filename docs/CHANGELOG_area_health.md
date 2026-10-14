## My Health on the configuration layer (area Health)

- The health folder now comes from the configuration (`healthParent`) instead of a folder built into the app. The vault is `<health folder>\vault`, the store is `<vault>\extracted`, and the visual pane reads `<vault>\pane_feed\health_pane.json`.
- Until a health folder is set up, My Health shows its calm "not set up" state and nothing is read or written. A change made in Setup applies after the next start of the app.
- When Setup made the folder and the vault is not in it yet, the app creates `vault` and its `.health-root` marker once. An existing vault is never touched.
- Every protection stays: no network or UNC paths, no `..` or short names, no junctions or redirected drives, no cloud-synced folders, the folder must sit inside the configured health folder and carry the marker, and the sandbox never uses the configured vault.
- For the original owner nothing changes: the migration config reproduces the old folder (parity entry `health.HEALTH_PARENT`).

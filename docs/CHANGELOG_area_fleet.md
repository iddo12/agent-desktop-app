## Shared fleet and IRIS wording on the configuration layer (area: fleet)

- The Shared fleet tile now reads its folder from Setup (`exchangeDir`) instead of a fixed path. Not set up: the tile is dimmed, the pane explains and offers "Set up"; nothing is read or polled. Turned off: the tile is hidden.
- The two mailbox sub-folders (`exchangeInboxName`, `exchangeOutboxName`), your name, the other person's name, the link's label (`fleetLabel`) and the lead role (`leadRole`) are settings. An installation that keeps the existing values sees no change in files, names or wording.
- IRIS wording ("your COO agent", message placeholder, waiting section) uses the configured lead role; incoming IRIS messages go to the agent whose name contains that role, and wait when no role is set. IRIS crypto, gateway, service and the consent gate are untouched.
- The "Dropbox has not synced" note now says "its sync has not finished yet".

## My Finance on the configuration layer (area Finance)

- The finance folder (vault) default now comes from the configuration (`financeVault`) instead of a folder built into the app; with nothing set it is the app's own `finance-vault` folder. Order is unchanged: the `AGENT_DESKTOP_FINANCE_DIR` environment variable, then the saved setting, then the configured default. Cloud-synced and network folders are still refused.
- Setup changes to the folder apply without restarting the app.
- The accountant question list says "chase me" instead of a fixed first name.
- For the original owner nothing changes: the migration config reproduces the old vault folder (parity entry `finance.DEFAULT_VAULT`).

## My Finance Home from the finance feed (v1.129.0, slice 1)

- Read-only feed (`financeFeedPath`, `financeLoginLinks` configuration keys), validator, reader, `finance-feed` IPC channel and a Home tab. Details: `docs/CHANGELOG_v1.129.0.md`. Feed schema: Software Engineering `my_finance_feed_schema_v0.2.md`.

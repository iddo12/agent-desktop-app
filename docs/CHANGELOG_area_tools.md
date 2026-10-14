## Tools on the configuration layer (area Tools)

- The Tools list (tools.json), the folders tool launchers may sit in, and the "Coming up" strip now come from the configuration (`toolsCatalogue`, `toolsAllowedRoots`, `workspaceRoot`) instead of folders built into the app.
- On a computer where Tools is not set up, the tab shows a calm "Tools needs a quick setup" card with a Set up button (opens the Setup panel) instead of an error; launching is refused until it is set up.
- Setup changes take effect without restarting the app.
- For the original owner nothing changes: the migration config reproduces the old folders exactly (parity entries `tools.catalogue`, `launcher.DEFAULT_ROOTS`, `tools.registryBase`).
- Fixed a latent typo in the System32 path fallback in the launcher.

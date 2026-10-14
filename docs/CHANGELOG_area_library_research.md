## Library and My Research on the configuration layer (areas Library, Research)

- The registry folder, the folders scanned for agent documents, the folders where agents write big outputs, the folders whose files can be opened from chat, and the My Research folders (digests, art, the Graphics folder) now come from the configuration (`workspaceRoot`, `outputRoots`, `documentRoots`, `openPathRoots`, `sharedReports`, `agentsRoot`) instead of folders built into the app.
- Messages the app sends to agents ("Write to agent", "Send to agent" from the Library) name your configured name (`ownerName`) in the My Research write-back, and say "the user" where no name is known.
- Setup changes to these folders apply without restarting the app (the open-file allow-list refreshes as soon as it changes).
- The command-line digest tool no longer assumes a workspace: give `--root` or set `AGENT_DESKTOP_WORKSPACE_ROOT`.
- For the original owner nothing changes: the migration config reproduces the old folders (parity entries `main.outputRoots`, `main.documentRoots`, `main.openPathRoots`).

## v1.121.0 - ARGUS, Memory, Keep working and usage read their settings from Setup

Text for the release notes (area: ARGUS / Memory / usage / Keep working).

- **One workspace root.** ARGUS, Memory and the task store no longer assume one particular folder: they use the workspace and shared reports folders chosen in Setup. On a computer where they are not set up, ARGUS and Memory show a calm "Set up" card instead of an empty or broken screen.
- **Memory** needs the memory statistics file (and, optionally, the starting-context baseline file). The memory-folder name prefix is worked out from the Agents folder.
- **Plan and usage.** Your Claude plan (Pro, Max 5x, Max 20x) is a setting; the app no longer assumes one. Without it the 5-hour count is shown without a percentage until you choose a plan. The usage file used for the fleet throttle and the usage-model fallback is a setting too (the usage thread is handed it on every request).
- **Keep working regardless.** The messages sent to agents use the name you set, and the task tool you set (nothing is hard-wired); it cannot be switched ON until the task tool and Python are found (it opens Setup), and can always be switched OFF.
- ARGUS status builder (`build_status.py`) is an optional setting; the wake-agent log goes under the shared reports folder; the note a woken agent receives uses your name.
- Research digests: the field `worthKnowing` is now accepted next to the old `worthOwnerKnowing`.


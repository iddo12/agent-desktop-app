# Release-note text: Voice on the configuration layer (v1.121.0)

## For the release notes
- **Voice** reads where its speech program and model are from Setup (`whisperExe`, `whisperModel`, optional `whisperModelHe`; the same-named `AGENT_DESKTOP_WHISPER_*` variables still work). The Windows-registry lookup for the engine is gone, so pressing the mic button no longer starts three `reg` processes. With no speech engine and no online speech service the mic button says "Voice typing is not set up on this computer yet" with a **Set up** button, before recording anything (My Daily's voice recorder says the same). Online service credentials (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN`) stay in the environment (secrets never go in the settings file).
- PHEME delivery and the voice inbox hold no personal paths or names; they are unchanged and add no startup cost.

## Behaviour change for a configured computer (text only)
- The mic tooltip no longer says "(Whisper via Cloudflare)".
- If the local engine fails and no online service exists, the error now says so.

## For the core / merge
- `src/appConfig.js` KEYS gained `whisperExe`, `whisperModel`, `whisperModelHe` (file, no auto-detect).
- `src/features.js`: `voice` is `wired:true`, requires the two speech files, three steps. `SETUP.md` regenerated.
- `tests/features.test.js`, `tests/setupPanel.test.js`: the "every feature unwired" assertions now check `typeof wired === "boolean"`; voice is needs-setup on a fresh computer.
- `package.json`: `tests/cfgVoice.test.js` appended to the `test` script (version untouched).
- Research was NOT converted here (Software Engineering owns it).

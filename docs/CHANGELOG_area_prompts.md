# v1.121.0 release notes: area "prompts and vocabulary" (renderer texts, agent-facing prompts, dev scripts)

For the person using Agent Desktop on the original computer nothing changes: every text that said the owner's or partner's name still says it, through the configuration layer (ownerName, partnerName).

- **New `src/renderer/app-cfg.js` (window.AppCfg):** the renderer reads the configuration once at start-up (one `config-get-all` call, cached, nothing polled) and exposes `owner()`, `partner()`, `planTier()`, `toolName()`. Without a configuration the words are neutral ("the user", "partner"). `AppCfg.refresh()` re-reads after Setup saved something.
- **Agent-facing prompts:** the handoff prompt, the "Keep working regardless" tooltip and the IRIS card text use the configured name instead of a built-in name.
- **Plan:** there is no built-in default plan any more. The plan is the configured `planTier`, or the person's own pick in the sidebar Plan dropdown; with neither, the dropdown shows "Not set" and the 5-hour fallback badge shows a message count ("N msgs (5h, plan not set)") instead of a percentage that would be wrong for most plans. The plan is no longer read from a workspace file named `infrastructure_facts.md`.
- **Waiting queue:** the partner badge shows the configured partner name; the sandbox demo cards are generic and no longer load avatar images from a fixed folder.
- **Install guide:** `INSTALL_AND_USE_FOR_CLAUDE.md` no longer names a person or a repository owner.
- **Dev scripts:** `Start-TestDesktop.bat`, `tools/make-fixtures.js`, `tools/health-pane-sandbox.cjs`, `tools/research-aggregate.js` take their folders from environment variables (`AGENT_DESKTOP_SANDBOX_ROOT`, `AGENT_DESKTOP_ROOT`, `PLAYWRIGHT_CORE_PATH`, `AGENT_DESKTOP_WORKSPACE_ROOT`) with defaults under the user's temp / local-app-data folder, and start with a READ FIRST comment.
- **Tests:** new `tests/noHardcodedPrompts.test.js` (code of the converted files holds no names, drive letters, agent folder names or workspace tool names; AppCfg returns the owner's old texts for the owner's configuration and neutral words otherwise). Five parity entries added.

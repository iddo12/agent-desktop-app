## v1.121.0 - No personal names anywhere in the shipped app

Text for the release notes (area: names final).

- **Nothing the app shows or sends names a person.** The text that tells the reply-prediction model who the user is, the "ask ..." hints in the sandbox, the research week summary ("worth ... knowing") and the update-refusal message now use the name you set in Setup (`ownerName`), or the neutral words "the user" / "whoever maintains your copy of Agent Desktop".
- **ARGUS wording follows your roles.** Sentences about your lead agent and maintenance agent use the short names from your configuration, and "the lead agent" / "the optimization agent" when no role is set.
- **Tools group heading** is "Tools" by default; set `toolsBasketLabel` in Setup to name it (the group id in tools.json is unchanged).
- **My Library and My Research** show the calm "needs setup" card with a Set up button instead of an empty list when their folder is not configured.
- **"Claude Code is not installed"** is now a calm amber step with an Open Setup button, not a red alarm.
- **Test mode** honours an explicitly given research folder (the sandbox no longer ignores the Setup value); installs do not need the `tests/` folder (the Health sample is test-only and optional).

Config key added: `toolsBasketLabel`. Original owner's value: tests/legacyParity.json entry `tools.basketLabel` ("Acmeco tools"); his role short names and name already come from `argusShortNames`, `roleCoo`, `roleOptimization` and `ownerName`, so his wording is unchanged. The stored data field `worthOwnerKnowing` in research digests is a wire format and keeps its name (the new `worthKnowing` is also accepted).

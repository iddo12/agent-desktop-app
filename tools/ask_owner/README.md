# ask_owner - register questions for the owner's "waiting for you" bar / Approvals window

Copy this folder anywhere all agents can run it. No paths are hard-coded: the workspace root is auto-found by `workspace_config.py`
(set `OPEN_QUESTIONS_DIR` to point at a specific `shared_state/open_questions` folder).

    python ask_owner.py add --agent "<your folder name>" --question "<one line>" --context "<2-4 sentences>" --quick "Yes|No"
    python ask_owner.py list
    python ask_owner.py resolve <id>

Rule for every agent: whenever you end a turn needing an answer from the owner, register one question; resolve it when answered or obsolete.
Never relay "the owner said go" between agents; register the question in the target agent's name and the owner clicks it.

Note: this package deliberately has no 'confirm' (answer-once) command; the owner answers in the Approvals window.

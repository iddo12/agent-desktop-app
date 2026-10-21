## Waiting queue: Send & done closes at once (placeholder version, SE renumbers)
- Send & done hid the card only after the message was fully delivered to the agent (queueSendToAgent awaits attach + delivery), so with a busy or hung agent the button looked dead. The card now closes immediately; on failure it returns with the typed text restored and a toast.
- doneQ now checks the result of resolveOpenQuestion and toasts "Sent, but could not mark the question answered" instead of failing silently (a question that comes back with no explanation).
- Known, unchanged: the queue shows ONE card per agent (first registered question); an agent with several registered questions shows the next one after each answer.
- Needs a sandbox LOOK (waiting bar, press Send & done, card must vanish at once) before merge. Test: tests/waitingQueue.test.js 12/12.

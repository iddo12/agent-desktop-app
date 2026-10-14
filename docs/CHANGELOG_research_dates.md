## My Research: dates on every card

- Every story card (the list, the five to read first, the magazine hero and the magazine articles) now shows a small muted date line near the top: the date of the source or event and the day the agent found it, for example "Aug 10 2026 · found 12 Oct".
- The source date comes from the new optional finding field `sourceDate` (ISO such as 2026-08-10, or plain text such as "Aug 10 2026"). If it is missing or cannot be read, the card shows only "found 12 Oct" (the digest's generatedAt). Nothing is shown if neither is usable.

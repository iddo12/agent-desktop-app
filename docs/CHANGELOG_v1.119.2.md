## v1.119.2 - Hebrew in the waiting-for-you queue reads right-to-left; update failure shows its reason

- Waiting queue (question, background, thread messages, answer box, suggested answer) now use dir="auto", like the normal chat: Hebrew text is right-to-left and right-aligned, English stays left.
- When the start-up component install fails, the sidebar line now names the missing packages and the first part of npm's error (full text still in the tooltip and in `<userData>/dep-doctor.json`). Found when the partner's 1.119.1 update said "Could not install components" with no detail.

## v1.112.0 - My Daily reads any IMAP mailbox

My Daily can now read mail from any IMAP account (not only Gmail), so the partner's mailbox can feed the Daily page. Add it under Email accounts: pick the provider, enter the address and an app password. The password is stored encrypted with Windows (safeStorage) and never goes back to the page. Read-only: the app only looks at message headers and never changes, moves or deletes mail. Run `npm install` once after updating (new dependency: imapflow).

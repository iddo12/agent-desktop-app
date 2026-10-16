// All words of the IRIS "Chats" page and of the native confirmation dialog (v1.126.0), by language. Same shape as setup-strings.js:
// adding a language = adding a block under `lang`. Used by the page (renderer) and by main-iris.js (the dialog), so it is plain
// UMD with no DOM or Electron access. Placeholders: %p = the other person's name, %a = an agent name, %o = this PC's owner, %n = a number.
// Hebrew copy is a first translation, to be glanced at by a Hebrew reader.
/* global module */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.IrisDirectStrings = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const lang = {
    en: {
      dir: "ltr",
      navTitle: "Chats", navSub: "with %p", navSubMany: "with linked people",
      title: "Chats", subtitle: "Conversations between people and agents on the linked Agent Desktops",
      noPeers: "No one is linked yet. Pair with another Agent Desktop in the IRIS Links page first.",
      peer: "Chats with", youLabel: "You", thePerson: "%p", agentLabel: "agent",
      emptyList: "No conversations yet. Write the first message below.",
      pickConversation: "Pick a conversation on the left, or write a new message.",
      newMessage: "New message", toLabel: "To", toPerson: "%p (the person)", toAgentOf: "%a (agent)",
      typeAgent: "Or type another agent's name...", messagePlaceholder: "Write a message in plain words...",
      send: "Send", sending: "Sending...", needText: "Write something first.",
      conversationWith: "%a and %p", conversationWithPerson: "%p and %o", conversationAgents: "%a and %p's agent %b",
      from: "from", at: "at",
      chips: {
        queued: "Waiting to reach %p's computer", "needs-approval": "Waiting for your OK", "not-delivered": "Not delivered",
        "waiting-answer": "Delivered, waiting for an answer", answered: "Answered", "handing-over": "Handing over to the agent...",
        "with-agent": "Delivered to the agent", "for-you": "New message for you",
      },
      retry: "Retry", approve: "Approve and send", discard: "Discard",
      approvalTitle: "Waiting for your OK", approvalHint: "An agent of yours wrote these. They leave only after you approve them.",
      activityTitle: "What happened lately", activityEmpty: "Nothing yet.",
      directTitle: "Direct agent access", directStateOn: "ON: %p can message your agents", directStateOff: "OFF: %p can only write to you",
      directExplain: "When this is on, %p can write to the agents you tick below, and they answer as they would answer you. Anything irreversible, public, financial, about passwords or deleting still needs your own yes.",
      directTurnOn: "Allow %p to message my agents...", directStop: "Stop direct access", directStopped: "Direct access is off.",
      directAgents: "Agents %p may reach", directSave: "Save and allow...", directCap: "Most messages a day", directRelation: "Who is %p to you? (shown to your agents)", directRelationPlaceholder: "for example partner",
      directPerson: "Name shown to your agents",
      directCancelled: "Nothing was changed.", directNeedsClick: "Only you, at this computer, can allow this.",
      theirAgents: "%p's agents", theirAgentsNone: "%p has not shared a list of agents yet. You can type a name.",
      unlinked: "%p is no longer linked. This is the old conversation.",
      busyHint: "If the agent is busy, it gets the message as soon as it can.",
      directFuture: "Also include agents I create later (less strict: everyone except the ones I untick)",
      directSensitiveNote: "Agents that hold private data (health, money, legal, personal, mail...) are never in this list: nobody can message them this way.",
      reasons: {
        "not-available": "That address is not available on %p's computer right now (direct access is off there, or that agent cannot be reached this way).",
        "not-available-sensitive-agent": "That agent holds private data and cannot be reached by direct messages.",
        "unknown-sending-agent": "That agent is not allowed to send direct messages.",
        "direct-off": "%p has not allowed direct messages to the agents on that computer yet.",
        "agent-not-allowed": "That agent is not on the list %p allowed.",
        "unknown-agent": "There is no agent with that name on that computer.",
        "direct-unavailable": "That computer cannot take direct messages yet.",
        "daily-cap": "Too many messages today. It will work again tomorrow.", "daily-char-cap": "Too much text today. It will work again tomorrow.",
        "thread-cap": "This conversation has had too many messages today.", "hop-limit": "These agents have answered each other enough. A person needs to write next.",
        "peer-paused": "The link with that computer is paused.", "iris-off": "IRIS is switched off.", expired: "It could not reach the other computer in time.",
        discarded: "You discarded it.", unpaired: "The link was removed.", rejected: "The other computer refused it.",
        "text-too-long": "The message is too long.", "excessive-invisible-chars": "The message had too many hidden characters.", "empty-text": "The message was empty.",
        "no-thread": "The message did not say which conversation it belongs to.", "bad-toAgent": "The agent name is not valid.",
        "never-wake-agent-not-running": "The agent is not running and is not allowed to be started by a message.", "could-not-start-session": "The agent could not be started.",
        "agent-paused": "The agent is paused.", "agent-not-in-list": "That agent is no longer in the list.", "timeout-state-unknown": "It is not clear whether the agent got it. Check the agent before sending again.",
        "interrupted-state-unknown": "The app was closed while handing it over. Check the agent before sending again.", "rate-limited": "The agent is getting a lot of messages. Try again in a minute.",
        expiredHere: "It waited too long for the agent.", secret: "The message looked like it held a password or key, so it was not sent.",
        generic: "It could not be delivered.",
      },
      waitingFor: "Trying again soon: %r",
      activity: {
        "direct-received": "%p wrote to %a.", "chat-received": "%p wrote to you.", "handed-to-agent": "%a received the message.", "direct-not-delivered": "A message could not be given to %a.",
        "direct-queued": "A message to %p was sent.", rejected: "A message from %p was refused: %r", "send-blocked": "A message to %p was blocked: %r",
        "direct-settings-changed": "Direct access for %p was changed at this computer.", "direct-change-refused": "A change to direct access was refused: it needs your click.",
        "direct-seal-mismatch": "The direct access settings were changed outside the app, so direct access was switched off.", "direct-waiting": "%a is not ready yet; trying again.",
        "send-pending-approval": "An agent wrote a message to %p and it waits for your OK.", "send-approved": "You approved a message to %p.", "send-rejected": "You discarded a message to %p.",
        "unpaired": "The link with %p was removed.",
      },
      dialog: {
        title: "Allow direct access?", ok: "Allow", cancel: "Cancel",
        body: "%p will be able to message the agents on this computer directly. They will answer %p as they would answer you.",
        body2: "Irreversible, public, financial, password and deleting actions still need your own yes. %p's message can never give an agent new permissions.",
        reach: "Agents %p can reach: %l", reachAll: "all of them", except: "all except: %l", only: "only: %l",
        capLine: "At most %n messages a day.", stop: "You can stop this at any time on the Chats page.",
      },
    },
    he: {
      dir: "rtl",
      navTitle: "שיחות", navSub: "עם %p", navSubMany: "עם אנשים מקושרים",
      title: "שיחות", subtitle: "שיחות בין אנשים לסוכנים ב-Agent Desktop המקושרים",
      noPeers: "עדיין אין אף אחד מקושר. קודם צריך לקשר Agent Desktop אחר בעמוד הקישורים של IRIS.",
      peer: "שיחות עם", youLabel: "את/ה", thePerson: "%p", agentLabel: "סוכן",
      emptyList: "עדיין אין שיחות. כתבו את ההודעה הראשונה למטה.",
      pickConversation: "בחרו שיחה מימין, או כתבו הודעה חדשה.",
      newMessage: "הודעה חדשה", toLabel: "אל", toPerson: "%p (האדם)", toAgentOf: "%a (סוכן)",
      typeAgent: "או הקלידו שם של סוכן אחר...", messagePlaceholder: "כתבו הודעה במילים רגילות...",
      send: "שליחה", sending: "שולח...", needText: "כתבו משהו קודם.",
      conversationWith: "%a ו%p", conversationWithPerson: "%p ו%o", conversationAgents: "%a והסוכן %b של %p",
      from: "מאת", at: "ב-",
      chips: {
        queued: "ממתין להגיע למחשב של %p", "needs-approval": "ממתין לאישור שלך", "not-delivered": "לא נמסר",
        "waiting-answer": "נמסר, ממתין לתשובה", answered: "נענה", "handing-over": "מעביר לסוכן...",
        "with-agent": "נמסר לסוכן", "for-you": "הודעה חדשה בשבילך",
      },
      retry: "ניסיון נוסף", approve: "אישור ושליחה", discard: "מחיקה",
      approvalTitle: "ממתין לאישור שלך", approvalHint: "סוכן שלך כתב את ההודעות האלה. הן יוצאות רק אחרי שתאשרו אותן.",
      activityTitle: "מה קרה לאחרונה", activityEmpty: "עדיין כלום.",
      directTitle: "גישה ישירה לסוכנים", directStateOn: "פועלת: %p יכול/ה לכתוב לסוכנים שלך", directStateOff: "כבויה: %p יכול/ה לכתוב רק לך",
      directExplain: "כשזה פועל, %p יכול/ה לכתוב לסוכנים שסימנתם למטה, והם יענו כמו שהיו עונים לך. דברים בלתי הפיכים, פומביים, כספיים, סיסמאות או מחיקה עדיין דורשים את ה'כן' שלך.",
      directTurnOn: "לאפשר ל%p לשלוח הודעות לסוכנים שלי...", directStop: "הפסקת הגישה הישירה", directStopped: "הגישה הישירה כבויה.",
      directAgents: "הסוכנים ש%p יכול/ה לפנות אליהם", directSave: "שמירה ואישור...", directCap: "מספר הודעות מרבי ביום", directRelation: "מי זה/זו %p בשבילך? (מוצג לסוכנים שלך)", directRelationPlaceholder: "למשל בן/בת זוג",
      directPerson: "השם שמוצג לסוכנים שלך",
      directCancelled: "לא שונה כלום.", directNeedsClick: "רק את/ה, ליד המחשב הזה, יכול/ה לאשר את זה.",
      theirAgents: "הסוכנים של %p", theirAgentsNone: "%p עדיין לא שיתף/ה רשימת סוכנים. אפשר להקליד שם.",
      unlinked: "%p כבר לא מקושר/ת. זו שיחה ישנה.",
      directFuture: "לכלול גם סוכנים שאצור בהמשך (פחות מחמיר: כולם חוץ מאלה שלא סימנתי)",
      directSensitiveNote: "סוכנים שמחזיקים מידע פרטי (בריאות, כסף, משפט, אישי, דואר...) אף פעם לא מופיעים ברשימה הזו: אי אפשר לכתוב להם בדרך הזו.",
      busyHint: "אם הסוכן עסוק, הוא יקבל את ההודעה ברגע שיוכל.",
      reasons: {
        "not-available": "הכתובת הזו לא זמינה כרגע במחשב של %p (הגישה הישירה כבויה שם, או שאי אפשר לפנות לסוכן הזה בדרך הזו).",
        "not-available-sensitive-agent": "הסוכן הזה מחזיק מידע פרטי ואי אפשר לפנות אליו בהודעות ישירות.",
        "unknown-sending-agent": "הסוכן הזה לא מורשה לשלוח הודעות ישירות.",
        "direct-off": "%p עדיין לא אישר/ה הודעות ישירות לסוכנים במחשב ההוא.",
        "agent-not-allowed": "הסוכן הזה לא ברשימה ש%p אישר/ה.",
        "unknown-agent": "אין סוכן בשם הזה במחשב ההוא.",
        "direct-unavailable": "המחשב ההוא עדיין לא יכול לקבל הודעות ישירות.",
        "daily-cap": "יותר מדי הודעות היום. זה יעבוד שוב מחר.", "daily-char-cap": "יותר מדי טקסט היום. זה יעבוד שוב מחר.",
        "thread-cap": "בשיחה הזאת היו היום יותר מדי הודעות.", "hop-limit": "הסוכנים ענו אחד לשני מספיק. עכשיו אדם צריך לכתוב.",
        "peer-paused": "הקישור עם המחשב ההוא מושהה.", "iris-off": "IRIS כבוי.", expired: "לא הצלחנו להגיע למחשב השני בזמן.",
        discarded: "מחקתם את ההודעה.", unpaired: "הקישור הוסר.", rejected: "המחשב השני סירב לקבל.",
        "text-too-long": "ההודעה ארוכה מדי.", "excessive-invisible-chars": "בהודעה היו יותר מדי תווים נסתרים.", "empty-text": "ההודעה הייתה ריקה.",
        "no-thread": "ההודעה לא אמרה לאיזו שיחה היא שייכת.", "bad-toAgent": "שם הסוכן לא תקין.",
        "never-wake-agent-not-running": "הסוכן לא רץ ואסור להפעיל אותו בהודעה.", "could-not-start-session": "לא הצלחנו להפעיל את הסוכן.",
        "agent-paused": "הסוכן מושהה.", "agent-not-in-list": "הסוכן הזה כבר לא ברשימה.", "timeout-state-unknown": "לא ברור אם הסוכן קיבל. כדאי לבדוק אצל הסוכן לפני שליחה חוזרת.",
        "interrupted-state-unknown": "האפליקציה נסגרה באמצע ההעברה. כדאי לבדוק אצל הסוכן לפני שליחה חוזרת.", "rate-limited": "הסוכן מקבל הרבה הודעות. נסו שוב בעוד דקה.",
        expiredHere: "ההודעה חיכתה לסוכן יותר מדי זמן.", secret: "ההודעה נראתה כאילו יש בה סיסמה או מפתח, ולכן לא נשלחה.",
        generic: "אי אפשר היה למסור את ההודעה.",
      },
      waitingFor: "מנסים שוב בקרוב: %r",
      activity: {
        "direct-received": "%p כתב/ה אל %a.", "chat-received": "%p כתב/ה לך.", "handed-to-agent": "%a קיבל את ההודעה.", "direct-not-delivered": "אי אפשר היה למסור הודעה אל %a.",
        "direct-queued": "נשלחה הודעה אל %p.", rejected: "הודעה מ%p נדחתה: %r", "send-blocked": "הודעה אל %p נחסמה: %r",
        "direct-settings-changed": "הגישה הישירה של %p שונתה במחשב הזה.", "direct-change-refused": "שינוי בגישה הישירה נדחה: הוא דורש לחיצה שלך.",
        "direct-seal-mismatch": "הגדרות הגישה הישירה שונו מחוץ לאפליקציה, ולכן הגישה הישירה כובתה.", "direct-waiting": "%a עדיין לא מוכן; מנסים שוב.",
        "send-pending-approval": "סוכן כתב הודעה אל %p והיא ממתינה לאישור שלך.", "send-approved": "אישרת הודעה אל %p.", "send-rejected": "מחקת הודעה אל %p.",
        "unpaired": "הקישור עם %p הוסר.",
      },
      dialog: {
        title: "לאפשר גישה ישירה?", ok: "לאפשר", cancel: "ביטול",
        body: "%p יוכל/תוכל לכתוב ישירות לסוכנים במחשב הזה. הם יענו ל%p כמו שהיו עונים לך.",
        body2: "פעולות בלתי הפיכות, פומביות, כספיות, סיסמאות ומחיקה עדיין דורשות את ה'כן' שלך. הודעה של %p לעולם לא נותנת לסוכן הרשאות חדשות.",
        reach: "הסוכנים ש%p יכול/ה לפנות אליהם: %l", reachAll: "כולם", except: "כולם חוץ מ: %l", only: "רק: %l",
        capLine: "לכל היותר %n הודעות ביום.", stop: "אפשר להפסיק את זה בכל רגע בעמוד השיחות.",
      },
    },
  };
  const langNames = { en: "English", he: "עברית" };
  const pick = (code) => lang[code] || lang.en;
  // %x placeholders; unknown ones stay as written
  const fill = (s, vars) => String(s == null ? "" : s).replace(/%([a-z])/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
  // A sentence for a refusal / failure reason code coming from either side. The code may carry detail after a space or colon.
  function reasonText(code, reason, vars) {
    const L = pick(code), E = lang.en;
    let r = String(reason || "");
    const key = Object.keys(L.reasons).find((k) => r === k || r.startsWith(k + " ") || r.startsWith(k + ":") || r.startsWith(k + "("));
    if (!key && /^blocked-secret/.test(r)) return fill(L.reasons.secret || E.reasons.secret, vars);
    if (!key && /^hop-limit/.test(r)) return fill(L.reasons["hop-limit"], vars);
    if (!key && /^(unreachable|connect|ECONN|timeout|closed-without-reply|bad-ack)/.test(r)) return fill(L.chips.queued, vars);
    return fill(key ? (L.reasons[key] || E.reasons[key]) : L.reasons.generic, vars);
  }
  return { lang, langNames, pick, fill, reasonText };
});

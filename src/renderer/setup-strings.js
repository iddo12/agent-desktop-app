// All words the Setup panel shows (v1.121.0), by language. Adding a language is a data change: add a block under `lang` and a label under `langNames`.
// Feature copy is keyed by feature id (what it does, what it needs and why). Hebrew copy is UI-UX's translation, to be glanced at by a Hebrew reader.
/* global module */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SetupStrings = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const langNames = { en: "English", he: "עברית" };
  const lang = {
    en: {
      dir: "ltr",
      title: "Setup", intro: "Each line is something Agent Desktop can show. A feature turns on when the folder it needs is chosen.",
      copyBtn: "Copy setup instructions for Claude", copied: "Copied. Paste it into a Claude chat and ask it to set Agent Desktop up on this computer.", copyFail: "Could not copy to the clipboard.",
      close: "Close", settingsFile: "Settings file: ",
      groups: { core: "Workspace", daily: "Daily use", private: "Private (never shared)", computer: "This computer", connections: "Connections", advanced: "Advanced" },
      states: { ready: "✓ Ready", "needs-setup": "○ Needs setup", off: "– Off", "needs-attention": "⚠ Needs attention" },
      asIs: "works as before", privateNote: "Stays on this PC",
      btnSetup: "Set up", tileNeedsBody: "This is not set up on this computer yet. It takes a minute in Setup.", btnFix: "Fix", btnChange: "Change", btnTurnOn: "Turn on", btnTurnOff: "Turn off", btnCancel: "Cancel", btnHelp: "?", helpCopy: "Copy for Claude",
      btnCreate: "Create and turn on", btnSave: "Save and turn on", btnChoose: "Choose another folder...", tagDetected: "Detected", tagNew: "New folder",
      willCreate: "This folder will be created: ", willUse: "This existing folder will be used: ",
      workspaceFirst: "Choose the workspace folder first.", needs: "Needs: ", why: "Why: ",
      saved: "Saved. ", createdN: "Created %n folder(s). ", turnedOn: " is on.", turnedOff: " is off. Nothing is removed from this computer.",
      errors: {
        "invalid-value": "That folder name is not usable. Use a full path that starts with a drive letter or a slash.",
        "folder-missing": "This folder doesn't exist. Create it, or pick another.",
        "file-missing": "That file was not found. Pick the file again.",
        "cannot-create-folder": "The app can't save files here. Pick a folder you can edit, like one inside Documents.",
        "outside-workspace": "That folder is outside your workspace folder, so it was not created. Pick a folder inside the workspace.",
        "not-allowed": "This is only available from the main window.", generic: "That did not save. Nothing was changed.",
      },
      fill: "Please fill in: ",
      welcome: {
        title: "Welcome to Agent Desktop", sub: "Three quick choices. You can change any of them later in Setup.",
        qLang: "Language", qFolder: "Workspace folder", qFolderHelp: "Created when you press Start.", qStarters: "Start with",
        start: "Start", later: "You can change any of this later.",
      },
      features: {
        argus: ["📊", "ARGUS", "A daily overview of how your sites and channels are doing.", "Reports folder", "ARGUS reads the report files your agents write there."],
        memory: ["🧠", "Memory", "Browse and tidy what your agents remember.", "Agents folder and the memory statistics file", "Memory notes live next to each agent; the statistics file says how big they are."],
        myDaily: ["☀️", "My Daily", "A morning page with today's tasks and notes.", "Tasks folder", "Your task list is kept there as plain files."],
        library: ["📚", "Library", "Find and open documents your agents made.", "Documents folder(s)", "Only folders you pick can be opened from the app."],
        research: ["🔎", "Research", "A reading list and digests, in one place.", "Research folder", "Digests are saved there."],
        tools: ["🧰", "Tools", "Start your small helper apps from the sidebar.", "Tools folder", "The app lists the tools it finds there."],
        designs: ["🎨", "My Designs", "A numbered gallery of your designs, to browse and reuse.", "Designs library folder", "The page reads the designs and their previews from there."],
        myHealth: ["❤️", "My Health", "Private health notes and trends. Stays on this PC.", "Private folder", "Kept apart from everything else; never shared."],
        myFinance: ["💰", "My Finance", "A private overview of your money. Stays on this PC.", "Private folder", "Kept apart from everything else; never shared."],
        pcHealth: ["🖥️", "PC Health", "Checks disk space, memory and updates.", "None (a switch)", "It only reads system information."],
        voice: ["🎙️", "Voice", "Talk to your agents and hear short replies.", "Speech program and speech model (files)", "Speech-to-text runs on this PC. Without the program and model the microphone button tells you so."],
        fleet: ["🤝", "Shared fleet", "See another person's agents next to yours.", "Shared (synced) folder", "Both PCs read and write messages in that folder."],
        iris: ["🔗", "IRIS", "Link this app with a second Agent Desktop on another PC.", "Shared (synced) folder", "Same shared folder as the fleet link."],
        loadGovernor: ["🚦", "Load governor", "Keeps the PC responsive: agents start one at a time, only a few work at once, and everything slows down by itself when the PC lags.", "Nothing (a switch; the numbers are optional)", "It only measures this PC's load and delays starting or nudging agents; it never stops an agent that is working."],
        keepGoing: ["⏯️", "Keep going", "Nudges an agent that stopped before finishing.", "Task tool and Python (only for \"keep working regardless\")", "That mode sends the agent to your task list."],
        claudeCode: ["🤖", "Claude Code", "The program that runs your agents.", "Claude Code on this PC", "Without it agents cannot start. Agent Desktop finds it by itself; Fix lets you point to it."],
        claudeIntegration: ["⚙️", "Claude Code integration", "Lets this app adjust your Claude Code settings (usage status line, phone access).", "Your OK (a switch)", "It edits one settings file in your Windows user folder, so it only turns on when you say so."],
        telegram: ["✈️", "Telegram tasks", "Approve tasks you sent from your phone through a Telegram bridge.", "Two folders (queue and bridge)", "Only for people who run such a bridge."],
        usage: ["📈", "Usage", "Shows how much of your Claude plan is used.", "Usage file", "Read from a file your account tool writes."],
      },
    },
    he: {
      dir: "rtl",
      title: "הגדרות התקנה", intro: "כל שורה היא דבר ש-Agent Desktop יכול להציג. היכולת נדלקת כשהתיקייה שהיא צריכה נבחרה.",
      copyBtn: "העתקת הוראות התקנה ל-Claude", copied: "הועתק. הדבק בשיחה עם Claude ובקש ממנו להתקין את Agent Desktop במחשב הזה.", copyFail: "לא הצלחנו להעתיק ללוח.",
      close: "סגירה", settingsFile: "קובץ ההגדרות: ",
      groups: { core: "תיקיית עבודה", daily: "שימוש יומיומי", private: "פרטי (לא משותף לעולם)", computer: "המחשב הזה", connections: "חיבורים", advanced: "מתקדם" },
      states: { ready: "✓ מוכן", "needs-setup": "○ דורש הגדרה", off: "– כבוי", "needs-attention": "⚠ דורש תשומת לב" },
      asIs: "פועל כמו קודם", privateNote: "נשאר במחשב הזה",
      btnSetup: "הגדרה", tileNeedsBody: "זה עדיין לא הוגדר במחשב הזה. זה לוקח דקה ב'הגדרות'.", btnFix: "תיקון", btnChange: "שינוי", btnTurnOn: "הדלקה", btnTurnOff: "כיבוי", btnCancel: "ביטול", btnHelp: "?", helpCopy: "העתקה ל-Claude",
      btnCreate: "יצירה והדלקה", btnSave: "שמירה והדלקה", btnChoose: "בחירת תיקייה אחרת...", tagDetected: "זוהתה", tagNew: "תיקייה חדשה",
      willCreate: "תיקייה זו תיווצר: ", willUse: "תיקייה קיימת זו תישמש: ",
      workspaceFirst: "בחרו קודם את תיקיית העבודה.", needs: "דורש: ", why: "למה: ",
      saved: "נשמר. ", createdN: "נוצרו %n תיקיות. ", turnedOn: " מופעל.", turnedOff: " כבוי. לא נמחק כלום מהמחשב.",
      errors: {
        "invalid-value": "לא ניתן להשתמש בשם התיקייה. השתמשו בנתיב מלא.",
        "folder-missing": "התיקייה הזו לא קיימת. אפשר ליצור אותה או לבחור אחרת.",
        "file-missing": "הקובץ לא נמצא. בחרו שוב.",
        "cannot-create-folder": "האפליקציה לא יכולה לשמור קבצים כאן. בחרו תיקייה שאפשר לערוך, כמו זו שבתוך מסמכים.",
        "outside-workspace": "התיקייה חוץ לתיקיית העבודה, לכן לא נוצרה.",
        "not-allowed": "זמין רק מהחלון הראשי.", generic: "השינוי לא נשמר. לא שונה כלום.",
      },
      fill: "יש למלא: ",
      welcome: {
        title: "ברוכים הבאים ל-Agent Desktop", sub: "שלושה בחירות מהירות. אפשר לשנות אותן בכל עת בהגדרות ההתקנה.",
        qLang: "שפה", qFolder: "תיקיית עבודה", qFolderHelp: "תיווצר כשיופיע הכפתור התחל.", qStarters: "להתחיל עם",
        start: "התחל", later: "אפשר לשנות את כל זה מאוחר יותר.",
      },
      features: {
        argus: ["📊", "ארגוס", "סקירה יומית של מצב האתרים והערוצים שלך.", "תיקיית דוחות", "ארגוס קורא את קבצי הדוח שהסוכנים כותבים שם."],
        memory: ["🧠", "זיכרון", "עיון וסידור של מה שהסוכנים שלך זוכרים.", "תיקיית סוכנים וקובץ סטטיסטיקות זיכרון", "הערות הזיכרון נמצאות ליד כל סוכן; קובץ הסטטיסטיקות אומר כמה הן גדולות."],
        myDaily: ["☀️", "היום שלי", "דף בוקר עם המשימות והפתקים להיום.", "תיקיית משימות", "רשימת המשימות שלך נשמרת שם כקבצים רגילים."],
        library: ["📚", "ספרייה", "מציאת ופתיחת מסמכים שהסוכנים יצרו.", "תיקיות מסמכים", "רק תיקיות שבחרת יוכלו להיפתח מהאפליקציה."],
        research: ["🔎", "מחקר", "רשימת קריאה וסיכומים במקום אחד.", "תיקיית מחקר", "הסיכומים נשמרים שם."],
        tools: ["🧰", "כלים", "הפעלת אפליקציות העזר שלך מסרגל הצד.", "תיקיית כלים", "האפליקציה מרשימה את הכלים שהיא מוצאת שם."],
        designs: ["🎨", "העיצובים שלי", "גלריה ממוספרת של העיצובים שלך, לעיון ולשימוש חוזר.", "תיקיית ספריית העיצובים", "העמוד קורא משם את העיצובים ואת התצוגות המקדימות."],
        myHealth: ["❤️", "הבריאות שלי", "הערות ומגמות בריאות פרטיות. נשאר במחשב הזה.", "תיקיה פרטית", "נשמרת נפרד מכל דבר אחר; לא משותפת לעולם."],
        myFinance: ["💰", "הכספים שלי", "סקירה פרטית של הכספים שלך. נשאר במחשב הזה.", "תיקיה פרטית", "נשמרת נפרד מכל דבר אחר; לא משותפת לעולם."],
        pcHealth: ["🖥️", "בריאות המחשב", "בדיקת מקום בדיסק, זיכרון ועדכונים.", "ללא (מתג)", "היא רק קוראת מידע על המערכת."],
        voice: ["🎙️", "קול", "דיבור עם הסוכנים ושמיעת תשובות קצרות.", "תוכנת דיבור וקובץ מודל (קבצים)", "הדיבור לטקסט רץ על המחשב הזה. בלי התוכנה והמודל כפתור המיקרופון יגיד זאת."],
        fleet: ["🤝", "צי משותף", "צפייה בסוכנים של אדם נוסף לצד שלך.", "תיקיה משותפת (מסונכרנת)", "שני המחשבים קוראים וכותבים הודעות בתיקיה הזו."],
        iris: ["🔗", "איריס", "חיבור האפליקציה עם Agent Desktop שני במחשב אחר.", "תיקיה משותפת (מסונכרנת)", "אותה תיקיה משותפת כמו קישור הצי."],
        loadGovernor: ["🚦", "בקרת עומס", "שומר על המחשב רספונסיבי: סוכנים מתחילים אחד אחד, רק מעטים עובדים בו זמנית, וכל התהליך מאט מעצמו כשהמחשב מגמגם.", "כלום (מתג; המספרים אופציונליים)", "היא רק מודדת את עומס המחשב ומעכבת הפעלה או דחיפה של סוכנים; היא אף פעם לא עוצרת סוכן שעובד."],
        keepGoing: ["⏯️", "להמשיך", "דוחף סוכן שעצר לפני שסיים.", "כלי משימות ו-Python (רק למצב 'להמשיך בכל מקרה')", "המצב הזה שולח את הסוכן לרשימת המשימות שלך."],
        claudeCode: ["🤖", "Claude Code", "התוכנה שמריצה את הסוכנים שלך.", "Claude Code במחשב הזה", "בלעדיה הסוכנים לא יכולים להתחיל. האפליקציה מוצאת אותה לבד; תיקון מאפשר להצביע עליה."],
        claudeIntegration: ["⚙️", "שילוב עם Claude Code", "מאפשר לאפליקציה לכוונן את ההגדרות של Claude Code (שורת מצב לשימוש, גישה מהטלפון).", "אישור שלך (מתג)", "היא עורכת קובץ הגדרות אחד בתיקיית המשתמש שלך, ולכן נדלקת רק כשאתה מבקש."],
        telegram: ["✈️", "משימות טלגרם", "אישור משימות ששלחת מהטלפון דרך גשר טלגרם.", "שתי תיקיות (תור וגשר)", "רק למי שמפעיל גשר כזה."],
        usage: ["📈", "שימוש", "מציג כמה מהמנוי שלך בשימוש.", "קובץ שימוש", "נקרא מקובץ שכלי החשבון שלך כותב."],
      },
    },
  };
  function pick(code) { return lang[code] || lang.en; }
  // [icon, name, what, needs, why] for a feature id; falls back to English, then to the id.
  function feature(code, id) { const l = pick(code); return l.features[id] || lang.en.features[id] || ["", id, "", "", ""]; }
  return { lang, langNames, pick, feature, STARTERS: ["myDaily", "library", "pcHealth"] };
});

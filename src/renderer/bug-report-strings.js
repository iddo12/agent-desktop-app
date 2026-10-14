// All words of the "Report a problem" dialog (v1.123.0), by language. Same shape as setup-strings.js: add a language = add a block under `lang`.
// Hebrew copy is a first translation, to be glanced at by a Hebrew reader.
/* global module */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BugReportStrings = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const lang = {
    en: {
      dir: "ltr",
      button: "Report a problem", title: "Report a problem",
      intro: "This makes a small report you can send to whoever looks after your Agent Desktop. Nothing is sent from here: the report is saved in a folder you choose, and you send it yourself.",
      whatLabel: "What went wrong?", whatHint: "A sentence or two is enough.",
      stepsLabel: "What did you do before it? (optional)",
      included: "What the report contains",
      always: "always included", optional: "optional",
      preview: "Preview", hidePreview: "Hide preview",
      items: {
        basics: ["Versions of this computer and app", "Agent Desktop version, Windows version, memory size, and the versions of Node and Claude Code. No names."],
        status: ["The app's own status files", "Three small files the app writes about its last start: when it started, how long it took, and whether its parts were installed."],
        config: ["Your settings, with the details removed", "Which folders are set up, but only the last folder name of each (no drive letter, no parent folders). Text values, secrets and agreement dates are hidden: it only says set or not set, yes or no."],
        features: ["The state of each feature", "The list from the Setup panel: ready, needs setup or needs attention, with the reason."],
        log: ["The last lines of the app's log", "About 300 lines of what the app said while it was running. Your name, computer name, e-mail addresses, keys, network addresses and phone-number-like numbers are replaced by placeholders, and the names of your agents are replaced by agent-1, agent-2 and so on."],
        terminal: ["The last 20 lines of one agent's terminal", "Only the one agent you pick, and only if you tick this. It can show a piece of a conversation, so look at the preview first."],
        screenshot: ["A picture of the problem", "Only a picture you choose yourself. Text inside a picture cannot be hidden by the app, so look at it before you send."],
      },
      pickAgent: "Which agent?", chooseAgent: "Choose an agent...",
      pickShot: "Choose a picture...", changeShot: "Choose another picture...", removeShot: "Remove", noShot: "No picture chosen.",
      saveIn: "Save the report in", change: "Change...",
      create: "Create report", cancel: "Cancel", close: "Close", working: "Creating the report...",
      previewFirst: "Look at the preview of the terminal text first. It is shown now. Then press Create report again.", needWhat: "Please write a sentence about what went wrong.", needAgent: "Choose which agent's terminal to include, or untick it.", needShot: "Choose a picture, or untick it.",
      picNote: "(a picture: shown by name and size only)", bytes: "bytes",
      doneTitle: "The report is ready", doneText: "Send the .zip file to whoever looks after your Agent Desktop (by e-mail, a shared folder or a chat). Read the files first if you like: nothing was uploaded.",
      fellBack: "Saved in the app's own folder because Windows blocked the Desktop.", zipLabel: "Zip file:", folderLabel: "Folder:", openFolder: "Open folder",
      errors: {
        "not-allowed": "This is only available from the main window.", "invalid-folder": "That folder cannot be used. Choose a normal folder on this computer.",
        "folder-missing": "That folder does not exist. Choose another.", "cannot-write": "The report could not be saved there. Choose another folder.", "blocked-by-windows": "Windows may be blocking this folder (Controlled Folder Access). Choose another folder with Change..., or allow Agent Desktop in Windows Security.",
        "agent-unknown": "That agent was not found. Choose again.", "screenshot-missing": "The picture could not be read. Choose it again.",
        "screenshot-too-big": "That picture is larger than 10 MB. Choose a smaller one.", "screenshot-type": "Choose a PNG, JPG, GIF, WebP or BMP picture.",
        generic: "Something went wrong and no report was made.",
      },
    },
    he: {
      dir: "rtl",
      button: "דיווח על בעיה", title: "דיווח על בעיה",
      intro: "כאן אפשר ליצור דוח קטן ולשלוח אותו למי שמטפל ב-Agent Desktop שלכם. שום דבר לא נשלח מכאן: הדוח נשמר בתיקייה שתבחרו, ואתם שולחים אותו בעצמכם.",
      whatLabel: "מה השתבש?", whatHint: "משפט או שניים מספיקים.",
      stepsLabel: "מה עשיתם לפני כן? (לא חובה)",
      included: "מה יש בדוח",
      always: "תמיד כלול", optional: "לא חובה",
      preview: "תצוגה מקדימה", hidePreview: "הסתרת התצוגה",
      items: {
        basics: ["גרסאות של המחשב והאפליקציה", "גרסת Agent Desktop, גרסת Windows, גודל הזיכרון וגרסאות Node ו-Claude Code. בלי שמות."],
        status: ["קבצי המצב של האפליקציה", "שלושה קבצים קטנים שהאפליקציה כותבת על ההפעלה האחרונה: מתי התחילה, כמה זמן לקח, והאם הרכיבים שלה הותקנו."],
        config: ["ההגדרות שלכם, בלי הפרטים", "אילו תיקיות מוגדרות, אבל רק שם התיקייה האחרונה של כל אחת (בלי אות כונן ובלי תיקיות אב). ערכי טקסט, סודות ותאריכי הסכמה מוסתרים: רק מצוין אם מוגדר או לא, כן או לא."],
        features: ["מצב כל יכולת", "הרשימה מלוח ההגדרות: מוכן, דורש הגדרה או דורש תשומת לב, עם הסיבה."],
        log: ["השורות האחרונות ביומן האפליקציה", "כ-300 שורות ממה שהאפליקציה אמרה בזמן שרצה. השם שלכם, שם המחשב, כתובות דוא\"ל, מפתחות, כתובות רשת ומספרים הדומים למספרי טלפון מוחלפים בסימנים, ושמות הסוכנים שלכם מוחלפים ב-agent-1, agent-2 וכן הלאה."],
        terminal: ["20 השורות האחרונות בטרמינל של סוכן אחד", "רק הסוכן שתבחרו, ורק אם תסמנו. זה עלול להראות חלק משיחה, לכן כדאי לראות קודם את התצוגה המקדימה."],
        screenshot: ["תמונה של הבעיה", "רק תמונה שתבחרו בעצמכם. את הכתוב בתוך תמונה האפליקציה לא יכולה להסתיר, לכן כדאי להסתכל עליה לפני השליחה."],
      },
      pickAgent: "איזה סוכן?", chooseAgent: "בחירת סוכן...",
      pickShot: "בחירת תמונה...", changeShot: "בחירת תמונה אחרת...", removeShot: "הסרה", noShot: "לא נבחרה תמונה.",
      saveIn: "שמירת הדוח בתיקייה", change: "שינוי...",
      create: "יצירת דוח", cancel: "ביטול", close: "סגירה", working: "יוצר את הדוח...",
      previewFirst: "הסתכלו קודם בתצוגה המקדימה של טקסט הטרמינל. היא מוצגת עכשיו. אחר כך לחצו שוב על יצירת דוח.", needWhat: "נא לכתוב משפט על מה שהשתבש.", needAgent: "בחרו את הטרמינל של איזה סוכן לכלול, או בטלו את הסימון.", needShot: "בחרו תמונה, או בטלו את הסימון.",
      picNote: "(תמונה: מוצגת בשם ובגודל בלבד)", bytes: "בתים",
      doneTitle: "הדוח מוכן", doneText: "שלחו את קובץ ה-zip למי שמטפל ב-Agent Desktop שלכם (בדוא\"ל, בתיקייה משותפת או בצ'אט). אפשר לקרוא את הקבצים קודם: שום דבר לא הועלה.",
      fellBack: "נשמר בתיקייה של האפליקציה עצמה כי Windows חסם את שולחן העבודה.", zipLabel: "קובץ zip:", folderLabel: "תיקייה:", openFolder: "פתיחת התיקייה",
      errors: {
        "not-allowed": "זמין רק מהחלון הראשי.", "invalid-folder": "אי אפשר להשתמש בתיקייה הזו. בחרו תיקייה רגילה במחשב הזה.",
        "folder-missing": "התיקייה לא קיימת. בחרו אחרת.", "cannot-write": "אי אפשר היה לשמור את הדוח שם. בחרו תיקייה אחרת.", "blocked-by-windows": "ייתכן ש-Windows חוסם את התיקייה הזו (גישה מבוקרת לתיקיות). בחרו תיקייה אחרת עם \"שינוי...\", או אפשרו ל-Agent Desktop באבטחת Windows.",
        "agent-unknown": "הסוכן לא נמצא. בחרו שוב.", "screenshot-missing": "אי אפשר היה לקרוא את התמונה. בחרו אותה שוב.",
        "screenshot-too-big": "התמונה גדולה מ-10 מ\"ב. בחרו קטנה יותר.", "screenshot-type": "בחרו תמונה מסוג PNG, JPG, GIF, WebP או BMP.",
        generic: "משהו השתבש ולא נוצר דוח.",
      },
    },
  };
  const pick = (code) => lang[code] || lang.en;
  return { lang, pick };
});

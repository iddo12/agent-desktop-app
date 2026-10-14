// Demo mode (v1.86.0): invented mail and calendar for My Daily (replaces the built-in placeholder examples, which carry real-looking
// sender names). Same shapes as model.placeholderEmails / placeholderEvents. Times are relative to "now".
"use strict";

function hm(now, h, m) { const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime(); }
function dayAt(now, off, h, m) { const d = new Date(now); d.setDate(d.getDate() + off); d.setHours(h, m || 0, 0, 0); return d.getTime(); }

const accounts = ["Studio", "Bookings", "Personal"];
const label = "Studio mailbox";

function emails(now) {
  const t = (h, m) => hm(now, h, m);
  return {
    top: [
      { id: "e1", account: "Bookings", from: "Garden Cafe", subject: "Saturday: access time for the shoot", at: t(9, 12), importance: 3 },
      { id: "e2", account: "Studio", from: "Hilltop Wedding", subject: "Final timeline and shot list", at: t(8, 40), importance: 3 },
      { id: "e3", account: "Studio", from: "Gear Supply Co", subject: "Your tripod head has shipped", at: t(7, 55), importance: 2 },
      { id: "e4", account: "Personal", from: "Sam", subject: "Dinner on Friday?", at: t(7, 20), importance: 1 },
    ],
    needAnswer: [
      { id: "n1", account: "Bookings", from: "Garden Cafe", subject: "Saturday: access time for the shoot", ageDays: 1, owner: "Email" },
      { id: "n2", account: "Studio", from: "Nova Skincare", subject: "Print sizes for the campaign", ageDays: 2, owner: "Email" },
      { id: "n3", account: "Studio", from: "Harbor Hotel", subject: "Question about invoice 0412", ageDays: 3, owner: "Finance" },
    ],
    sentNoReply: [
      { id: "s1", account: "Studio", to: "Hilltop Wedding", subject: "Quote for the second photographer", ageDays: 4, owner: "Email" },
      { id: "s2", account: "Bookings", to: "Print lab", subject: "Sample prints", ageDays: 3, owner: "Email" },
    ],
    peopleToWrite: [
      { id: "w1", text: "Thank the venue for last weekend", by: "assistant", ageDays: 3 },
      { id: "w2", text: "Send the gallery link to the Hilltop couple", by: "you", ageDays: 2 },
    ],
    hidden: 9,
  };
}

function events(now) {
  const E = (id, off, h, m, h2, m2, title, cal, extra) => Object.assign({ id, title, start: dayAt(now, off, h, m), end: dayAt(now, off, h2, m2), source: "demo", cal }, extra || {});
  return [
    E("d0", -2, 10, 0, 11, 0, "Client call", "google"),
    E("d1", 0, 9, 30, 10, 0, "Call: Garden Cafe", "owner"),
    E("d2", 0, 11, 0, 13, 0, "Edit session: Hilltop wedding", "owner"),
    E("d3", 0, 15, 0, 15, 45, "Pick up prints", "owner", { leaveBy: "14:30" }),
    E("d4", 0, 19, 0, 21, 0, "Dinner with family", "partner"),
    E("d5", 1, 10, 0, 11, 0, "Gear check", "owner"),
    E("d6", 2, 9, 30, 10, 30, "Dentist", "partner"),
    E("d7", 3, 14, 0, 18, 0, "Shoot: Garden Cafe", "owner"),
    E("d8", 4, 10, 0, 20, 0, "Hilltop wedding", "owner"),
    E("d9", 6, 9, 0, 10, 0, "Plan the week", "google"),
    E("d10", 9, 11, 0, 12, 0, "Print shop visit", "owner"),
    E("d11", 16, 9, 0, 17, 0, "Portrait day", "owner"),
    E("d12", 24, 10, 0, 11, 0, "Accountant", "owner"),
  ];
}

module.exports = { emails, events, accounts, label };

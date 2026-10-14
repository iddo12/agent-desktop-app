// My Health Body tab: the DATA file (v1.118.0). Everything the owner may want to change after seeing the tab live is here and nowhere else:
// the 63 zones and the figure outlines, every chip list (types, triggers, spread, worse with, better with), the severity words, the
// safety questions and alert wording, the history ranges. The logic (body-logic.js) and the screens (health-body.js) read this file.
// Loaded in the renderer as window.healthBodyData and in the main process (validation) via require().
//
// Chips are stored in pain_log.jsonl as ARRAYS OF FIXED KEYS (the first item of each pair below), never as display strings, so a label can
// be reworded here without touching old entries. To add a chip add a [key, label] pair; to remove one, keep the key readable in old
// data by moving it to the *_retired list at the bottom (old entries stay valid).
// Zone rows: [id, name, side (person's own left/right or ""), cx, cy, rx, ry] in the 200x414 figure space (generated from the UI-UX
// design body_tab_pain_flow.html / body_tab_gen.py). In the FRONT view the person's RIGHT is on the screen's LEFT; in the BACK view the
// person's RIGHT is on the screen's RIGHT (see body-logic.js sideOnScreen and tests/bodyTab.test.js).
(function (root, factory) {
  const d = factory();
  if (typeof module === "object" && module.exports) module.exports = d; else root.healthBodyData = d;
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";
  return {
    viewBox: "-30 0 260 414",
    views: {
      front: {
        label: "FRONT",
        shapes: [["ellipse",{"cx":"100","cy":"28","rx":"20","ry":"25"}],["rect",{"x":"90","y":"48","width":"20","height":"22","rx":"6"}],["path",{"d":"M70 72 Q100 64 130 72 L146 80 L160 130 L168 190 L174 224 L166 244 L156 214 L152 164 L144 130 L140 200 L132 214 L128 234 L124 380 L128 404 L106 404 L102 300 L100 250 L98 300 L94 404 L72 404 L76 380 L72 234 L68 214 L60 200 L56 130 L48 164 L44 214 L34 244 L26 224 L32 190 L40 130 L54 80 Z"}]],
        zones: [
      ["front-forehead","Forehead","",100.0,13.0,13.0,7.0],
      ["front-eye-right","Eye","right",91.0,27.0,6.0,4.0],
      ["front-eye-left","Eye","left",109.0,27.0,6.0,4.0],
      ["front-jaw","Jaw","",100.0,44.0,11.0,6.0],
      ["front-neck-front","Neck, front","",100.0,60.0,9.0,8.0],
      ["front-shoulder-right","Shoulder","right",64.0,84.0,9.0,9.0],
      ["front-shoulder-left","Shoulder","left",136.0,84.0,9.0,9.0],
      ["front-chest-right","Chest","right",84.0,104.0,15.0,13.0],
      ["front-chest-left","Chest","left",116.0,104.0,15.0,13.0],
      ["front-upper-abdomen-right","Upper abdomen","right",88.0,134.0,11.0,10.0],
      ["front-upper-abdomen-left","Upper abdomen","left",112.0,134.0,11.0,10.0],
      ["front-lower-abdomen-right","Lower abdomen","right",88.0,158.0,11.0,10.0],
      ["front-lower-abdomen-left","Lower abdomen","left",112.0,158.0,11.0,10.0],
      ["front-groin-pelvis","Groin / pelvis","",100.0,188.0,10.0,10.0],
      ["front-upper-arm-right","Upper arm","right",52.0,118.0,8.0,19.0],
      ["front-upper-arm-left","Upper arm","left",148.0,118.0,8.0,19.0],
      ["front-elbow-right","Elbow","right",44.0,152.0,7.0,7.0],
      ["front-elbow-left","Elbow","left",156.0,152.0,7.0,7.0],
      ["front-forearm-right","Forearm","right",38.0,184.0,7.0,17.0],
      ["front-forearm-left","Forearm","left",162.0,184.0,7.0,17.0],
      ["front-wrist-right","Wrist","right",33.0,212.0,5.0,5.0],
      ["front-wrist-left","Wrist","left",167.0,212.0,5.0,5.0],
      ["front-hand-right","Hand","right",30.0,232.0,7.0,10.0],
      ["front-hand-left","Hand","left",170.0,232.0,7.0,10.0],
      ["front-hip-right","Hip","right",76.0,196.0,9.0,9.0],
      ["front-hip-left","Hip","left",124.0,196.0,9.0,9.0],
      ["front-thigh-right","Thigh","right",83.0,240.0,13.0,25.0],
      ["front-thigh-left","Thigh","left",117.0,240.0,13.0,25.0],
      ["front-knee-right","Knee","right",84.0,284.0,9.0,9.0],
      ["front-knee-left","Knee","left",116.0,284.0,9.0,9.0],
      ["front-shin-right","Shin","right",84.0,328.0,9.0,24.0],
      ["front-shin-left","Shin","left",116.0,328.0,9.0,24.0],
      ["front-ankle-right","Ankle","right",85.0,370.0,6.0,6.0],
      ["front-ankle-left","Ankle","left",115.0,370.0,6.0,6.0],
      ["front-foot-right","Foot","right",85.0,392.0,10.0,8.0],
      ["front-foot-left","Foot","left",115.0,392.0,10.0,8.0]
        ],
      },
      back: {
        label: "BACK",
        shapes: [["ellipse",{"cx":"100","cy":"28","rx":"20","ry":"25"}],["rect",{"x":"90","y":"48","width":"20","height":"22","rx":"6"}],["path",{"d":"M70 72 Q100 64 130 72 L146 80 L160 130 L168 190 L174 224 L166 244 L156 214 L152 164 L144 130 L140 200 L132 214 L128 234 L124 380 L128 404 L106 404 L102 300 L100 250 L98 300 L94 404 L72 404 L76 380 L72 234 L68 214 L60 200 L56 130 L48 164 L44 214 L34 244 L26 224 L32 190 L40 130 L54 80 Z"}]],
        zones: [
      ["back-upper-trapezius-left","Upper trapezius","left",80.0,76.0,13.0,8.0],
      ["back-upper-trapezius-right","Upper trapezius","right",120.0,76.0,13.0,8.0],
      ["back-shoulder-left","Shoulder","left",64.0,86.0,9.0,9.0],
      ["back-shoulder-right","Shoulder","right",136.0,86.0,9.0,9.0],
      ["back-shoulder-blade-left","Shoulder blade","left",84.0,108.0,12.0,13.0],
      ["back-shoulder-blade-right","Shoulder blade","right",116.0,108.0,12.0,13.0],
      ["back-mid-back","Mid back","",100.0,138.0,14.0,12.0],
      ["back-lower-back-left","Lower back","left",88.0,166.0,11.0,11.0],
      ["back-lower-back-right","Lower back","right",112.0,166.0,11.0,11.0],
      ["back-tailbone-sacrum","Tailbone / sacrum","",100.0,192.0,8.0,8.0],
      ["back-buttock-left","Buttock","left",84.0,210.0,13.0,12.0],
      ["back-buttock-right","Buttock","right",116.0,210.0,13.0,12.0],
      ["back-back-of-upper-arm-left","Back of upper arm","left",52.0,118.0,8.0,19.0],
      ["back-back-of-upper-arm-right","Back of upper arm","right",148.0,118.0,8.0,19.0],
      ["back-elbow-left","Elbow","left",44.0,152.0,7.0,7.0],
      ["back-elbow-right","Elbow","right",156.0,152.0,7.0,7.0],
      ["back-forearm-left","Forearm","left",38.0,184.0,7.0,17.0],
      ["back-forearm-right","Forearm","right",162.0,184.0,7.0,17.0],
      ["back-hamstring-left","Hamstring","left",83.0,254.0,13.0,24.0],
      ["back-hamstring-right","Hamstring","right",117.0,254.0,13.0,24.0],
      ["back-back-of-knee-left","Back of knee","left",84.0,292.0,8.0,8.0],
      ["back-back-of-knee-right","Back of knee","right",116.0,292.0,8.0,8.0],
      ["back-calf-left","Calf","left",84.0,332.0,9.0,24.0],
      ["back-calf-right","Calf","right",116.0,332.0,9.0,24.0],
      ["back-heel-left","Heel","left",85.0,380.0,7.0,10.0],
      ["back-heel-right","Heel","right",115.0,380.0,7.0,10.0],
      ["back-back-of-head","Back of head","",100.0,14.0,14.0,9.0]
        ],
      },
    },

    // Strength 1-5: number + word everywhere ("4 · Strong").
    severity: [[1, "Mild"], [2, "Noticeable"], [3, "Moderate"], [4, "Strong"], [5, "Severe"]],

    types: [["ache", "Ache"], ["dull", "Dull"], ["sharp", "Sharp"], ["throbbing", "Throbbing"], ["burn", "Burning"], ["numb", "Numb"], ["stiff", "Stiff"], ["tingling", "Tingling"]],
    triggers: [["twisting", "Twisting"], ["lifting", "Lifting"], ["fall", "A fall"], ["sitting_long", "Sitting long"], ["exercise", "Exercise"], ["sport", "Sport or playing"], ["woke_with_it", "Woke with it"], ["no_idea", "No idea"]],
    spread: [["stays_here", "Stays here"], ["up_back", "Up the back"], ["buttock_left", "Buttock (your left)"], ["buttock_right", "Buttock (your right)"], ["leg_left", "Down the left leg"], ["leg_right", "Down the right leg"], ["below_knee", "Below the knee"]],
    worseWith: [["sitting", "Sitting"], ["standing", "Standing"], ["bending", "Bending"], ["twisting", "Twisting"], ["getting_up", "Getting up from sitting"], ["walking", "Walking"], ["coughing", "Coughing"], ["night_lying", "Night / lying"]],
    betterWith: [["walking", "Walking"], ["rest", "Rest"], ["lying_down", "Lying down"], ["heat", "Heat"], ["ice", "Ice"], ["stretching", "Stretching"], ["medication", "Medication"], ["nothing_yet", "Nothing yet"]],
    typesRetired: [], triggersRetired: [], spreadRetired: [], worseWithRetired: [], betterWithRetired: [],

    // Free-text limits (also enforced in the main process).
    limits: { note: 500, spreadOther: 80, maxEntries: 50000, maxFileBytes: 8388608 },

    // "Moving normally again?" in the Mark as better dialog.
    normal: [["yes", "Yes, normally"], ["mostly", "Mostly"], ["not_yet", "Not yet"]],

    // History ranges (days; null = all).
    ranges: [[7, "7 days"], [30, "30 days"], [90, "90 days"], [null, "All"]],
    // Heat levels: entries per period (1, 2-3, 4-6, 7+) and, for the "Strongest" view, the strongest severity (1, 2, 3-4, 5).
    heatEntries: [[1, 1], [2, 2], [4, 3], [7, 4]],      // [minimum count, level]
    heatStrongest: [[1, 1], [2, 2], [3, 3], [5, 4]],    // [minimum severity, level]
    heatLegend: { entries: ["1", "2–3", "4–6", "7+"], strongest: ["1", "2", "3–4", "5"] },

    // SAFETY (wording to be approved by Health Agent). Asked on EVERY update of a back / neck spot (zones listed below); answers are
    // yes | no | not_sure. An alert is shown when any answer is "yes", and when the bladder/bowel answer is "not_sure". The entry still saves,
    // with safety_flag = true. The neutral box must never say the person is fine or safe.
    // wording to be approved by Health Agent
    safetyZones: ["front-neck-front", "back-upper-trapezius-left", "back-upper-trapezius-right", "back-shoulder-blade-left", "back-shoulder-blade-right",
      "back-mid-back", "back-lower-back-left", "back-lower-back-right", "back-tailbone-sacrum", "back-buttock-left", "back-buttock-right", "back-back-of-head"],
    safety: {
      heading: "Three quick safety questions",
      questions: [
        { key: "weakness_numbness", text: "New weakness in a leg or foot, or numbness around your groin or inner thighs?", bold: ["weakness", "numbness"], yesAlert: "weakness or numbness", alertOnNotSure: true },
        { key: "bladder_bowel", text: "New trouble controlling or starting your bladder or bowel?", bold: ["controlling or starting your bladder or bowel"], yesAlert: "trouble with your bladder or bowel", alertOnNotSure: true },
        { key: "fever_unwell", text: "Fever, or feeling generally unwell with this pain?", bold: ["Fever"], yesAlert: "fever or feeling unwell", alertOnNotSure: false },
      ],
      answers: [["yes", "Yes"], ["no", "No"], ["not_sure", "Not sure"]],
      alertTitle: "Please get medical help today",
      alertBody: "With back pain this can need same-day care. Call your doctor, or the emergency number (101 in Israel), now. This app cannot judge it.",
      alertNotSure: "Not sure is worth checking: ask a doctor today.",
      saveAnyway: "Save entry anyway",
      onMyWay: "I’m on my way",
      onMyWayDone: "Saved with a safety flag. Take care.",
      savedFootnote: "The entry is saved with a safety flag so your doctor can see it.",
      okTitle: "Nothing flagged.",
      okBody: "Save, and check in again tomorrow. If any of these appears later, answer Yes on the next update. Pain that keeps getting worse, or lasts more than about 2 weeks, is worth telling your doctor about.",
      notAsked: "No safety questions for this spot. Save, and check in again tomorrow. Pain that keeps getting worse, or lasts more than about 2 weeks, is worth telling your doctor about.",
    },
  };
});

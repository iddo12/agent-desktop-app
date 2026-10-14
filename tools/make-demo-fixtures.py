"""Builds demo/fixtures (v1.86.0 demo mode): every file is INVENTED data for the fictional "Aurora Studio".
Run:  python tools/make-demo-fixtures.py
Needs reportlab and Pillow (only to make the sample PDFs and pictures; the app itself needs neither).
Hand-edit the JSON afterwards if you like; re-running overwrites. JSON is written WITHOUT a BOM on purpose."""
import json, os, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "demo" / "fixtures"
ROOT.mkdir(parents=True, exist_ok=True)

def jw(rel, obj):
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

def tw(rel, text):
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")

TEAL, AMBER, VIOLET, ROSE = "#14b8a6", "#f59e0b", "#8b5cf6", "#ec4899"
REP = "{{REPORTS}}"

PDF = {
    "gimbal": "Gimbal comparison, spring 2027.pdf",
    "invoices": "Q1 invoices summary.pdf",
    "web": "Website health check, week 14.pdf",
    "guide": "Spring wedding guide, draft 2.pdf",
}

# --------------------------------------------------------------------------------------------- agents
AGENTS = [
    dict(folder="Writer", name="Writer", role="Blog posts and newsletters", color=TEAL, group="Studio", state="working",
         status="Drafting the spring-wedding guide", recent=["Outline approved", "Draft 2 of the spring wedding guide written", "Newsletter subject lines tested"], reports=[PDF["guide"]]),
    dict(folder="Video", name="Video", role="Edit notes and shot lists", color=TEAL, group="Studio", state="idle",
         status="Waiting for the next shoot", recent=["Shot list for Saturday sent", "Highlights edit notes delivered"]),
    dict(folder="Shopping", name="Shopping", role="Gear and supplies", color=TEAL, group="Studio", state="needs",
         status="Two lens quotes ready, which one?", needsText="Two lens quotes ready - which one should I order?", recent=["Two quotes collected for the 35 mm lens", "Restocked lens cloths"]),
    dict(folder="Email", name="Email", role="Inbox triage and replies", color=AMBER, group="Business", state="working",
         status="Sorted 14 messages, 3 need a reply", recent=["14 messages sorted", "3 draft replies waiting"]),
    dict(folder="Finance", name="Finance", role="Invoices and quotes", color=AMBER, group="Business", state="idle",
         status="March invoices sent", recent=["March invoices sent", "Q1 summary written"], reports=[PDF["invoices"]]),
    dict(folder="Web", name="Web", role="Website and search ranking", color=VIOLET, group="Online", state="idle",
         status="Site check clean today", recent=["Weekly site check clean", "Two image sizes fixed"], reports=[PDF["web"]]),
    dict(folder="Research", name="Research", role="Market and gear research", color=VIOLET, group="Online", state="working",
         status="Comparing 5 gimbals", recent=["Gimbal shortlist built", "Report written"], reports=[PDF["gimbal"]]),
    dict(folder="Health", name="Health", role="Sleep, training and lab trends", color=ROSE, group="Personal", state="idle",
         status="Weekly review ready", recent=["Weekly review written", "Resting heart rate trend flagged as improving"]),
    dict(folder="Personal Assistant", name="Personal Assistant", role="Calendar, errands and family logistics", color=ROSE, group="Personal", state="working",
         status="Planning next week's schedule", recent=["Saturday shoot location checked", "Dentist appointment moved"]),
]

GROUPS = [
    dict(name="Studio", color=TEAL, members=["Writer", "Video", "Shopping"]),
    dict(name="Business", color=AMBER, members=["Email", "Finance"]),
    dict(name="Online", color=VIOLET, members=["Web", "Research"]),
    dict(name="Personal", color=ROSE, members=["Health", "Personal Assistant"]),
]

studio = dict(
    business="Aurora Studio", owner="Maya",
    usage=dict(sessionPct=38, weekPct=54, sessionResetsInMin=190, weekResetsInHours=70),
    groups=GROUPS,
    agents=[{k: v for k, v in a.items() if k not in ("color", "group")} for a in AGENTS],
)
jw("studio.json", studio)

# ---------------------------------------------------------------------------------------------- threads
def U(t, m): return dict(role="user", text=t, minsAgo=m)
def A(t, m, **kw): return dict(dict(role="agent", text=t, minsAgo=m), **kw)

GIMBAL_TABLE = """| Gimbal | Weight | Payload | Battery | Price |
|---|---|---|---|---|
| Model A | 1.1 kg | 3.2 kg | 12 h | $289 |
| Model B | 0.9 kg | 2.5 kg | 10 h | $219 |
| Model C | 1.3 kg | 4.0 kg | 14 h | $349 |
| Model D | 1.0 kg | 3.0 kg | 9 h | $199 |
| Model E | 0.8 kg | 2.0 kg | 8 h | $159 |"""

THREADS = {
    "Research": dict(tail="working", tool="WebSearch", contextTokens=52000, messages=[
        U("Can you compare five gimbals for the spring wedding season? I need one that holds my mirrorless with the 24-70 and lasts a full day.", 190),
        A("On it. I'll check weight, payload, battery life and street price for five current models and write it up as a short report.", 188),
        U("Any progress on the gimbals?", 3),
        A("Yes - here is the comparison.\n\n**Short version:** Model A and Model C both hold a mirrorless with the 24-70 comfortably. Model E is the lightest but its battery is the first to run out.\n\n" + GIMBAL_TABLE + "\n\nThe full write-up, with test notes and sample footage links, is here:\n\n" + REP + "\\" + PDF["gimbal"] + "\n\nNext I'm checking which of these are in stock locally.", 2, interim=True),
    ], replyRules=[
        dict(match="stock|local|available", text="Two of the five are in stock locally: Model A and Model D. Model C ships in about a week. I'll add the shop links to the report."),
        dict(match="cheap|budget|price", text="On price alone Model E is the cheapest ($159), but for a full wedding day I'd pick Model A: the battery lasts 12 hours and the payload leaves room for a heavier lens."),
    ], replies=["Thanks - I've added that to the comparison and will update the report. (This is a demo workspace, so nothing real is being searched.)"]),
    "Writer": dict(tail="working", tool="Write", contextTokens=44000, messages=[
        U("Please draft a guide for couples planning a spring wedding: timeline, light, and what to ask the photographer.", 260),
        A("Here is the outline I'd suggest:\n\n1. Choosing the month and the light\n2. A realistic wedding-day timeline\n3. Ten questions to ask any photographer\n4. Weather plan B\n\nShall I go ahead and write draft 1?", 255),
        U("Yes please, friendly tone, around 1,500 words.", 250),
        A("Draft 1 is written. I tightened the timeline section and added a checklist at the end. Draft 2 with your edits is saved as a PDF:\n\n" + REP + "\\" + PDF["guide"], 60),
        U("Great. Can you make the opening warmer and add a short section on golden hour?", 20),
        A("Working on it now - the golden hour section is half written.", 18, interim=True),
    ], replies=["Noted - I'll fold that into draft 3. (Demo workspace: nothing real is being written.)"]),
    "Video": dict(tail="idle", contextTokens=21000, messages=[
        U("Shot list for Saturday's garden-cafe shoot, please. Interior and terrace, about two hours.", 1500),
        A("Here is the shot list: 1) Wide establishing shot of the terrace, 2) Barista hands and pour, 3) Interior details, 4) Two portrait set-ups by the window, 5) Closing shot at golden hour. I've also added a battery and card checklist.", 1495),
        U("Perfect, thanks.", 1490),
        A("Anytime. I'll wait for the footage before starting the edit notes.", 1489),
    ], replies=["Sure - tell me when the card is backed up and I'll start the edit notes."]),
    "Shopping": dict(tail="idle", contextTokens=26000, messages=[
        U("I need a new 35 mm lens for portraits. Budget up to $900.", 400),
        A("I collected two quotes:\n\n| Option | Shop | Price | Delivery |\n|---|---|---|---|\n| Lens X 35 mm f/1.8 | Shop North | $780 | 3 days |\n| Lens Y 35 mm f/1.4 | Shop South | $890 | 5 days |\n\nLens Y is sharper wide open but heavier. Which one should I order?", 380),
    ], replyRules=[dict(match="\\bX\\b|first|cheaper|780", text="Lens X it is - I'll order it from Shop North and send you the confirmation."), dict(match="\\bY\\b|second|1\\.4|890", text="Lens Y it is - I'll place the order with Shop South and send you the confirmation.")],
       replies=["Thanks - tell me which of the two lenses you prefer and I'll order it."]),
    "Email": dict(tail="working", tool="Read", contextTokens=39000, messages=[
        U("Sort the inbox and tell me what needs a reply.", 90),
        A("Sorted 14 messages. Three need a reply: the venue about Saturday's access time, a client asking about print sizes, and a supplier invoice question. I've drafted answers to all three for you to review.", 80),
        U("Show me the venue one first.", 15),
        A("Draft: \"Hello, thank you for the details. We will arrive at 14:00 to set up. Could you confirm that the terrace is free until 16:00? Best, Maya\"", 14, interim=True),
    ], replies=["Understood - I'll send it once you approve. (Demo workspace: no mail is touched.)"]),
    "Finance": dict(tail="idle", contextTokens=24000, messages=[
        U("Send the March invoices and give me a Q1 summary.", 2900),
        A("All March invoices are sent. The Q1 summary is ready:\n\n" + REP + "\\" + PDF["invoices"] + "\n\nInvoiced $18,420, received $15,960, two invoices still open.", 2890),
    ], replies=["Noted. I'll follow up on the two open invoices on Monday."]),
    "Web": dict(tail="idle", contextTokens=23000, messages=[
        U("Run the weekly site check.", 3000),
        A("Site check is clean: no broken links, all pages load under two seconds, and the new gallery images are compressed. Report:\n\n" + REP + "\\" + PDF["web"], 2990),
    ], replies=["I'll re-run the check tomorrow morning."]),
    "Health": dict(tail="idle", contextTokens=28000, messages=[
        U("How was my week?", 800),
        A("Good week overall: sleep averaged 7 h 20 min (up 15 minutes), resting heart rate eased by 2 beats, and you hit your step goal on five days. One thing to watch: two late nights on Thursday and Friday.", 795),
    ], replies=["Thanks - I'll include that in the weekly review. (Demo data only.)"]),
    "Personal Assistant": dict(tail="working", tool="Calendar", contextTokens=31000, messages=[
        U("Can you check next week for clashes and propose a schedule?", 70),
        A("Next week has one clash: the dentist on Tuesday overlaps the client call. I can move the dentist to Wednesday morning. Shall I?", 65),
        U("Yes, move it.", 40),
        A("Done - the dentist is now Wednesday at 09:30. I'm building the rest of the week around Saturday's shoot.", 38, interim=True),
    ], replies=["Added to the plan for next week."]),
}
for folder, th in THREADS.items():
    jw(f"agents/{folder}/thread.json", th)

INSTR = {
    "Research": """# Research agent - Aurora Studio

You research gear, tools and markets for a small photo and video studio run by Maya.

## What you do
- Compare products on weight, payload, battery, price and availability.
- Write every finished comparison as a short PDF report and give Maya its full path.
- Keep sources and test notes at the end of each report.

## How you work
- Lead with the short answer, then the table, then the details.
- Prices are street prices in USD; say when a figure is an estimate.
- When a question needs a decision, end with one clear recommendation.

## Never
- Order anything or contact a shop without Maya's approval.
""",
}
for a in AGENTS:
    text = INSTR.get(a["folder"]) or f"""# {a['name']} agent - Aurora Studio

{a['role']} for a small photo and video studio run by Maya.

## What you do
- Keep your area of the studio running without being asked twice.
- Report in short, plain sentences; put anything that needs a decision first.
- Save finished work as a PDF and give Maya its full path.

## Never
- Spend money, send a message or publish anything without Maya's approval.
"""
    tw(f"agents/{a['folder']}/instructions.md", text)

# ---------------------------------------------------------------------------------------------- library
def P(id_, title, desc, agent, stage, topic="studio", pdf=None, days=2):
    d = dict(id=id_, type="project", title=title, description=desc, agent=agent, topic=topic, stage=stage, daysAgo=days)
    if pdf: d["reportFile"] = pdf
    return d
entries = [
    P("idea-bts-series", "Behind-the-scenes mini-series", "Short monthly clips showing how a shoot comes together.", "Video", "idea", days=6),
    P("idea-client-gallery", "Client gallery page", "A private page where clients pick and download their photos.", "Web", "idea", days=9),
    P("idea-print-popup", "Print shop pop-up", "A weekend pop-up selling framed prints from the studio.", "Shopping", "idea", days=12),
    P("res-gimbals", "Gimbal comparison", "Five gimbals compared on weight, payload, battery and price.", "Research", "researched", pdf=PDF["gimbal"], days=1),
    P("res-newsletter-tools", "Email newsletter tools", "Four newsletter tools compared for a list of 2,000.", "Writer", "researched", days=5),
    P("res-lighting", "Studio lighting kits", "Three continuous-light kits for small portrait sessions.", "Research", "researched", days=7),
    P("act-wedding-guide", "Spring wedding guide", "The guide for couples planning a spring wedding (draft 2 written).", "Writer", "active", pdf=PDF["guide"], days=1),
    P("act-gallery-build", "Client gallery page build", "Building the private client gallery on the studio site.", "Web", "active", days=3),
]
docs = [
    ("doc-gimbal", "Gimbal comparison, spring 2027", "Research", PDF["gimbal"], 1),
    ("doc-invoices", "Q1 invoices summary", "Finance", PDF["invoices"], 3),
    ("doc-web", "Website health check, week 14", "Web", PDF["web"], 2),
    ("doc-guide", "Spring wedding guide, draft 2", "Writer", PDF["guide"], 1),
]
for id_, title, agent, f, days in docs:
    entries.append(dict(id=id_, type="document", title=title, description=f"Finished report by the {agent} agent.", agent=agent, topic="reports", reportFile=f, daysAgo=days))
IMAGES = [("img-light-a", "Window light test", "Video"), ("img-light-b", "Terrace golden hour", "Video"), ("img-moodboard", "Spring palette moodboard", "Writer")]
for id_, title, agent in IMAGES:
    entries.append(dict(id=id_, type="image", title=title, description="AI-generated concept illustration.", agent=agent, topic="images", imageFile=id_ + ".png", daysAgo=4))
jw("library/entries.json", entries)

# ---------------------------------------------------------------------------------------------- daily
jw("daily/tasks.json", [
    dict(agent="Personal Assistant", title="Confirm Saturday shoot location", priority=1, daysAgo=1, group="Studio shoots", tags=[]),
    dict(agent="Finance", title="Send quote to the garden-cafe project", priority=1, daysAgo=2, group="Studio sales", tags=[]),
    dict(agent="Video", title="Back up the wedding card", priority=2, daysAgo=1, group="Studio shoots", tags=[]),
    dict(agent="Research", title="Review gimbal comparison", priority=2, daysAgo=0, group="Studio gear", tags=[]),
    dict(agent="Shopping", title="Choose between two 35 mm lens quotes", priority=1, daysAgo=1, group="Studio gear", needsYou=True, tags=[]),
    dict(agent="Health", title="Book the yearly blood test", priority=3, daysAgo=3, group="Home", tags=["personal"]),
    dict(agent="Personal Assistant", title="Renew the studio insurance", priority=3, daysAgo=4, group="Studio admin", tags=["queued"]),
])
jw("daily/shopping.json", dict(addedBy="Maya", lists=[dict(id="studio", name="Studio supplies", items=["lens cloths", "2 SD cards 256 GB", "gaffer tape", "batteries AA x8"])]))
jw("daily/shipments.json", dict(items=[dict(id="p1", numbers=[dict(no="1Z999AA10123456784", carrier="ups")], carrier="ups", merchant="Gear Supply Co", title="Tripod head", state="in_transit", stateDaysAgo=1, etaWeekday=4, etaText="Thursday", lastEvent=dict(text="Departed regional hub", place="Distribution centre"), source="manual")]))
jw("daily/dates.json", dict(items=[
    dict(id="d1", title="Studio anniversary", month=0, day=0, inDays=17, kind="date"),
    dict(id="d2", title="Mom's birthday", month=0, day=0, inDays=26, kind="birthday"),
]))

# ---------------------------------------------------------------------------------------------- finance (concept screen, demo only)
jw("finance.json", dict(
    currency="$",
    months=["May", "Jun", "Jul", "Aug", "Sep", "Oct"],
    moneyIn=[7200, 8100, 6900, 9400, 10200, 8800],
    moneyOut=[5100, 5400, 5200, 5900, 6100, 5700],
    kpis=[dict(label="Cash on hand", value="$24,310", note="up $1,860 on last month"), dict(label="Invoiced this quarter", value="$18,420", note="vs $16,050 last quarter"),
          dict(label="Received this quarter", value="$15,960", note="87% of invoiced"), dict(label="Bills due in 14 days", value="$2,140", note="4 bills")],
    recurring=[dict(name="Studio rent", amount=1450, due="1st"), dict(name="Editing software", amount=64, due="3rd"), dict(name="Insurance", amount=118, due="8th"),
               dict(name="Cloud storage", amount=29, due="12th"), dict(name="Website hosting", amount=22, due="15th"), dict(name="Phone and internet", amount=87, due="20th")],
    invoices=[dict(client="Garden Cafe", invoiced=3200, received=3200), dict(client="Hilltop Wedding", invoiced=4800, received=2400), dict(client="Nova Skincare", invoiced=5600, received=5600),
              dict(client="Harbor Hotel", invoiced=2900, received=1800), dict(client="Studio prints", invoiced=1920, received=1960)],
))

# ---------------------------------------------------------------------------------------------- health (invented person, invented numbers)
def lab(test, value, unit, lo, hi, days, optlo=None, opthi=None):
    d = dict(test=test, value=value, unit=unit, refLow=lo, refHigh=hi, daysAgo=days)
    if optlo is not None: d["optLow"] = optlo
    if opthi is not None: d["optHigh"] = opthi
    return d
labs = []
for days, v in ((14, dict(alb=43, cre=80, glu=5.3, crp=1.2, lym=30, mcv=91, rdw=13.2, alp=70, wbc=5.9, ldl=2.6, hdl=1.6, tg=0.9, a1c=5.2, vitd=78, ferr=88)),
                (200, dict(alb=42, cre=84, glu=5.6, crp=2.4, lym=29, mcv=92, rdw=13.6, alp=76, wbc=6.4, ldl=3.1, hdl=1.5, tg=1.2, a1c=5.4, vitd=52, ferr=76))):
    labs += [
        lab("Albumin", v["alb"], "g/L", 35, 50, days), lab("Creatinine", v["cre"], "umol/L", 45, 90, days), lab("Glucose (fasting)", v["glu"], "mmol/L", 3.9, 5.6, days),
        lab("CRP", v["crp"], "mg/L", 0, 5, days, 0, 1), lab("Lymphocytes", v["lym"], "%", 20, 40, days), lab("MCV", v["mcv"], "fL", 80, 100, days),
        lab("RDW", v["rdw"], "%", 11.5, 14.5, days), lab("Alkaline phosphatase", v["alp"], "U/L", 40, 130, days), lab("WBC", v["wbc"], "10^3/uL", 4, 10, days),
        lab("LDL cholesterol", v["ldl"], "mmol/L", 0, 3.4, days, 0, 2.6), lab("HDL cholesterol", v["hdl"], "mmol/L", 1.0, 3.0, days), lab("Triglycerides", v["tg"], "mmol/L", 0, 1.7, days),
        lab("HbA1c", v["a1c"], "%", 4.0, 5.7, days), lab("Vitamin D", v["vitd"], "nmol/L", 50, 125, days, 75, 125), lab("Ferritin", v["ferr"], "ug/L", 30, 300, days),
    ]
series = [
    dict(metric="weight", source="scale", base=71.8, trend=-1.2, noise=0.25, weekly=0.2, decimals=1, days=90, hour=7, minute=10),
    dict(metric="body_fat", source="scale", base=19.6, trend=-1.0, noise=0.2, decimals=1, days=90, skipEvery=3),
    dict(metric="resting_hr", source="watch", base=60, trend=-3, noise=1.2, weekly=1, decimals=0, days=90),
    dict(metric="hrv", source="watch", base=52, trend=7, noise=4, weekly=3, decimals=0, days=90),
    dict(metric="steps", source="watch", base=8300, trend=900, noise=1900, weekly=1400, decimals=0, days=90, hour=23, minute=0),
    dict(metric="sleep_minutes", source="watch", base=420, trend=18, noise=28, weekly=10, decimals=0, days=90, hour=6, minute=45),
    dict(metric="spo2", source="watch", base=97, trend=0.3, noise=0.8, decimals=0, days=90),
    dict(metric="vo2max", source="watch", base=44.2, trend=1.6, noise=0.3, decimals=1, days=90, skipEvery=4),
    dict(metric="grip_strength", source="clinic", base=39.0, trend=1.5, noise=0.5, decimals=1, days=90, skipEvery=7),
]
agent_files = dict(
    interactions=[
        dict(id="mag-vitd", a="Magnesium", b="Vitamin D", severity="info", summary="Taken together they support each other: magnesium helps the body use vitamin D. No change needed."),
        dict(id="iron-calcium", a="Iron", b="Calcium", severity="timing", summary="Calcium can reduce how much iron is absorbed. Taking them a few hours apart avoids the problem."),
        dict(id="caffeine-melatonin", a="Evening coffee", b="Melatonin", severity="caution", summary="Caffeine late in the day can work against melatonin and shorten deep sleep. Consider moving the last coffee earlier."),
        dict(id="omega-fishoil", a="Omega-3", b="Blood-thinning medicine", severity="serious", summary="Large amounts of omega-3 can add to the effect of blood thinners. Ask a doctor before combining them."),
    ],
    evidence=[
        dict(id="ev-magnesium", name="Magnesium before bed", kind="supplement", tradition="western", summary="Small trials suggest modest help with sleep quality.", evidence=[dict(level="single-study", strength=2, note="Small trials, mixed results")]),
        dict(id="ev-zone2", name="Zone 2 cardio", kind="exercise", tradition="western", summary="Steady, easy-pace cardio is linked with better fitness and heart health.", evidence=[dict(level="meta-analysis", strength=4, note="Consistent across many studies")]),
        dict(id="ev-breathwork", name="Slow breathing", kind="practice", tradition="ayurveda", summary="Slow breathing at about six breaths a minute can lower stress and resting heart rate.", evidence=[dict(level="single-study", strength=3, note="Several small trials")]),
    ],
    insights=[
        dict(id="insight-rhr", title="Your resting heart rate is easing", summary="Over the last 90 days your resting heart rate fell by about three beats while your fitness estimate rose. That combination usually means your regular walks and runs are working.", topic="exercise", evidence=dict(level="meta-analysis", strength=4), why=dict(text="Matches your trend in resting heart rate and VO2max.", relates=[dict(type="metric", id="resting_hr"), dict(type="metric", id="vo2max")])),
        dict(id="insight-sleep", title="Late nights cost you deep sleep", summary="On the two nights after 23:30 your total sleep dropped by about 40 minutes. An earlier wind-down on Thursdays could help.", topic="sleep", evidence=dict(level="single-study", strength=3), why=dict(text="Seen in your own sleep data.", relates=[dict(type="metric", id="sleep_minutes")])),
        dict(id="insight-vitd", title="Vitamin D is now in the optimal range", summary="Your latest result moved from low-normal to the optimal range after the autumn routine.", topic="labs", evidence=dict(level="guideline", strength=4), why=dict(text="Latest blood test compared with six months ago.", relates=[dict(type="lab", id="vitamin-d")])),
    ],
    plan=[
        dict(id="plan-zone2", group="exercise", title="Two easy 40-minute walks or jogs a week", evidence=dict(level="meta-analysis", strength=4), why=dict(text="Supports resting heart rate and VO2max.", relates=[dict(type="metric", id="vo2max")])),
        dict(id="plan-magnesium", group="vitamins", title="Magnesium in the evening", evidence=dict(level="single-study", strength=2), why=dict(text="Possible help with sleep quality.", relates=[dict(type="metric", id="sleep_minutes")])),
        dict(id="plan-breath", group="practice", title="Five minutes of slow breathing before bed", evidence=dict(level="single-study", strength=3), why=dict(text="May lower stress and help sleep.", relates=[dict(type="metric", id="hrv")])),
    ],
    trendNotes={"resting_hr": "Down three beats in 90 days, steady.", "hrv": "Rising trend; two dips after late nights.", "weight": "Slowly down, about 1 kg in 90 days."},
    reading=[dict(id="read-zone2", title="Easy-pace training and long-term heart health", kind="article", authors="Invented Author", year=2025, minutes=8, points=["Easy, steady cardio builds an aerobic base.", "Most people do their easy days too hard.", "Two to three sessions a week is enough to start."], evidence=dict(level="meta-analysis", strength=4), relates=[dict(type="metric", id="vo2max")])],
    worldview="Maya prefers small, steady habits over strict plans. She trains outdoors twice a week, values good sleep, and wants simple explanations with the evidence level stated.\n",
    weekly=dict(summary="A good week: sleep and resting heart rate both improved, and steps were above goal on five days.", changed=["Added a magnesium supplement in the evening", "Moved the last coffee to before 14:00"], improved=[dict(label="Resting heart rate", text="Down two beats on the week."), dict(label="Sleep", text="Average up 15 minutes.")], worsened=[dict(label="Late nights", text="Two nights after 23:30.")], experiments=["Evening breathing practice, day 9 of 14"], questions=["Would an earlier last coffee help the late-night sleep dip?"]),
)
jw("health/health.json", dict(
    profile=dict(birthYM="1988-06"),
    series=series, bloodPressure=[dict(days=90, every=3, sys=116, dia=74, noise=5, seed=7)],
    labs=labs,
    meds=[dict(name="Vitamin D", dose="", schedule="Morning", medKind="supplement", startDaysAgo=120, note="Winter routine"), dict(name="Magnesium", dose="", schedule="Evening", medKind="supplement", startDaysAgo=40), dict(name="Omega-3", dose="", schedule="With breakfast", medKind="supplement", startDaysAgo=200)],
    notes=[dict(text="Felt rested after an earlier night. Light run in the park.", daysAgo=3, tags=["sleep", "exercise"]), dict(text="Started evening breathing practice.", daysAgo=9, tags=["practice"])],
    agent=agent_files,
))

# ---------------------------------------------------------------------------------------------- scene placeholder (Phase 2)
tw("scenes/README.md", "Reserved for Phase 2: named scene files (B1-B10) for a scene player. Ignored by demo mode for now.\n")

# ---------------------------------------------------------------------------------------------- avatars, pictures, PDFs
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def hexrgb(h): h = h.lstrip("#"); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
def font(size):
    for f in ("C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf"):
        if os.path.exists(f): return ImageFont.truetype(f, size)
    return ImageFont.load_default()

def avatar(a):
    S = 256
    c = hexrgb(a["color"])
    img = Image.new("RGB", (S, S))
    px = img.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            k = 0.62 + 0.55 * (1 - t)
            px[x, y] = tuple(min(255, int(c[i] * k)) for i in range(3))
    d = ImageDraw.Draw(img)
    letter = a["name"][0].upper()
    f = font(130)
    w, h = d.textbbox((0, 0), letter, font=f)[2:]
    d.text(((S - w) / 2, (S - h) / 2 - 18), letter, font=f, fill=(255, 255, 255))
    out = ROOT / "agents" / a["folder"] / "avatar.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
for a in AGENTS: avatar(a)

def picture(id_, c1, c2):
    W, H = 640, 420
    img = Image.new("RGB", (W, H))
    px = img.load()
    a, b = hexrgb(c1), hexrgb(c2)
    for y in range(H):
        for x in range(W):
            t = (x / W * 0.6 + y / H * 0.4)
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    d = ImageDraw.Draw(img)
    d.ellipse((W * 0.58, H * 0.12, W * 0.9, H * 0.12 + W * 0.32), fill=(255, 244, 214))
    img = img.filter(ImageFilter.GaussianBlur(2))
    out = ROOT / "images" / (id_ + ".png")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
picture("img-light-a", "#1e293b", "#f59e0b")
picture("img-light-b", "#7c2d12", "#fcd34d")
picture("img-moodboard", "#a7f3d0", "#fbcfe8")

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
ss = getSampleStyleSheet()

def make_pdf(name, title, intro, rows=None, bullets=None):
    out = ROOT / "reports" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(out), pagesize=A4, title=title, author="Aurora Studio (fictional)", leftMargin=54, rightMargin=54, topMargin=54, bottomMargin=54)
    el = [Paragraph(title, ss["Title"]), Paragraph("Aurora Studio - sample report with invented data, made for a demo", ss["Italic"]), Spacer(1, 14), Paragraph(intro, ss["BodyText"]), Spacer(1, 12)]
    if rows:
        t = Table(rows, hAlign="LEFT")
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#14b8a6")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("GRID", (0, 0), (-1, -1), 0.4, colors.grey), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f1f5f9")]), ("PADDING", (0, 0), (-1, -1), 6)]))
        el += [t, Spacer(1, 12)]
    for b in bullets or []:
        el.append(Paragraph("&bull; " + b, ss["BodyText"]))
    doc.build(el)

make_pdf(PDF["gimbal"], "Gimbal comparison, spring 2027", "Five gimbals compared for a mirrorless camera with a 24-70 lens, for a full wedding day. All figures are invented for this demo.",
         [["Gimbal", "Weight", "Payload", "Battery", "Price"], ["Model A", "1.1 kg", "3.2 kg", "12 h", "$289"], ["Model B", "0.9 kg", "2.5 kg", "10 h", "$219"], ["Model C", "1.3 kg", "4.0 kg", "14 h", "$349"], ["Model D", "1.0 kg", "3.0 kg", "9 h", "$199"], ["Model E", "0.8 kg", "2.0 kg", "8 h", "$159"]],
         ["Recommendation: Model A for the best balance of battery and payload.", "Model C is the pick if you shoot with heavier lenses.", "Model E is the lightest but runs out first."])
make_pdf(PDF["invoices"], "Q1 invoices summary", "Invoices sent and received in the first quarter. All figures are invented for this demo.",
         [["Client", "Invoiced", "Received", "Open"], ["Garden Cafe", "$3,200", "$3,200", "$0"], ["Hilltop Wedding", "$4,800", "$2,400", "$2,400"], ["Nova Skincare", "$5,600", "$5,600", "$0"], ["Harbor Hotel", "$2,900", "$1,800", "$1,100"], ["Studio prints", "$1,920", "$1,960", "-$40"]],
         ["Total invoiced: $18,420. Total received: $15,960.", "Two invoices are still open and will be chased on Monday."])
make_pdf(PDF["web"], "Website health check, week 14", "Weekly check of the studio website. All results are invented for this demo.",
         [["Check", "Result"], ["Broken links", "0"], ["Slowest page", "1.8 s"], ["Images over 500 KB", "0"], ["Search ranking: 'wedding photographer'", "Position 7 (up 1)"]],
         ["Everything is clean this week.", "The new gallery images are compressed and load quickly."])
make_pdf(PDF["guide"], "Spring wedding guide, draft 2", "A friendly guide for couples planning a spring wedding. Draft text, invented for this demo.", None,
         ["1. Choosing the month and the light", "2. A realistic wedding-day timeline", "3. Ten questions to ask any photographer", "4. Weather plan B", "Golden hour: plan portraits about an hour before sunset, when the light is soft and warm."])
print("fixtures written to", ROOT)

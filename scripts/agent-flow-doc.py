#!/usr/bin/env python3
"""
Build docs/agent-name-flow.{html,pdf} — "How the agent finds the physician".

    python3 scripts/agent-flow-doc.py
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
      --no-pdf-header-footer --print-to-pdf=docs/agent-name-flow.pdf \
      --virtual-time-budget=6000 file://$PWD/docs/agent-name-flow.html

The three flow panels are GENERATED rather than hand-drawn SVG: every box is as
tall as its own text (box_height), the rows are laid out from a list, and the
arrows are computed from the boxes — so a wording change cannot leave a label
hanging outside its box or a panel taller than one A4 page. Panel heights are
kept under ~1000px for exactly that reason; A4 at 13mm margins gives 1024px of
printable height, and each panel carries `break-inside: avoid`.

Edit the wording in panel_one / panel_two / panel_three and re-run. The prose,
tables and code blocks under the diagram live in build().
"""

import html, pathlib

W = 700           # svg width
BOX_W = 330       # main-path box width
SIDE_W = 232      # outcome box width
MAIN_X = 40       # main path left edge
SIDE_X = 430      # side/outcome left edge
GAP = 25          # vertical space between boxes — kept tight so a panel fits one A4 page

KIND_STYLE = {
    'start':    ('#e6f1f3', '#0a6273', '#12242c'),
    'step':     ('#ffffff', '#93b3bb', '#12242c'),
    'ask':      ('#fdf4e3', '#c08a1e', '#5c4106'),
    'answer':   ('#eaf6ef', '#2f8a58', '#0f4d2c'),
    'stop':     ('#fdeef1', '#b5455f', '#7d1027'),
    'source':   ('#eef3f4', '#4a7f8c', '#12242c'),
}


def esc(t):
    return html.escape(t, quote=False)


def box_height(title, tech, minimum=46):
    """Tall enough for every line plus the technical note — never clipped."""
    lines = title if isinstance(title, list) else [title]
    return max(minimum, len(lines) * 17 + (16 if tech else 0) + 24)


def node(n):
    """One box: {x,y,w,h,kind,title,tech,num}"""
    fill, stroke, ink = KIND_STYLE[n['kind']]
    x, y, w, h = n['x'], n['y'], n['w'], n['h']
    dash = ' stroke-dasharray="5 3"' if n['kind'] == 'ask' else ''
    out = [
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" fill="{fill}" '
        f'stroke="{stroke}" stroke-width="1.4"{dash}/>'
    ]
    title = n['title']
    tech = n.get('tech')
    cx = x + w / 2
    if n.get('num'):
        out.append(
            f'<circle cx="{x + 17}" cy="{y + 17}" r="11" fill="{stroke}"/>'
            f'<text x="{x + 17}" y="{y + 21.5}" text-anchor="middle" class="num">{n["num"]}</text>'
        )
    lines = title if isinstance(title, list) else [title]
    block = len(lines) * 17 + (16 if tech else 0)
    ty = y + (h - block) / 2 + 13
    for line in lines:
        out.append(
            f'<text x="{cx}" y="{ty:.1f}" text-anchor="middle" class="t" fill="{ink}">{esc(line)}</text>'
        )
        ty += 17
    if tech:
        out.append(
            f'<text x="{cx}" y="{ty + 1:.1f}" text-anchor="middle" class="tech">({esc(tech)})</text>'
        )
    return '\n'.join(out)


def arrow(x1, y1, x2, y2, label=None, side='right', dashed=False):
    d = ' stroke-dasharray="4 3"' if dashed else ''
    out = [f'<path d="M {x1} {y1} L {x2} {y2}" class="edge" marker-end="url(#ah)"{d}/>']
    if label:
        out.append(
            f'<text x="{x1 + 9}" y="{y1 - 5}" text-anchor="start" class="lbl">{esc(label)}</text>'
        )
    return '\n'.join(out)


def elbow(x1, y1, x2, y2, label=None, dashed=False):
    """Horizontal then vertical, for a branch that leaves the main path."""
    d = ' stroke-dasharray="4 3"' if dashed else ''
    out = [f'<path d="M {x1} {y1} H {x2} V {y2}" class="edge" marker-end="url(#ah)" fill="none"{d}/>']
    if label:
        out.append(f'<text x="{x1 + 8}" y="{y1 - 6}" class="lbl">{esc(label)}</text>')
    return '\n'.join(out)


def panel(title, kicker, height, body):
    return f'''<figure class="panel">
  <figcaption><span class="pt">{esc(title)}</span><span class="pk">{esc(kicker)}</span></figcaption>
  <svg viewBox="0 0 {W} {height}" width="100%" role="img" aria-label="{esc(title)}">
    <defs>
      <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#5d7b85"/>
      </marker>
    </defs>
    {body}
  </svg>
</figure>'''


# ── Panel 1: what we already know ───────────────────────────────────────────
def panel_one():
    rows, y = [], 14
    def main(kind, title, tech=None, num=None, h=None):
        nonlocal y
        h = h if h else box_height(title, tech, 52)
        n = {'x': MAIN_X, 'y': y, 'w': BOX_W, 'h': h, 'kind': kind, 'title': title, 'tech': tech, 'num': num}
        rows.append(n); y += h + GAP
        return n
    out = []
    a = main('start', 'A meeting in the calendar', 'Outlook event, read with Microsoft Graph')
    b = main('step', 'Read what the meeting says', 'title + description + attendees', num=1)
    b2 = main('step', 'Take our own brief back out of the text', 'graph.stripInjectedBrief', num=2)
    c = main('ask', 'Is an NPI number written on it?', 'rung 0 — npiFromEvent', num=3)
    d = main('ask', "Is an attendee's email in our database?", 'rung 1 — bis_physicians, 21k rows', num=4)
    e = main('ask', 'Did the rep already choose someone?', 'rung 2 — app_activities.chosen_npi', num=5)
    f = main('ask', 'Does it say "Dr" or "Doctor"?', 'rung 3 — the gate', num=6)
    g = main('step', 'Read the name, the place, the specialty', 'namesToLookUp + hintsFromEvent', num=7)
    h_ = main('ask', 'Is that name in our own directory?', 'rung 4 — name tokens in bis_physicians', num=8)
    for n in rows:
        out.append(node(n))
    # vertical spine
    for p, q in zip(rows, rows[1:]):
        out.append(arrow(MAIN_X + BOX_W / 2, p['y'] + p['h'], MAIN_X + BOX_W / 2, q['y'] - 4))

    side = []
    def outcome(y, kind, title, tech=None, h=None, w=SIDE_W):
        h = h if h else box_height(title, tech)
        n = {'x': SIDE_X, 'y': y, 'w': w, 'h': h, 'kind': kind, 'title': title, 'tech': tech}
        side.append(n)
        return n
    o1 = outcome(c['y'] + 3, 'answer', ['Use that NPI. No name to', 'guess, nothing to choose'], 'skips the whole ladder')
    o2 = outcome(d['y'] + 3, 'answer', ['That is the person —', 'no outside call at all'], 'status: matched')
    o3 = outcome(e['y'] + 3, 'answer', ['The rep’s answer wins', 'over anything we find'], 'via: rep-choice')
    o4 = outcome(f['y'] + 3, 'stop', ['STOP. A normal meeting.', 'Nothing looked up, nothing', 'shown, nothing emailed'], 'status: gate_blocked')
    o5 = outcome(h_['y'] - 6, 'answer', ['1 match → that is who it is', '2–5 → the rep picks from a list'], 'matched / choose')
    for n in side:
        out.append(node(n))
    for q, o, lbl in ((c, o1, 'yes'), (d, o2, 'yes'), (e, o3, 'yes'), (f, o4, 'no'), (h_, o5, 'found')):
        out.append(arrow(MAIN_X + BOX_W, q['y'] + q['h'] / 2, SIDE_X - 4, o['y'] + o['h'] / 2, lbl))
    # continue-down labels
    for q in (c, d, e):
        out.append({'x': 0} and f'<text x="{MAIN_X + BOX_W/2 - 8}" y="{q["y"] + q["h"] + 19}" text-anchor="end" class="lbl">no</text>')
    out.append(f'<text x="{MAIN_X + BOX_W/2 - 8}" y="{f["y"] + f["h"] + 19}" text-anchor="end" class="lbl">yes</text>')
    tail_y = h_['y'] + h_['h']
    out.append(arrow(MAIN_X + BOX_W / 2, tail_y, MAIN_X + BOX_W / 2, tail_y + 34))
    out.append(f'<text x="{MAIN_X + BOX_W/2}" y="{tail_y + 54}" text-anchor="middle" class="hand">nobody by that name → go outside (panel 2)</text>')
    return panel('1 · What we already know', 'The cheapest answers first: our own data, and the rep’s own decision',
                 tail_y + 68, '\n'.join(out))


# ── Panel 2: the two websites ───────────────────────────────────────────────
def panel_two():
    rows, out, y = [], [], 14
    def main(kind, title, tech=None, num=None, h=None):
        nonlocal y
        h = h if h else box_height(title, tech, 52)
        n = {'x': MAIN_X, 'y': y, 'w': BOX_W, 'h': h, 'kind': kind, 'title': title, 'tech': tech, 'num': num}
        rows.append(n); y += h + GAP
        return n

    s1 = main('source', ['SOURCE 1 — CMS Medicare billing data', 'Ask the surname'],
              'data.cms.gov · by-provider-and-service', num=9)
    g1 = main('step', ['One row per billing code → group by NPI', '327 rows for "Abernathy" = 46 people'],
              'providersFrom() drops organisations', num=10)
    q1 = main('ask', ['Did it match the FULL name exactly?', '(first name AND last name)'],
              'sources.isExactMatch', num=11)
    s2 = main('source', ['SOURCE 2 — NPPES NPI Registry', 'Ask the same name'],
              'npiregistry.cms.hhs.gov/api · version 2.1', num=12)
    m1 = main('step', ['Merge the two lists — one row per person.', 'Whoever found them keeps the record;',
                       'the registry’s NUCC code is always taken'],
              'mergeCandidate — dedupe by NPI', num=13)
    r1 = main('step', ['Check every NPI against our own', 'database once more'],
              'recovered_in_bis — marked as already ours', num=14)
    sc = main('step', ['Score each person against what the', 'meeting actually said'], 'score.js — see the table below', num=15)
    q2 = main('ask', ['Best one at 70% or more, and 10 points', 'clear of the next?'], 'CONFIDENCE_SHOW · AMBIGUOUS_MARGIN', num=16)

    for n in rows:
        out.append(node(n))
    for p, q in zip(rows, rows[1:]):
        out.append(arrow(MAIN_X + BOX_W / 2, p['y'] + p['h'], MAIN_X + BOX_W / 2, q['y'] - 4))

    side = []
    def outcome(y, kind, title, tech=None, h=None):
        h = h if h else box_height(title, tech)
        n = {'x': SIDE_X, 'y': y, 'w': SIDE_W, 'h': h, 'kind': kind, 'title': title, 'tech': tech}
        side.append(n)
        return n
    n1 = outcome(s1['y'] - 2, 'step', ['2 calls: catalogue for the', 'year’s dataset id, then the', 'surname filter + first name', 'as a keyword'], 'never two filters — it hangs')
    n2 = outcome(q1['y'] + 2, 'answer', ['Stop here. NPPES is not', 'asked at all'], 'the person is already named')
    n3 = outcome(s2['y'] - 2, 'step', ['Billing data holds Medicare', 'billers only, so the registry', 'can know people it does not'], 'why the fallback exists')
    n4 = outcome(q2['y'] + 2, 'answer', ['That one is the answer —', 'the brief is built for them'], 'primary')
    for n in side:
        out.append(node(n))
    out.append(arrow(MAIN_X + BOX_W, s1['y'] + s1['h'] / 2, SIDE_X - 4, n1['y'] + n1['h'] / 2))
    out.append(arrow(MAIN_X + BOX_W, q1['y'] + q1['h'] / 2, SIDE_X - 4, n2['y'] + n2['h'] / 2, 'yes'))
    out.append(arrow(MAIN_X + BOX_W, s2['y'] + s2['h'] / 2, SIDE_X - 4, n3['y'] + n3['h'] / 2, '', dashed=True))
    out.append(arrow(MAIN_X + BOX_W, q2['y'] + q2['h'] / 2, SIDE_X - 4, n4['y'] + n4['h'] / 2, 'yes'))
    out.append(f'<text x="{MAIN_X + BOX_W/2 - 8}" y="{q1["y"] + q1["h"] + 19}" text-anchor="end" class="lbl">no</text>')
    out.append(f'<text x="{MAIN_X + BOX_W/2 - 8}" y="{q2["y"] + q2["h"] + 19}" text-anchor="end" class="lbl">no</text>')

    # the failure lane, on the left
    fl_title = ['Everyone is shown as an option,', 'with name · specialty · address']
    fl_tech = 'the rep picks whose brief to read'
    fl = {'x': MAIN_X, 'y': q2['y'] + q2['h'] + 34, 'w': BOX_W, 'h': box_height(fl_title, fl_tech, 52),
          'kind': 'answer', 'title': fl_title, 'tech': fl_tech}
    out.append(node(fl))
    out.append(arrow(MAIN_X + BOX_W / 2, q2['y'] + q2['h'], MAIN_X + BOX_W / 2, fl['y'] - 4))

    warn_title = ['A website that cannot be', 'reached is "not asked" —', 'never "nobody found"']
    warn = {'x': SIDE_X, 'y': fl['y'] - 10, 'w': SIDE_W, 'h': box_height(warn_title, 'health ledger + Retry'),
            'kind': 'stop', 'title': warn_title, 'tech': 'health ledger + Retry'}
    out.append(node(warn))
    return panel('2 · Outside our database — the two public websites',
                 'Billing data first, the registry second; both are plain JSON APIs, no scraping',
                 fl['y'] + fl['h'] + 22, '\n'.join(out))


# ── Panel 3: doctor? → brief → delivery ─────────────────────────────────────
def panel_three():
    rows, out, y = [], [], 14
    def main(kind, title, tech=None, num=None, h=None):
        nonlocal y
        h = h if h else box_height(title, tech, 52)
        n = {'x': MAIN_X, 'y': y, 'w': BOX_W, 'h': h, 'kind': kind, 'title': title, 'tech': tech, 'num': num}
        rows.append(n); y += h + GAP
        return n

    q = main('ask', ['Is this person a doctor?', 'Decided on the code, not the words'],
             'NUCC grouping 20 / 21, dentist 1223…', num=17)
    b = main('step', ['Build the brief once, from both websites', 'identity from the registry, gaps and', 'billing volumes from CMS'],
             'profile.js + outsideBriefHtml', num=18)
    c = main('step', ['Do the two websites agree on the', 'surname and the place?'], 'agreement.confirmed → +10% and a line saying so', num=19)
    d = main('step', 'Send the very same answer to three places', 'one resolve, so they cannot disagree', num=20)
    for n in rows:
        out.append(node(n))
    for p, qq in zip(rows, rows[1:]):
        out.append(arrow(MAIN_X + BOX_W / 2, p['y'] + p['h'], MAIN_X + BOX_W / 2, qq['y'] - 4))

    no_title = ['No brief. Say plainly what', 'the registry calls them', '(nurse, student, pharmacist)']
    no = {'x': SIDE_X, 'y': q['y'] - 8, 'w': SIDE_W, 'h': box_height(no_title, 'status: not_doctor'),
          'kind': 'stop', 'title': no_title, 'tech': 'status: not_doctor'}
    out.append(node(no))
    out.append(arrow(MAIN_X + BOX_W, q['y'] + q['h'] / 2, SIDE_X - 4, no['y'] + no['h'] / 2, 'no'))
    unk_title = ['Cannot place them either way?', 'The brief is still shown']
    unk = {'x': SIDE_X, 'y': b['y'] + 6, 'w': SIDE_W, 'h': box_height(unk_title, 'kind: unknown never suppresses'),
           'kind': 'step', 'title': unk_title, 'tech': 'kind: unknown never suppresses'}
    out.append(node(unk))
    out.append(arrow(MAIN_X + BOX_W, b['y'] + b['h'] / 2, SIDE_X - 4, unk['y'] + unk['h'] / 2, '', dashed=True))
    out.append(f'<text x="{MAIN_X + BOX_W/2 - 8}" y="{q["y"] + q["h"] + 19}" text-anchor="end" class="lbl">yes</text>')

    # three delivery boxes
    dy = d['y'] + d['h'] + 40
    labels = [
        (['In the app', 'panel'], 'the meeting card opens'),
        (['On the meeting', 'itself'], 'brief written into the body'),
        (['By email before', 'the meeting'], 'reminder engine'),
    ]
    w3 = (W - 2 * MAIN_X - 2 * 18) / 3
    for i, (t, tech) in enumerate(labels):
        x = MAIN_X + i * (w3 + 18)
        out.append(node({'x': x, 'y': dy, 'w': w3, 'h': box_height(t, tech, 58), 'kind': 'answer', 'title': t, 'tech': tech}))
        out.append(arrow(MAIN_X + BOX_W / 2, d['y'] + d['h'], x + w3 / 2, dy - 4))
    last = {'x': MAIN_X, 'y': dy + 58 + 30, 'w': W - 2 * MAIN_X, 'h': 54, 'kind': 'step',
            'title': ['Remember the decision, and do it once per meeting', '— and once more if the rep edits the title'],
            'tech': 'recordDecision + dedupe key on the meeting text'}
    out.append(node(last))
    out.append(arrow(W / 2, dy + 58, W / 2, last['y'] - 4))
    return panel('3 · Is it a doctor? → the brief → where it goes',
                 'A brief is produced for physicians, dentists and podiatrists; everybody else is named, not briefed',
                 last['y'] + last['h'] + 22, '\n'.join(out))


HEAD = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How the Agent Finds the Physician</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
  :root {
    --ink: #12242c; --ink-2: #3c5560; --muted: #64808a;
    --paper: #f4f7f7; --surface: #ffffff; --line: #d5e0e2; --line-soft: #e7eeef;
    --accent: #0a6273; --accent-soft: #e6f1f3; --code-bg: #eef3f4;
    --pass: #14663a; --stop: #9b1c39; --offer: #8a5a00;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font: 400 15px/1.6 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 54rem; margin: 0 auto; padding: 2.4rem 1.5rem 3rem; }
  h1 { font: 600 30px/1.2 "IBM Plex Serif", Georgia, serif; margin: 0 0 .4rem; letter-spacing: -0.01em; }
  .sub { color: var(--ink-2); max-width: 34rem; margin: 0 0 .5rem; }
  .meta { color: var(--muted); font: 400 12.5px/1.5 "IBM Plex Mono", ui-monospace, monospace; margin: 0 0 2rem; }
  h2 { font: 600 19px/1.3 "IBM Plex Serif", Georgia, serif; margin: 2.4rem 0 .8rem; }
  p { max-width: 34rem; }
  code, .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: .88em; }
  code { background: var(--code-bg); padding: .1em .34em; border-radius: 3px; }

  /* ── the panels ── */
  .panel { margin: 0 0 1.6rem; padding: 1rem 1.1rem 1.2rem; background: var(--surface);
           border: 1px solid var(--line); border-radius: 12px; break-inside: avoid; page-break-inside: avoid; }
  figcaption { margin: 0 0 .7rem; }
  .pt { display: block; font: 600 16px/1.3 "IBM Plex Sans", sans-serif; color: var(--accent); }
  .pk { display: block; font-size: 13px; color: var(--muted); margin-top: 2px; }
  svg { display: block; overflow: visible; }
  svg .t { font: 600 12.2px "IBM Plex Sans", sans-serif; }
  svg .tech { font: 400 10.4px "IBM Plex Mono", monospace; fill: #6d8892; }
  svg .num { font: 600 10.5px "IBM Plex Mono", monospace; fill: #fff; }
  svg .lbl { font: 600 10.5px "IBM Plex Sans", sans-serif; fill: #4a6a75; }
  svg .hand { font: 500 11.5px "IBM Plex Sans", sans-serif; fill: #64808a; }
  svg .edge { stroke: #5d7b85; stroke-width: 1.4; fill: none; }

  /* ── reference tables ── */
  table { width: 100%; border-collapse: collapse; margin: .6rem 0 1.4rem; font-size: 13.4px; break-inside: avoid; }
  th, td { text-align: left; padding: .42rem .6rem; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  th { font: 600 11.5px/1.3 "IBM Plex Sans", sans-serif; text-transform: uppercase; letter-spacing: .05em;
       color: var(--muted); border-bottom: 1px solid var(--line); }
  td.mono, th.mono { font-family: "IBM Plex Mono", monospace; font-size: 12.2px; }
  td.num { text-align: right; white-space: nowrap; font-family: "IBM Plex Mono", monospace; }
  pre { background: var(--code-bg); border: 1px solid var(--line-soft); border-radius: 8px;
        padding: .8rem .9rem; overflow-x: auto; font-size: 12.2px; line-height: 1.55; break-inside: avoid; }
  .note { border-left: 3px solid var(--accent); background: var(--accent-soft); padding: .7rem .9rem;
          border-radius: 0 8px 8px 0; margin: 1rem 0; max-width: 34rem; font-size: 13.6px; }
  footer { margin-top: 2.4rem; padding-top: 1rem; border-top: 1px solid var(--line);
           color: var(--muted); font-size: 12.5px; }

  @page { size: A4; margin: 13mm 12mm; }
  @media print {
    body { background: #fff; }
    .wrap { max-width: none; padding: 0; }
    .panel { border-color: #c9d7da; box-shadow: none; }
    h2 { break-after: avoid; }
  }
</style>
</head>
<body>
<div class="wrap">
<h1>How the agent finds the physician</h1>
<p class="sub">The whole path from a meeting in the calendar to a pre-meeting brief — in plain
English, with the name used in the code in brackets. Every step below is a real step in
<span class="mono">src/meeting-match.js</span>, <span class="mono">src/outside-sources/*</span> and
<span class="mono">src/enrichment/*</span>.</p>
<p class="meta">Outlook Calendar Intelligence · pre-meeting sales intelligence · 3 September 2026</p>
'''

TAIL_INTRO = '''
<h2>Where the data actually comes from</h2>
<p>Both websites are read through their own public JSON APIs. Nothing is scraped, and no key is
needed. What a person sees on the website is what the API returns.</p>
'''


def table(headers, rows, classes=None):
    classes = classes or [''] * len(headers)
    head = ''.join(f'<th class="{c}">{esc(h)}</th>' for h, c in zip(headers, classes))
    body = ''
    for r in rows:
        cells = ''.join(f'<td class="{c}">{v}</td>' for v, c in zip(r, classes))
        body += f'<tr>{cells}</tr>'
    return f'<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>'


def build():
    parts = [HEAD, panel_one(), panel_two(), panel_three(), TAIL_INTRO]

    parts.append('<h3 style="font:600 14px/1.3 \'IBM Plex Sans\';margin:1.4rem 0 .3rem">1 · NPPES NPI Registry — turns a name into an NPI</h3>')
    parts.append('''<pre>GET https://npiregistry.cms.hhs.gov/api/
      ?version=2.1
      &amp;enumeration_type=NPI-1        <span style="color:#64808a"># a person; NPI-2 would be a hospital</span>
      &amp;last_name=ABERNATHY&amp;first_name=JOHN
      &amp;state=FL&amp;limit=20</pre>''')
    parts.append(table(
        ['What we take from it', 'Why it matters'],
        [('NPI, name, credential', 'the NPI is this app’s primary key everywhere'),
         ('Primary taxonomy <span class="mono">+ its NUCC code</span>', 'the code decides whether a brief is produced at all'),
         ('Practice address, city, state, ZIP, phone', 'what a rep needs to recognise the right person'),
         ('Licence number and state, NPI date, status', 'shown as <em>extra</em> — our own database has no column for these'),
         ('<strong>No email, ever</strong>', 'the registry has no email field, so an email is never guessed from it')],
    ))
    parts.append('''<div class="note"><strong>Three real quirks, handled in the code.</strong>
A one-letter wildcard is rejected, so a single initial is never sent — it is kept as a ranking hint.
A bad query comes back as <code>HTTP 200</code> with an <code>Errors</code> array, not as an error.
And the same query can return 0 results once and 1 a moment later, so one extra attempt is made
(<span class="mono">retryIfEmpty</span>).</div>''')

    parts.append('<h3 style="font:600 14px/1.3 \'IBM Plex Sans\';margin:1.6rem 0 .3rem">2 · CMS Medicare Physician &amp; Other Practitioners — by provider and service</h3>')
    parts.append('''<pre><span style="color:#64808a"># step 1 — which dataset is this data year? (ids change when CMS republishes)</span>
GET https://data.cms.gov/data.json          →  2024 → 92396110-2aed-4d63-a6a2-5d6207d46a29

<span style="color:#64808a"># step 2 — ask the surname (and the first name as a keyword)</span>
GET https://data.cms.gov/data-api/v1/dataset/&lt;uuid&gt;/data
      ?filter[Rndrng_Prvdr_Last_Org_Name]=Abernathy
      &amp;keyword=John
      &amp;column=Rndrng_NPI,Rndrng_Prvdr_First_Name,Rndrng_Prvdr_Type,…
      &amp;size=500

<span style="color:#64808a"># step 3 — later, for the chosen person: their billing lines, year by year</span>
GET …/data?filter[Rndrng_NPI]=1265847438&amp;size=500</pre>''')
    parts.append(table(
        ['Measured behaviour', 'Consequence in the code'],
        [('Surname filter: 327 rows in ~0.5 s', 'one row per <em>billing code</em>, so rows are grouped by NPI — 327 rows = 46 people'),
         ('Surname filter + <span class="mono">keyword</span>: precise and fast', 'the first name is a keyword, never a second filter'),
         ('<strong>Two <span class="mono">filter[…]</span> params: the request hangs</strong>', 'never send two — this is a hard rule'),
         ('<span class="mono">Rndrng_Prvdr_Ent_Cd</span> = I / O', 'organisations are dropped — a clinic is not who the rep is meeting'),
         ('Provider type in CMS’s own words, no NUCC code', '"Family Practice", "Podiatry" — read by word, and the registry’s code wins when both exist')],
    ))

    parts.append('<h2>How a person is scored against the meeting</h2>')
    parts.append('<p>Every candidate starts at 30 for being in a registry at all. Then the meeting’s own words are checked <em>for</em> the candidate’s values — asking "does this meeting mention CHICAGO?" rather than trying to guess a city out of free text.</p>')
    parts.append(table(
        ['Evidence from the meeting', 'Points'],
        [('In a registry at all (the starting point)', '+30'),
         ('Last name matches', '+25'),
         ('First name matches exactly', '+30'),
         ('First name partial / initial only', '+15 / +10'),
         ('First name is a different name', '–25'),
         ('State matches / city matches', '+15 / +15'),
         ('The meeting mentions this specialty (taxonomy)', '+20'),
         ('Specialty matches exactly / differs', '+25 / –15'),
         ('ZIP, street address or phone matches', '+20 each'),
         ('Only candidate anybody returned', '+10'),
         ('Both websites confirm the same identity', '+10')],
        classes=['', 'num'],
    ))
    parts.append('''<div class="note"><strong>Two thresholds, and they are the rep’s own rule.</strong>
<strong>70%</strong> and at least 10 points clear of the next candidate → the data is put in front of
the rep as the answer. Anything less → everybody is listed as an option, with name, specialty and
practice address, and the rep picks. A shortlist is never hidden just because nothing cleared the
bar: "here are the five people called Ajjarapu" is an answer a rep can act on.</div>''')

    parts.append('<h2>The same flow, on three real meetings</h2>')
    parts.append(table(
        ['The meeting says', 'Who is asked', 'What the rep sees'],
        [('<span class="mono">Meeting with Dr JOHN ABERNATHY</span>',
          'CMS only — it matched the full name, so the registry is not asked',
          'One person: NPI 1265847438, Internal Medicine, St Petersburg FL → the brief opens'),
         ('<span class="mono">Meeting with Dr Abernathy</span>',
          'CMS (46 people) and then the registry — a surname is never an exact match',
          'A list, each row with specialty and address, all at 55% — the rep picks; a nurse practitioner and an optometrist are named but not offered'),
         ('<span class="mono">Meeting with Dr Avanthi Ajjarapu</span>',
          'CMS has nobody (she bills no Medicare) → the registry answers exactly',
          'One person: Obstetrics &amp; Gynecology, Fort Worth TX → the brief opens'),
         ('<span class="mono">Meeting with Best friend</span>',
          'Nobody. The meeting never says "Dr"',
          'Nothing at all — a plain calendar row that does not even open')],
    ))

    parts.append('''<footer>Generated by <span class="mono">scripts/agent-flow-doc.py</span>. The behaviour drawn here is
covered by the test suite (<span class="mono">npm test</span>, 169 tests) and was verified against the live
APIs on 2 September 2026. Numbers in circles match the step numbers used in the walk-through.</footer>
</div>
</body>
</html>''')
    return '\n'.join(parts)


if __name__ == '__main__':
    out = pathlib.Path('docs/agent-name-flow.html')
    out.write_text(build())
    print(f'wrote {out} ({out.stat().st_size} bytes)')

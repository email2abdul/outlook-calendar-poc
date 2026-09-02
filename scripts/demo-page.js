'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const physicians = require('../src/physicians');
const meetingMatch = require('../src/meeting-match');
const sources = require('../src/outside-sources');
const score = require('../src/outside-sources/score');
const assembleProfile = require('../src/outside-sources/profile');
const resolveOutside = require('../src/outside-sources/resolve');
const graph = require('../src/graph');
const analytics = require('../src/analytics');
const contactsStore = require('../src/contacts-store');
const verify = require('../src/enrichment/verify');
const meetingContext = require('../src/enrichment/context');

/**
 * Build a browsable copy of the real UI, with real answers baked in.
 *
 *   npm run demo:page      → data/demo/index.html
 *
 * Seeing this flow in a browser otherwise needs a Microsoft sign-in, and the
 * one thing nobody can hand over is somebody else's calendar. So this runs the
 * REAL pipeline — the same ladder, the same registries, the same scorer, the
 * same brief renderer — over a set of example meetings, then writes the actual
 * API payloads next to a copy of public/ and a fetch shim that serves them.
 *
 * The result is the shipped UI, on real NPPES and CMS data, opened from a file.
 * Nothing about the interface is mocked; only Graph and the session are.
 */

const OUT = path.join(__dirname, '..', 'data', 'demo');
const REP = { name: 'Sales Rep', email: 'rep@lumendi-example.com' };

/** The cases, in the order a rep would meet them. */
const MEETINGS = [
  { title: 'Pipeline review', note: 'no attendee in BIS, no "Dr" — a normal meeting' },
  {
    title: 'Meeting with Best friend',
    attendee: { name: '', email: 'email2@gmail.com' },
    note: 'a normal meeting with an attendee address — nothing is looked up, nothing is shown',
  },
  { title: 'Quarterly review', email: null, useBisEmail: true, note: 'attendee email matches BIS exactly' },
  { title: 'Case obs with Dr Aaron Baas', note: 'full name, no email, in BIS' },
  { title: 'Meeting with Dr Khan', note: 'half a name — 62 in BIS' },
  { title: 'Endoscopy sync', attendee: { name: 'Dr Nicholas Shaheen', email: 'nshaheen@med.unc.edu' }, city: 'CHAPEL HILL', state: 'NC', note: 'email NOT in BIS → jumps to the name' },
  { title: 'Meeting with Dr Aagaard', note: 'last name only — nine found, none over 60%' },
  { title: 'Meeting with Dr Aagaard (Dentist)', note: 'the taxonomy the meeting mentions decides it' },
  { title: 'Meeting with Dr Katie, Counselor at 200 CASENTINI ST SALINAS CA', note: 'first name + taxonomy + address' },
  { title: 'Review NPI 1003000126', note: 'an NPI on the meeting wins outright' },
  { title: 'Meeting with Dr Taylor Aagaard', note: 'the registry answers — and says this is not a physician' },
  {
    title: 'Meeting with Dr ABESELOM',
    body: 'Primary Taxonomy - Internal Medicine from CHICAGO',
    note: 'a first name only — the taxonomy and city in the description pick the one physician',
  },
];

const at = (h) => {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.toISOString().replace(/\.\d+Z$/, '');
};

const briefs = {}; // npi → BIS brief html
const notes = {}; // npi → []
const outside = {}; // eventId → /api/meetings/outside payload
const chosen = {}; // npi → { html, physician }

async function bisBrief(npi) {
  if (briefs[npi]) return;
  const p = physicians.getByNpi(npi);
  if (!p) return;
  const [a, contact, verification] = await Promise.all([
    analytics.getLabelledAnalytics(npi),
    contactsStore.getContact(npi),
    verify.verifyPhysician(p),
  ]);
  briefs[npi] = graph.physicianBriefHtml({ physician: p, analytics: a, contact, verification });
  notes[npi] = [];
}

/**
 * The same answer the API gives, from the same module — so the demo cannot
 * drift from the app (four copies of this question are what let the panel and
 * the ingest tick disagree). The only extra work here is pre-rendering the
 * brief for each candidate a rep could click, since a file:// page cannot ask
 * the registries when the click happens.
 */
async function outsideFor(ev) {
  const answer = await resolveOutside(ev, { selfEmail: REP.email });

  for (const g of answer.groups || []) {
    for (const c of (g.candidates || []).slice(0, 3)) {
      if (chosen[c.npi] || c.inBis) continue;
      const profile = await assembleProfile(c.npi, c.externalSource);
      if (!profile) continue;
      chosen[c.npi] =
        profile.providerKind.kind === 'not_doctor'
          ? {
              html: graph.notDoctorHtml({
                name: profile.record.name, npi: c.npi, kind: profile.providerKind,
                sourceName: profile.sourceName, sourceUrl: profile.sourceUrl,
              }),
              physician: { npi: c.npi, name: profile.record.name, specialty: profile.providerKind.label },
              notDoctor: true,
            }
          : {
              html: graph.outsideBriefHtml({
                record: profile.record, extra: profile.extra, cms: profile.cms,
                agreement: profile.agreement, confidence: c.confidence, matchReasons: c.matchReasons,
                nameIncomplete: answer.nameIncomplete
                  ? { ...answer.nameIncomplete, total: g.total }
                  : null,
                sourceName: profile.sourceName, sourceUrl: profile.sourceUrl,
              }),
              physician: { npi: c.npi, name: profile.record.name, specialty: profile.record.specialty },
            };
    }
  }

  const { primary, profile, match, ...payload } = answer;
  return { ...payload, eventId: ev.id };
}

async function main() {
  await physicians.ready;

  // An attendee whose address the master really does hold.
  const withEmail = physicians.getAllPhysicians().find((p) => p.email);

  const events = [];
  let hour = 8;
  for (const m of MEETINGS) {
    const attendee = m.useBisEmail
      ? { name: withEmail.name, email: withEmail.email }
      : m.attendee || null;

    const ev = {
      id: `DEMO-${events.length + 1}`,
      title: m.title,
      start: at(hour),
      end: at(hour + 1),
      timeZone: 'UTC',
      isAllDay: false,
      type: 'singleInstance',
      seriesMasterId: null,
      location: null,
      description: m.body || null,
      organizer: REP,
      attendees: attendee ? [{ ...attendee, type: 'required', response: 'none' }] : [],
      onlineMeetingUrl: null,
      webLink: null,
      demoNote: m.note,
      demoCity: m.city || null,
      demoState: m.state || null,
    };
    hour += 1;

    // Exactly what the day route does.
    const enriched = ev.attendees.map((a) => {
      const excluded = meetingContext.isOrganizer(ev, a.email, REP.email);
      const physician = excluded ? null : physicians.getByEmail(a.email);
      return { ...a, isOrganizer: excluded, physician, lastNote: null };
    });
    const emailNpis = new Set(enriched.map((a) => a.physician?.npi).filter(Boolean));

    let match = null;
    if (!emailNpis.size) match = meetingMatch.matchMeeting(ev, { selfEmail: REP.email });

    for (const npi of emailNpis) await bisBrief(npi);
    for (const p of match?.physicians || []) await bisBrief(p.npi);
    for (const g of match?.groups || []) for (const c of g.candidates) await bisBrief(c.npi);

    if (match && (match.status === 'needs_external' || match.status === 'partial_name')) {
      process.stdout.write(`  … asking the registries for "${ev.title}"\n`);
      outside[ev.id] = await outsideFor(ev);
    }

    events.push({
      ...ev, attendees: enriched, titleMatches: [], titlePeople: [], entityAnalysis: null, match,
    });
    console.log(`  ${ev.id}  ${match ? match.status.padEnd(14) : 'email-matched '} ${ev.title}`);
  }

  // ── write the page ────────────────────────────────────────────────────────
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'public'), OUT, { recursive: true });

  const day = { date: new Date().toISOString().slice(0, 10), timeZone: 'UTC', events };
  fs.writeFileSync(
    path.join(OUT, 'demo-data.js'),
    `// Generated by scripts/demo-page.js — real answers from the real pipeline.\n` +
      `window.DEMO = ${JSON.stringify({ day, briefs, notes, outside, chosen }, null, 1)};\n` +
      fs.readFileSync(path.join(__dirname, 'demo-shim.js'), 'utf8')
  );

  const indexPath = path.join(OUT, 'index.html');
  fs.writeFileSync(
    indexPath,
    fs
      .readFileSync(indexPath, 'utf8')
      .replace('<script src="/app.js"></script>', '<script src="demo-data.js"></script>\n    <script src="app.js"></script>')
      .replace('href="/styles.css"', 'href="styles.css"')
  );

  console.log(`\nOpen it:  file://${indexPath}`);
  console.log(`Regenerate with:  npm run demo:page`);
}

main().then(() => process.exit(0), (err) => {
  console.error('demo:page failed:', err);
  process.exit(1);
});

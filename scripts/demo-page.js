'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const physicians = require('../src/physicians');
const meetingMatch = require('../src/meeting-match');
const sources = require('../src/outside-sources');
const score = require('../src/outside-sources/score');
const assembleProfile = require('../src/outside-sources/profile');
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
  { title: 'Quarterly review', email: null, useBisEmail: true, note: 'attendee email matches BIS exactly' },
  { title: 'Case obs with Dr Aaron Baas', note: 'full name, no email, in BIS' },
  { title: 'Meeting with Dr Khan', note: 'half a name — 62 in BIS' },
  { title: 'Endoscopy sync', attendee: { name: 'Dr Nicholas Shaheen', email: 'nshaheen@med.unc.edu' }, city: 'CHAPEL HILL', state: 'NC', note: 'email NOT in BIS → jumps to the name' },
  { title: 'Meeting with Dr Aagaard', note: 'last name only — nine found, none over 60%' },
  { title: 'Meeting with Dr Aagaard (Dentist)', note: 'the taxonomy the meeting mentions decides it' },
  { title: 'Meeting with Dr Katie, Counselor at 200 CASENTINI ST SALINAS CA', note: 'first name + taxonomy + address' },
  { title: 'Review NPI 1003000126', note: 'an NPI on the meeting wins outright' },
  { title: 'Meeting with Dr Taylor Aagaard', note: 'the registry answers — and says this is not a physician' },
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

/** The same assembly the endpoint does, plus the rendered notes. */
async function outsideFor(ev, match) {
  const hints = { city: ev.demoCity || null, state: ev.demoState || null };
  const text = [ev.title, ev.description].filter(Boolean).join(' · ');
  const groups = [];
  const failures = [];

  if (match.npi) {
    const profile = await assembleProfile(match.npi);
    failures.push(...(profile?.failures || []));
    if (profile) {
      const candidate = { ...profile.record, extra: profile.extra, confidence: 100, matchReasons: ['the NPI was written on the meeting itself'] };
      chosen[match.npi] = {
        html: graph.outsideBriefHtml({ record: profile.record, extra: profile.extra, cms: profile.cms, agreement: profile.agreement, confidence: 100, matchReasons: candidate.matchReasons, sourceName: profile.sourceName, sourceUrl: profile.sourceUrl }),
        physician: { npi: match.npi, name: profile.record.name, specialty: profile.record.specialty },
      };
      return {
        eventId: ev.id, status: match.status, searched: true, via: 'meeting-npi', npi: match.npi,
        reason: match.reason, names: [], nameIncomplete: null, confidence: 100, threshold: score.CONFIDENCE_SHOW,
        groups: [{ name: `NPI ${match.npi}`, source: 'meeting', total: 1, dropped: 0, candidates: [candidate], primaryNpi: match.npi }],
        brief: chosen[match.npi].html, failures,
        sources: sources.list().map((s) => ({ id: s.id, name: s.name, url: s.url })),
      };
    }
  }

  let brief = null;
  let confidence = null;
  let notDoctor = null;
  for (const name of match.unresolvedNames) {
    const { firstName, lastName } = meetingMatch.nameSearchKey(name, match.nameIncomplete);
    const found = await sources.searchByName({ firstName, lastName, ...hints }, { limit: 20 });
    failures.push(...found.failures);

    const ranked = score.rankCandidates(
      found.candidates.map((c) => {
        const bis = c.npi ? physicians.getByNpi(c.npi) : null;
        return bis ? { ...c, inBis: true } : c;
      }),
      { firstName, lastName, ...hints, text },
      { max: meetingMatch.MAX_CANDIDATES }
    );

    groups.push({
      name, source: match.nameIncomplete ? match.nameIncomplete.source : 'title',
      total: ranked.offered.length, dropped: ranked.dropped, cleared: ranked.cleared,
      ambiguous: ranked.ambiguous, primaryNpi: ranked.primary?.npi || null,
      partial: Boolean(match.nameIncomplete), candidates: ranked.offered,
      refused: (ranked.refused || []).map((c) => ({
        npi: c.npi, name: c.name, taxonomy: c.providerKind.label, reason: c.providerKind.reason,
      })),
    });

    // Nobody but non-doctors: that is the answer the panel shows.
    if (ranked.notDoctor && !ranked.offered.length) {
      const nd = ranked.notDoctor;
      notDoctor = {
        npi: nd.npi, name: nd.name, taxonomy: nd.providerKind.label,
        html: graph.notDoctorHtml({
          name: nd.name, npi: nd.npi, kind: nd.providerKind,
          sourceName: 'NPPES NPI Registry',
          sourceUrl: `https://npiregistry.cms.hhs.gov/provider-view/${nd.npi}`,
        }),
      };
    }

    // Pre-render the notes for everything a rep can click, so the demo page
    // behaves like the app rather than like a screenshot.
    for (const c of ranked.offered.slice(0, 3)) {
      if (chosen[c.npi] || c.inBis) continue;
      const profile = await assembleProfile(c.npi, c.externalSource);
      if (!profile) continue;
      chosen[c.npi] = {
        html: graph.outsideBriefHtml({
          record: profile.record, extra: profile.extra, cms: profile.cms, agreement: profile.agreement,
          confidence: c.confidence, matchReasons: c.matchReasons,
          nameIncomplete: match.nameIncomplete ? { ...match.nameIncomplete, total: ranked.ranked.length } : null,
          sourceName: profile.sourceName, sourceUrl: profile.sourceUrl,
        }),
        physician: { npi: c.npi, name: profile.record.name, specialty: profile.record.specialty },
      };
      if (ranked.primary?.npi === c.npi) {
        brief = chosen[c.npi].html;
        confidence = c.confidence;
      }
    }
  }

  return {
    eventId: ev.id, status: notDoctor ? 'not_doctor' : match.status, searched: true, reason: match.reason,
    names: match.unresolvedNames, nameIncomplete: match.nameIncomplete || null,
    hints, groups, brief, confidence, notDoctor, threshold: score.CONFIDENCE_SHOW, failures,
    sources: sources.list().map((s) => ({ id: s.id, name: s.name, url: s.url })),
  };
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
      description: null,
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
      outside[ev.id] = await outsideFor(ev, match);
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

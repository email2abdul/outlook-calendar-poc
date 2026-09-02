'use strict';

const physicians = require('../physicians');
const graph = require('../graph');
const meetingMatch = require('../meeting-match');
const meetingContext = require('../enrichment/context');
const outsideStore = require('../outside-physician-store');
const sources = require('./index');
const score = require('./score');
const assembleProfile = require('./profile');

/**
 * "Who is this meeting with, outside the master?" — answered once, for everyone.
 *
 * The same question was being asked in four places: the API the panel calls,
 * the ingest tick (which writes the brief into the meeting body), the CLI and
 * the demo generator. Four copies meant the tick could reach a different
 * conclusion from the panel for the same meeting — and it did: the panel showed
 * a 95% Chicago internist while the meeting body stayed empty, because only the
 * panel knew how to look.
 *
 * So this module does the whole of it: read the meeting, ask the registered
 * sources, score what comes back against what the meeting said, refuse anybody
 * who is not a doctor, and assemble the winner's profile. Callers decide what to
 * DO with the answer — render it, inject it, email it — never how to reach it.
 */

/**
 * @param {object} event                normalized event (src/graph.js)
 * @param {object} [opts]
 * @param {string} [opts.selfEmail]     the signed-in rep (never matched)
 * @param {object} [opts.hintOverrides] { city, state, taxonomy } from a caller
 * @returns {Promise<object>} the payload the panel renders, plus `primary` and
 *          `profile` for callers that act on the answer
 */
async function resolveMeetingOutside(event, { selfEmail = null, hintOverrides = {} } = {}) {
  const match = meetingMatch.matchMeeting(event, { selfEmail });
  const sourceList = sources.list().map((s) => ({ id: s.id, name: s.name, url: s.url }));

  const base = {
    eventId: event?.id || null,
    status: match.status,
    searched: false,
    reason: match.reason,
    names: match.unresolvedNames,
    nameIncomplete: match.nameIncomplete || null,
    groups: [],
    brief: null,
    confidence: null,
    threshold: score.CONFIDENCE_SHOW,
    // Which source answered the name — the sources are asked in order (CMS
    // billing data first, NPPES second) and the first real answer wins.
    answeredBy: null,
    notDoctor: null,
    failures: [],
    sources: sourceList,
    primary: null,
    profile: null,
    match,
  };

  // Only a meeting the master could not answer — nobody matched, or it gave
  // half a name — has anything to look up outside it.
  if (match.status !== 'needs_external' && match.status !== 'partial_name') return base;

  // What the meeting itself says about where and what. A labelled taxonomy
  // ("Primary Taxonomy - Internal Medicine") is read here too, and kept out of
  // the facility matching that would otherwise turn it into a place.
  let hints = {};
  try {
    hints = await meetingContext.hintsFromEvent(event, { selfEmail });
  } catch {
    /* context is a bonus, never a blocker */
  }
  const city = hintOverrides.city || hints.city || null;
  const state = hintOverrides.state || hints.state || null;
  const taxonomy = hintOverrides.taxonomy || hints.taxonomy || null;
  const text = [event.title, event.description, event.location].filter(Boolean).join(' · ');

  const failures = [];

  // ── An NPI written on the meeting: no name, no ambiguity ─────────────────
  if (match.npi) {
    const profile = await assembleProfile(match.npi);
    failures.push(...(profile?.failures || []));

    if (profile) {
      const bis = physicians.getByNpi(match.npi);

      // Even an NPI is proof of identity, not of a medical degree.
      if (!bis && profile.providerKind.kind === 'not_doctor') {
        return {
          ...base,
          status: 'not_doctor',
          searched: true,
          via: 'meeting-npi',
          npi: match.npi,
          reason: profile.providerKind.reason,
          failures,
          notDoctor: {
            npi: match.npi,
            name: profile.record.name || null,
            taxonomy: profile.providerKind.label,
            html: graph.notDoctorHtml({
              name: profile.record.name,
              npi: match.npi,
              kind: profile.providerKind,
              sourceName: profile.sourceName,
              sourceUrl: profile.sourceUrl,
            }),
          },
        };
      }

      const candidate = bis
        ? { ...outsideStore.mirrorFromPhysician(bis), inBis: true, externalSource: 'nppes' }
        : {
            ...profile.record,
            extra: profile.extra,
            externalSource: profile.record.externalSource || 'nppes',
            confidence: 100,
            matchReasons: ['the NPI was written on the meeting itself'],
          };

      return {
        ...base,
        status: match.status,
        searched: true,
        via: 'meeting-npi',
        npi: match.npi,
        confidence: 100,
        failures,
        groups: [
          { name: `NPI ${match.npi}`, source: 'meeting', total: 1, dropped: 0, refused: [], candidates: [candidate], primaryNpi: match.npi },
        ],
        brief: bis
          ? null
          : graph.outsideBriefHtml({
              record: profile.record,
              extra: profile.extra,
              cms: profile.cms,
              agreement: profile.agreement,
              confidence: 100,
              matchReasons: ['the NPI was written on the meeting itself'],
              sourceName: profile.sourceName,
              sourceUrl: profile.sourceUrl,
            }),
        primary: bis ? null : candidate,
        profile: bis ? null : profile,
      };
    }
  }

  // ── By name ──────────────────────────────────────────────────────────────
  const groups = [];
  for (const name of match.unresolvedNames) {
    // A half name is searched on the field it belongs to, and on BOTH when
    // nobody can place it — surname first, since that is what the registry
    // indexes. Fetch wide (20) and trim after scoring: asking for five meant
    // the candidate the meeting actually described could be absent from the set.
    let firstName = '';
    let lastName = '';
    let raw = [];
    let answeredBy = null;
    for (const attempt of meetingMatch.nameSearchKeys(name, match.nameIncomplete)) {
      const found = await sources.searchByName(
        { ...attempt, state: state || undefined, city: city || undefined },
        { limit: 20 }
      );
      failures.push(...found.failures);
      if (found.candidates.length) {
        ({ firstName, lastName } = attempt);
        raw = found.candidates;
        // Which source actually answered — the sources are asked in order and
        // the first real answer wins, so naming "NPPES, CMS" both would be
        // wrong in front of a rep who is looking at one of them.
        answeredBy = found.answeredBy || null;
        break;
      }
    }

    const withBis = raw.map((c) => {
      // Free, and the most valuable check there is: does the master already
      // hold this NPI under a different name or address?
      const bis = c.npi ? physicians.getByNpi(c.npi) : null;
      return bis ? { ...c, ...outsideStore.mirrorFromPhysician(bis), inBis: true, extra: c.extra } : { ...c, inBis: false };
    });

    const ranked = score.rankCandidates(
      withBis,
      { firstName, lastName, city, state, taxonomy, text },
      { max: meetingMatch.MAX_CANDIDATES }
    );

    groups.push({
      name,
      source: match.nameIncomplete ? match.nameIncomplete.source : 'title',
      answeredBy,
      total: ranked.offered.length,
      candidates: ranked.offered,
      dropped: ranked.dropped,
      cleared: ranked.cleared,
      ambiguous: ranked.ambiguous,
      primaryNpi: ranked.primary?.npi || null,
      partial: Boolean(match.nameIncomplete),
      // Named, not hidden: silence sends a rep hunting for a different spelling.
      refused: (ranked.refused || []).map((c) => ({
        npi: c.npi,
        name: c.name,
        taxonomy: c.providerKind.label,
        reason: c.providerKind.reason,
      })),
      notDoctor: ranked.notDoctor || null,
    });
  }

  // Everything the registry returned is somebody a rep does not brief: that IS
  // the answer, stated rather than left as an empty panel.
  //
  // `notDoctor` is the test, not "no candidates were offered": those are
  // different things, and reading one for the other is what told a rep that
  // "Dr Ajjarapu" is a student. The registry had returned three physicians —
  // an OB/GYN, a family doctor and a hospitalist — but a surname alone scores
  // them all at 55%, so none was offered, and the panel then reported the
  // student it had refused as the answer. Only a group whose every match is a
  // non-doctor says "not a physician".
  const allRefused = groups.length && groups.every((g) => g.notDoctor && !g.candidates.length);
  if (allRefused) {
    // The scored candidate itself, so the taxonomy and the reason are the ones
    // the classifier actually gave (the group's `refused` list is a summary).
    const worst = groups[0].notDoctor;
    const kind = worst.providerKind;
    return {
      ...base,
      status: 'not_doctor',
      searched: true,
      reason: kind.reason,
      groups,
      failures,
      notDoctor: {
        npi: worst.npi,
        name: worst.name,
        taxonomy: kind.label,
        html: graph.notDoctorHtml({
          name: worst.name,
          npi: worst.npi,
          kind,
          sourceName: 'NPPES NPI Registry',
          sourceUrl: worst.npi ? `https://npiregistry.cms.hhs.gov/provider-view/${worst.npi}` : null,
        }),
      },
    };
  }

  // One candidate cleared the bar and stood clear of the rest: assemble their
  // profile now, so the answer is complete wherever it is used — the panel, the
  // meeting body, the reminder.
  const chosen = groups.find((g) => g.primaryNpi);
  let brief = null;
  let confidence = null;
  let primary = null;
  let profile = null;

  if (chosen) {
    const best = chosen.candidates.find((c) => c.npi === chosen.primaryNpi);
    confidence = best.confidence;
    primary = best;

    if (!best.inBis) {
      profile = await assembleProfile(best.npi, best.externalSource);
      failures.push(...(profile?.failures || []));
      if (profile) {
        // Two sources agreeing on an identity is worth saying, and worth points.
        const rescored = score.scoreCandidate(
          best,
          { firstName: best.firstName, lastName: best.lastName, city: best.city, state: best.state },
          { total: chosen.total, confirmed: profile.agreement.confirmed }
        );
        confidence = Math.max(best.confidence, rescored.confidence);

        brief = graph.outsideBriefHtml({
          record: profile.record,
          extra: profile.extra,
          cms: profile.cms,
          agreement: profile.agreement,
          confidence,
          matchReasons: best.matchReasons,
          nameIncomplete: match.nameIncomplete ? { ...match.nameIncomplete, total: chosen.total } : null,
          sourceName: profile.sourceName,
          sourceUrl: profile.sourceUrl,
        });

        const at = chosen.candidates.findIndex((c) => c.npi === best.npi);
        primary = { ...best, ...profile.record, extra: profile.extra, confidence };
        chosen.candidates[at] = primary;
      }
    }
  }

  return {
    ...base,
    searched: true,
    hints: { city, state, taxonomy, facility: hints.facilityName || null },
    answeredBy: groups.find((g) => g.answeredBy)?.answeredBy || null,
    groups,
    brief,
    confidence,
    failures,
    primary,
    profile,
  };
}

module.exports = resolveMeetingOutside;
module.exports.resolveMeetingOutside = resolveMeetingOutside;

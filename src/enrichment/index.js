'use strict';

const physicians = require('../physicians');
const territory = require('../territory');
const states = require('./states');
const rematch = require('./rematch');
const nppes = require('./sources/nppes');
const cms = require('./sources/cms-provider');
const webIdentity = require('./sources/web-identity');
const openPayments = require('./sources/open-payments');
const literature = require('./sources/literature');
const cache = require('./cache');
const health = require('./health');
const { createProfile, fromBis, fromRegistry, fromWeb, inferred } = require('./provenance');

/**
 * Enrichment orchestrator.
 *
 * Runs the DB-first cascade from docs/external-enrichment-agent.md §4:
 *
 *   T0    BIS DB          email → physician?                 free, 0 ms
 *   T0.5  Domain index    @unch.unc.edu → HSOP105211          free, 0 ms
 *   T1    Web identity    email → name, title, institution    PAID (~$0.15)
 *   T2    NPPES           name + state → NPI, specialty, …    free
 *   T3    RE-MATCH        NPI → bis_physicians; facility →    free
 *                         bis_facilities (city/state gated)
 *   T4    CMS + extras    affiliation → CCN → hospital; industry     free
 *                         payments, publications, trials
 *
 * T1 runs only when it has something to buy: the caller gave no name, the
 * mailbox is not organisational, and ANTHROPIC_API_KEY is set. Otherwise the
 * name comes from the caller or from the email local-part
 * (rematch.nameHintsFromEmail), and the whole cascade stays free.
 *
 * The ORGANIZER is never enriched — that exclusion lives in context.js, which
 * decides who on a meeting is a candidate in the first place.
 *
 * Every field returned carries its source (see provenance.js) and nothing here
 * writes to bis_* — the master stays read-only.
 */

const MAX_NAME_CANDIDATES = 3;

/**
 * Confidence bands (open decision #1 in the design doc).
 *
 * A low-confidence guess must never be presented as the answer — the enrichment
 * that returned "Evelyn Decker, Counselor, Monterey CA" for nshaheen@med.unc.edu
 * during testing was worse than returning nothing. Below ACCEPT the best hit is
 * still returned, but as a candidate to confirm, not as a resolved identity.
 */
const CONFIDENCE_ACCEPT = 70; // show as resolved
const CONFIDENCE_SUGGEST = 40; // show as "possible match — confirm"

/** Split a free-text name into first/last. */
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: '', lastName: parts[0] || '' };
  // Drop credentials the caller may have pasted in ("Nicholas Shaheen, MD").
  const clean = parts.filter((p) => !/^(md|do|mbbs|phd|mph|facp|facg|fasge|jr|sr|ii|iii)[.,]?$/i.test(p));
  const use = clean.length >= 2 ? clean : parts;
  return {
    firstName: use[0].replace(/[.,]/g, ''),
    lastName: use[use.length - 1].replace(/[.,]/g, ''),
  };
}

/**
 * Rank NPPES hits against everything else we know. Returns the best hit plus a
 * 0-100 confidence — the number the UI uses to decide between "here they are"
 * and "possible matches, please confirm".
 */
function pickBestProvider(results, hints) {
  if (!results.length) return null;

  // With an initial-only hint ("nshaheen" → "n"), being the ONLY surname match
  // whose first name starts with that letter is a genuinely strong signal —
  // much stronger than sharing an initial with four other people.
  const initial = (hints.firstName || '').toLowerCase();
  const initialMatches =
    initial.length === 1
      ? results.filter((r) => (r.firstName || '').toLowerCase().startsWith(initial)).length
      : 0;

  const scored = results.map((r) => {
    let score = 30; // a registry hit at all
    const reasons = [];

    const wantFirst = (hints.firstName || '').toLowerCase();
    const gotFirst = (r.firstName || '').toLowerCase();
    if (wantFirst.length > 1 && gotFirst) {
      if (gotFirst === wantFirst) {
        score += 40;
        reasons.push('first name exact');
      } else if (gotFirst.startsWith(wantFirst) || wantFirst.startsWith(gotFirst)) {
        score += 20;
        reasons.push('first name prefix');
      } else {
        score -= 25;
        reasons.push('first name differs');
      }
    } else if (wantFirst.length === 1 && gotFirst) {
      if (!gotFirst.startsWith(wantFirst)) {
        score -= 10;
        reasons.push('first initial differs');
      } else if (initialMatches === 1) {
        score += 25;
        reasons.push('unique first-initial match');
      } else {
        score += 12;
        reasons.push('first initial');
      }
    }

    if (hints.state && states.sameState(hints.state, r.state)) {
      score += 25;
      reasons.push('state match');
    }
    if (hints.city && r.city && hints.city.toLowerCase() === r.city.toLowerCase()) {
      score += 20;
      reasons.push('city match');
    }
    if (r.status === 'A') score += 5;
    if (results.length === 1) {
      score += 15;
      reasons.push('only registry hit');
    }

    return { provider: r, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1];

  // Two hits scoring the same means we cannot tell them apart — say so rather
  // than picking one arbitrarily.
  const ambiguous = Boolean(runnerUp && best.score - runnerUp.score < 15);
  if (ambiguous) best.reasons.push('ambiguous — similar candidates exist');

  return {
    ...best,
    confidence: Math.max(0, Math.min(100, ambiguous ? Math.min(best.score, 55) : best.score)),
    ambiguous,
    alternatives: scored.slice(1, 4).map((s) => ({
      npi: s.provider.npi,
      name: s.provider.name,
      specialty: s.provider.specialty,
      city: s.provider.city,
      state: s.provider.state,
      score: s.score,
      sourceUrl: s.provider.sourceUrl,
    })),
  };
}

/**
 * getJson labels → the source name a rep would recognise, for outage messages.
 */
const SOURCE_NAMES = {
  nppes: nppes.SOURCE_NAME,
  'nppes-org': nppes.SOURCE_NAME,
  'open-payments': 'CMS Open Payments',
  cms: 'CMS Provider Data',
  pubmed: 'PubMed',
  'pubmed-summary': 'PubMed',
  clinicaltrials: 'ClinicalTrials.gov',
};

/** The tiers that decide WHO this person is; the rest only decorate a profile. */
const IDENTITY_LABELS = ['nppes', 'nppes-org'];

/**
 * Enrich one unknown attendee.
 *
 * @param {object} query
 * @param {string} [query.email]        attendee address (the usual entry point)
 * @param {string} [query.name]         free-text name, if the rep knows it
 * @param {string} [query.firstName]
 * @param {string} [query.lastName]
 * @param {string} [query.state]        code or full name — narrows NPPES a lot
 * @param {string} [query.city]
 * @param {string} [query.npi]          skip identity resolution entirely
 * @param {string} [query.facilityName] hint for the facility-only path
 * @param {string} [query.meetingContext] meeting title/description, for disambiguation
 * @param {'auto'|'always'|'never'} [query.useWeb='auto'] paid identity tier
 * @param {boolean} [query.refresh] bypass the cache and look everything up again
 */
async function runEnrich(query = {}) {
  const startedAt = Date.now();
  const email = (query.email || '').trim().toLowerCase();
  const p = createProfile();

  const result = {
    status: 'unresolved',
    query: { email: email || null, name: query.name || null, npi: query.npi || null },
    inBis: false,
    npi: null,
    physician: null,
    matchedFacility: null,
    colleagues: [],
    alternatives: [],
    confidence: 0,
    tiers: [], // which tiers actually contributed — handy when debugging a miss
  };

  // ── T0: the BIS directory itself ──────────────────────────────────────────
  if (email) {
    const known = physicians.getByEmail(email);
    if (known) {
      result.tiers.push('T0:bis-email');
      result.status = 'in_bis';
      result.inBis = true;
      result.npi = known.npi;
      result.physician = known;
      result.confidence = 100;
      p.note('Already in BIS — the standard brief applies; no enrichment needed.');
      result.profile = p.toJSON();
      result.elapsedMs = Date.now() - startedAt;
      return result;
    }
    result.tiers.push('T0:miss');
  }

  // ── Cache: skip the whole cascade when this address was looked up recently.
  //    Checked AFTER the BIS lookup so the master is always read live, and it
  //    never serves a result shallower than this request asks for (a free-tier
  //    answer cannot satisfy a request that wants the paid tier).
  const forceRefresh = query.refresh === true || query.refresh === 'true';
  // Mirror the real T1 decision below, including the organisational-mailbox
  // check: an address the paid tier will never run for should still be served
  // from cache, rather than re-running the whole cascade for nothing.
  const wantsWebForCache =
    webIdentity.enabled &&
    Boolean(email) &&
    (query.useWeb || 'auto') !== 'never' &&
    !rematch.nameHintsFromEmail(email).generic &&
    (query.useWeb === 'always' || !(query.lastName || query.name));

  // Keyed by email when we have one, else by NPI — the backfill enriches
  // physicians who are already in BIS and have no address at all.
  const cacheRef = { email, npi: query.npi };
  if ((email || query.npi) && !forceRefresh) {
    const hit = await cache.get(cacheRef, { wantWeb: wantsWebForCache });
    if (hit) {
      hit.elapsedMs = Date.now() - startedAt;
      return hit;
    }
  }

  // ── T0.5: email domain → facility, from BIS's own emails ─────────────────
  let domainHit = null;
  if (email) {
    domainHit = rematch.facilityFromDomain(email);
    if (domainHit) {
      result.tiers.push('T0.5:domain-index');
      p.set(
        'facility',
        inferred(domainHit.facility.name, {
          source: `email domain (${email.split('@')[1]}) — ${domainHit.count} BIS physician(s) share it`,
          confidence: domainHit.confidence,
        })
      );
      p.note(
        `Email domain matches ${domainHit.count} physician(s) already at ` +
          `${domainHit.facility.name} in BIS.`
      );
    }
  }

  // ── Name hints: explicit first, guessed from the address second ──────────
  const explicit = query.lastName
    ? { firstName: query.firstName || '', lastName: query.lastName }
    : query.name
      ? splitName(query.name)
      : null;

  const nameCandidates = [];
  if (explicit?.lastName) {
    nameCandidates.push({ ...explicit, confidence: 100, rule: 'caller-supplied' });
  }

  const emailHints = email ? rematch.nameHintsFromEmail(email) : { generic: false, candidates: [] };
  if (emailHints.generic) {
    p.note('Address looks like a shared/organisational mailbox, not a person.');
  }

  // ── T1: web identity — the only paid tier, and the only thing that can turn
  //        an opaque address into a name. Skipped when the caller already gave
  //        one (nothing to buy) or the mailbox is clearly organisational.
  const webMode = query.useWeb || 'auto';
  const runWeb =
    webIdentity.enabled &&
    Boolean(email) &&
    webMode !== 'never' &&
    !emailHints.generic &&
    (webMode === 'always' || !explicit?.lastName);

  let web = null;
  if (runWeb) {
    web = await webIdentity.identify({
      email,
      facilityHint: query.facilityName || domainHit?.facility?.name || null,
      cityHint: query.city || domainHit?.facility?.city || null,
      stateHint: query.state || domainHit?.facility?.state || null,
      meetingContext: query.meetingContext || null,
    });
  }

  const identity = web?.identity || null;
  if (identity) {
    result.tiers.push('T1:web-identity');
    result.web = {
      confidence: identity.confidence,
      reasoning: identity.reasoning,
      queries: web.queries,
      citations: web.citations,
      usage: web.usage,
    };

    const evidenceUrl = identity.evidence_urls[0] || web.citations[0]?.url || null;
    const webMeta = {
      source: webIdentity.SOURCE_NAME,
      sourceUrl: evidenceUrl,
      confidence: identity.confidence,
    };

    // A confident "not a physician" ends the enrichment here: no registry
    // lookups, no brief. This is an exclusion by EVIDENCE, not by a domain list.
    if (!identity.is_physician && identity.confidence >= 50) {
      result.status = 'not_physician';
      result.confidence = identity.confidence;
      p.set('name', fromWeb(identity.full_name, webMeta));
      p.setExtra('jobTitle', fromWeb(identity.title, webMeta));
      p.setExtra('institution', fromWeb(identity.institution, webMeta));
      p.setExtra('evidenceUrls', fromWeb(identity.evidence_urls, webMeta));
      p.note(
        `Identified as a non-physician${identity.title ? ` (${identity.title})` : ''} — ` +
          'no physician brief produced.'
      );
      result.profile = p.toJSON();
      result.elapsedMs = Date.now() - startedAt;
      // Worth remembering: without this, the same colleague costs a paid
      // lookup every time they appear on a meeting.
      await cache.put({ email, npi: result.npi }, result);
      return result;
    }

    p.set('name', fromWeb(identity.full_name, webMeta));
    p.set('specialty', fromWeb(identity.specialty, webMeta));
    p.set('credential', fromWeb(identity.credentials, webMeta));
    p.setExtra('jobTitle', fromWeb(identity.title, webMeta));
    p.setExtra('institution', fromWeb(identity.institution, webMeta));
    p.setExtra('evidenceUrls', fromWeb(identity.evidence_urls, webMeta));
    p.setExtra('identityReasoning', fromWeb(identity.reasoning, webMeta));

    // The name the web found leads the registry search — this is the hint that
    // free tiers alone could not produce.
    if (identity.last_name) {
      nameCandidates.unshift({
        firstName: identity.first_name || '',
        lastName: identity.last_name,
        confidence: Math.max(50, identity.confidence),
        rule: 'web identity',
      });
    }
  }

  nameCandidates.push(...emailHints.candidates);

  const stateHint = query.state || identity?.state || domainHit?.facility?.state || null;
  const cityHint = query.city || identity?.city || domainHit?.facility?.city || null;

  // ── T2: NPPES — the authoritative NPI ────────────────────────────────────
  let provider = null;
  let pick = null;

  if (query.npi) {
    provider = await nppes.getByNpi(query.npi);
    if (provider) {
      result.tiers.push('T2:nppes-by-npi');
      pick = { provider, confidence: 100, reasons: ['NPI supplied'], ambiguous: false, alternatives: [] };
    }
  } else {
    // Each interpretation of the address ("nshaheen" → N. Shaheen / Shaheen N. /
    // surname Nshaheen) is an independent free lookup, so they run together —
    // sequentially this cost ~17s on an address that resolves to nothing.
    const tried = nameCandidates.slice(0, MAX_NAME_CANDIDATES);
    const searches = await Promise.all(
      tried.map(async (candidate) => ({
        candidate,
        hits: await nppes.searchIndividuals({
          lastName: candidate.lastName,
          firstName: candidate.firstName,
          state: states.toCode(stateHint),
          limit: 20,
        }),
      }))
    );

    for (const { candidate, hits } of searches) {
      if (!hits.length) continue;

      const attempt = pickBestProvider(hits, {
        firstName: candidate.firstName,
        state: stateHint,
        city: cityHint,
      });
      if (!attempt) continue;

      // A guessed name is less trustworthy than one the rep supplied — but a
      // strong, unique registry hit corroborates the guess, so blend rather
      // than multiply (multiplying threw that corroboration away).
      const ruleFactor = 0.6 + (0.4 * candidate.confidence) / 100;
      attempt.confidence = Math.round(attempt.confidence * ruleFactor);
      attempt.reasons.push(`name from ${candidate.rule}`);

      if (!pick || attempt.confidence > pick.confidence) pick = attempt;
    }

    if (pick) {
      provider = pick.provider;
      result.tiers.push('T2:nppes-search');
    }
  }

  if (provider) {
    result.npi = provider.npi;
    result.confidence = pick.confidence;
    result.alternatives = pick.alternatives || [];

    const meta = { source: nppes.SOURCE_NAME, sourceUrl: provider.sourceUrl };
    p.set('name', fromRegistry(provider.name, meta));
    p.set('npi', fromRegistry(provider.npi, meta));
    p.set('specialty', fromRegistry(provider.specialty, meta));
    p.set('credential', fromRegistry(provider.credential, meta));
    p.set('phone', fromRegistry(provider.phone, meta));
    p.set('address', fromRegistry(provider.address, meta));
    p.set('city', fromRegistry(provider.city, meta));
    p.set('state', fromRegistry(provider.state, meta));
    p.setExtra('licenseNumber', fromRegistry(provider.license, meta));
    p.setExtra('licenseState', fromRegistry(provider.licenseState, meta));
    p.setExtra('npiEnumerated', fromRegistry(provider.enumerationDate, meta));
    p.setExtra(
      'taxonomies',
      fromRegistry(
        provider.taxonomies.map((t) => t.desc).filter(Boolean),
        meta
      )
    );

    const derivedTerritory = territory.resolveTerritory(states.toName(provider.state));
    p.set(
      'territory',
      inferred(derivedTerritory, { source: 'derived from practice state (src/territory.js)' })
    );
  }

  // ── T3: back into BIS with the resolved NPI ──────────────────────────────
  let bisPhysician = null;
  if (result.npi) {
    bisPhysician = rematch.physicianByNpi(result.npi);
    if (bisPhysician) {
      result.tiers.push('T3:recovered-by-npi');
      result.inBis = true;
      result.physician = bisPhysician;
      result.status = 'recovered_in_bis';
      result.confidence = Math.max(result.confidence, 90);
      p.note(
        email
          ? 'Recovered from BIS by NPI — this address is not the one the master ' +
            'holds for them, but the physician is in it.'
          : 'Matched into BIS by NPI — the physician is in the master; the name in ' +
            'the meeting resolved to their registry NPI.'
      );

      const bisMeta = { source: 'BIS master data (bis_physicians)' };
      p.set('name', fromBis(bisPhysician.name, bisMeta));
      p.set('specialty', fromBis(bisPhysician.specialty, bisMeta));
      p.set('phone', fromBis(bisPhysician.phone, bisMeta));
      if (bisPhysician.facility) {
        p.set('facility', fromBis(bisPhysician.facility.name, bisMeta));
        result.matchedFacility = bisPhysician.facility;
      }
    }
  }

  // ── T4: CMS hospital affiliation (also feeds the facility re-match) ──────
  let hospitals = [];
  if (result.npi) {
    // All four are free and independent, so they run together rather than
    // adding four round-trips of latency one after another.
    const [affiliated, payments, publications, trials] = await Promise.all([
      cms.getAffiliatedHospitals(result.npi, 2),
      openPayments.getPayments(result.npi),
      literature.getPublications({
        firstName: provider?.firstName || identity?.first_name,
        middleName: provider?.middleName,
        lastName: provider?.lastName || identity?.last_name,
        // Narrowing context — a bare surname + initials is not a person.
        institution: identity?.institution || domainHit?.facility?.name || null,
        city: provider?.city || identity?.city || null,
        state: states.toName(provider?.state || identity?.state) || null,
        specialty: provider?.specialty || identity?.specialty || null,
      }),
      literature.getTrials(provider?.name || identity?.full_name),
    ]);
    hospitals = affiliated;

    // Industry payments — who else is already paying this physician. The most
    // commercially useful thing outside BIS, and BIS has no column for it.
    if (payments) {
      result.tiers.push('T4:open-payments');
      const payMeta = { source: openPayments.SOURCE_NAME, sourceUrl: payments.sourceUrl };
      p.setExtra('industryPayments', fromRegistry(openPayments.summarize(payments), payMeta));
      p.setExtra(
        'payingCompanies',
        fromRegistry(
          payments.topPayers.map((t) => `${t.payer} ($${t.amount.toLocaleString('en-US')})`),
          payMeta
        )
      );
      if (payments.products.length) {
        p.setExtra('paymentProducts', fromRegistry(payments.products, payMeta));
      }
      result.industryPayments = payments;
    }

    if (publications) {
      result.tiers.push('T4:pubmed');
      const pubMeta = { source: literature.SOURCE_PUBMED, sourceUrl: publications.sourceUrl };
      p.setExtra(
        'publications',
        fromRegistry(
          `${publications.count} indexed publication(s)` +
            (publications.narrowed ? '' : ' — surname match only, not verified as this person'),
          pubMeta
        )
      );
      if (publications.recent.length) {
        p.setExtra(
          'recentPublications',
          fromRegistry(
            publications.recent.map((r) => `${r.year} — ${r.title}`),
            pubMeta
          )
        );
      }
      result.publications = publications;
    }

    if (trials) {
      result.tiers.push('T4:trials');
      const trialMeta = { source: literature.SOURCE_TRIALS, sourceUrl: trials.sourceUrl };
      p.setExtra(
        'clinicalTrials',
        fromRegistry(
          trials.studies.map((t) => `${t.nct} — ${t.title} (${t.status || 'status unknown'})`),
          trialMeta
        )
      );
      result.trials = trials;
    }

    if (hospitals.length) {
      result.tiers.push('T4:cms-affiliation');
      const h = hospitals[0];
      const hMeta = { source: cms.SOURCE_HOSPITAL, sourceUrl: h.sourceUrl };
      p.set('facility', fromRegistry(h.name, hMeta));
      p.set('facilityAddress', fromRegistry(h.address, hMeta));
      p.setExtra('facilityType', fromRegistry(h.type, hMeta));
      p.setExtra('facilityOwnership', fromRegistry(h.ownership, hMeta));
      p.setExtra('facilityRating', fromRegistry(h.rating ? `${h.rating} / 5 (CMS)` : null, hMeta));
      p.setExtra('facilityPhone', fromRegistry(h.phone, hMeta));
      p.setExtra('facilityCcn', fromRegistry(h.ccn, hMeta));
    }
  }

  // ── T3b: facility re-match — the payoff when the physician is absent ─────
  if (!result.matchedFacility) {
    const attempts = [
      ...hospitals.map((h) => ({ name: h.name, city: h.city, state: h.state, via: 'CMS hospital' })),
      query.facilityName
        ? { name: query.facilityName, city: provider?.city || cityHint, state: provider?.state || stateHint, via: 'caller hint' }
        : null,
    ].filter((a) => a && a.name);

    for (const attempt of attempts) {
      const hit = rematch.matchFacility(attempt);
      if (hit) {
        result.tiers.push('T3:facility-matched');
        result.matchedFacility = { ...hit.facility, matchScore: hit.score, matchedVia: attempt.via };
        p.set('facility', fromBis(hit.facility.name, { source: 'BIS master data (bis_facilities)' }));
        p.set(
          'territory',
          fromBis(hit.facility.territory, { source: 'BIS master data (bis_facilities)' })
        );
        p.set(
          'healthSystem',
          fromBis(hit.facility.healthSystem, { source: 'BIS master data (bis_facilities)' })
        );
        p.note(
          `Facility found in BIS: ${hit.facility.name} (${hit.facility.id}) — ` +
            `matched via ${attempt.via}, ${hit.reason}, score ${hit.score}.`
        );
        break;
      }
    }

    // The domain index already returns a bis_facilities row — no name matching
    // needed, and re-matching it by name risks landing on a sibling record.
    if (!result.matchedFacility && domainHit) {
      result.tiers.push('T0.5:facility-direct');
      result.matchedFacility = {
        ...domainHit.facility,
        matchedVia: `email domain (${domainHit.count} BIS physician(s))`,
      };
      p.set('facility', fromBis(domainHit.facility.name, { source: 'BIS master data (bis_facilities)' }));
      p.set('territory', fromBis(domainHit.facility.territory, { source: 'BIS master data (bis_facilities)' }));
      p.set('healthSystem', fromBis(domainHit.facility.healthSystem, { source: 'BIS master data (bis_facilities)' }));
    }
  }

  // Colleagues are the single most useful thing we can offer when the person
  // themselves is not in the master.
  if (result.matchedFacility?.id) {
    result.colleagues = rematch
      .colleaguesAt(result.matchedFacility.id, 6)
      .filter((c) => c.npi !== result.npi)
      .map((c) => ({ npi: c.npi, name: c.name, specialty: c.specialty, email: c.email }));
  }

  // ── Source outages ───────────────────────────────────────────────────────
  // Read the ledger BEFORE deciding the status: a tier that never answered must
  // not be reported as a tier that answered "no". Without this, a resolver that
  // could not look up npiregistry.cms.hhs.gov produced a confident
  // "could not resolve this address from the free registries" — a claim about
  // the physician, made on evidence about the network.
  const outages = health.outages().filter((o) => o.blind);
  result.sourcesDown = outages.map((o) => ({
    source: SOURCE_NAMES[o.label] || o.label,
    label: o.label,
    host: o.host,
    kind: o.kind,
    error: o.error,
  }));
  result.degraded = outages.length > 0;
  // Only an identity-tier outage can turn a real person into an "unresolved";
  // losing PubMed just costs a publications list.
  const identityBlind = outages.filter((o) => IDENTITY_LABELS.includes(o.label));

  for (const o of outages) {
    p.note(`⚠️ ${health.describe(o, SOURCE_NAMES[o.label])}. Fields it supplies are missing from this profile, not absent from the registry.`);
  }

  // ── Final status ─────────────────────────────────────────────────────────
  if (result.status !== 'recovered_in_bis') {
    if (result.npi && result.confidence >= CONFIDENCE_ACCEPT) {
      result.status = 'external';
      p.note('Not in BIS — profile assembled from public registries.');
    } else if (result.npi && result.confidence >= CONFIDENCE_SUGGEST) {
      result.status = 'ambiguous';
      p.note(
        `Best registry match is ${result.confidence}% confident — treat as a ` +
          'suggestion and confirm before briefing.'
      );
    } else if (result.npi) {
      // Too weak to name anyone. Keep the candidates, withdraw the claim — and
      // with it everything the registries told us about that identity.
      result.alternatives = [
        {
          npi: result.npi,
          name: p.valueOf('name'),
          specialty: p.valueOf('specialty'),
          city: p.valueOf('city'),
          state: p.valueOf('state'),
        },
        ...result.alternatives,
      ];
      p.dropWhere((f) => f.tier === 'verified' || f.source.includes('practice state'));
      result.npi = null;

      // The CMS hospital came from that same unreliable NPI; a facility from
      // the email domain stands on its own evidence and survives.
      if (result.matchedFacility && !String(result.matchedFacility.matchedVia || '').includes('domain')) {
        result.matchedFacility = null;
        result.colleagues = [];
      }

      result.status = result.matchedFacility ? 'facility_only' : 'unresolved';
      p.note(
        'No registry match was confident enough to name this person; ' +
          'candidates listed instead.'
      );
    } else if (result.matchedFacility) {
      result.status = 'facility_only';
      result.confidence = Math.max(result.confidence, domainHit?.confidence || 40);
      p.note('Person could not be resolved; facility identified.');
    } else if (identityBlind.length) {
      // Nothing was found because nothing was asked. Saying "not in the
      // registries" here would be a fabrication.
      result.status = 'lookup_failed';
      result.confidence = 0;
      p.note(
        'This lookup did not fail to find the physician — it failed to reach the ' +
          'registry. Retry once ' +
          identityBlind.map((o) => o.host || o.label).join(', ') +
          ' resolves again (npm run enrich:doctor diagnoses it).'
      );
    } else {
      result.status = 'unresolved';
      p.note(
        'Could not resolve this address from the free registries. A name, or the ' +
          'web identity tier (P2), is needed.'
      );
    }
  }

  result.profile = p.toJSON();
  result.elapsedMs = Date.now() - startedAt;

  // cache.js already refuses to store an `unresolved` result for exactly this
  // reason; an outage can also produce a THIN but non-empty profile (NPPES down,
  // facility still matched from the email domain), and caching that would pin a
  // half-answer in front of the rep for the cache's whole TTL.
  if (result.degraded) {
    console.warn(
      `[enrichment] not caching ${email || query.npi || 'lookup'} — degraded run: ` +
        result.sourcesDown.map((o) => `${o.source} (${o.kind})`).join(', ')
    );
  } else {
    await cache.put({ email, npi: result.npi || query.npi }, result);
  }
  return result;
}

/**
 * Public entry point. The ledger is per-call because enrichments run
 * concurrently — the reminder engine briefs several meetings at once, and one
 * meeting's DNS failure must not be reported on another meeting's brief.
 */
function enrich(query = {}) {
  return health.run(() => runEnrich(query));
}

module.exports = { enrich, splitName, pickBestProvider, cache };

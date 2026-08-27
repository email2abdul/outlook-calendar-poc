'use strict';

const { getJson, buildUrl } = require('../http');

/**
 * Publications and trials — NIH PubMed and ClinicalTrials.gov.
 *
 * Signals a rep cannot get from BIS: whether this physician is a researcher, in
 * which techniques, and whether they are currently running trials. For a device
 * sale that separates a high-volume community endoscopist from a KOL who
 * publishes on the exact procedure the product serves.
 *
 * Free, no key. Verified live 2026-08-18: "Shaheen NJ[Author]" → 337 papers on
 * Barrett's/endoscopy; ClinicalTrials → overall official on an ablation trial.
 */

const PUBMED = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TRIALS = 'https://clinicaltrials.gov/api/v2/studies';

/**
 * PubMed's author index is "Surname II" — initials, no punctuation. Passing a
 * full first name ("Shaheen Nicholas") matches nothing; passing just the
 * surname matches every Shaheen in medicine. Verified: "Shaheen N" returned
 * unrelated dentistry and paediatrics papers, "Shaheen NJ" returned his own.
 */
function authorTerm(firstName, lastName, middleName) {
  const surname = String(lastName || '').trim();
  if (!surname) return null;
  const initials = [firstName, middleName]
    .map((n) => String(n || '').trim()[0] || '')
    .join('')
    .toUpperCase();
  return initials ? `${surname} ${initials}[Author]` : `${surname}[Author]`;
}

/**
 * Narrow an author search to this physician.
 *
 * A surname plus initials is NOT a person: "Jain A[Author]" matched 10,279
 * papers during testing, and reporting that as one physician's output is worse
 * than reporting nothing. Where an affiliation or specialty is known, it is
 * added as a filter — precision matters more than recall here, because the
 * number goes in front of a rep as a fact about the person they are meeting.
 */
function narrowingFilter({ institution, city, state, specialty }) {
  const affiliations = [institution, city, state]
    .map((v) => String(v || '').trim())
    .filter((v) => v.length > 2)
    .map((v) => `"${v}"[Affiliation]`);

  // Take the leading word of the taxonomy ("Internal Medicine, Gastroenterology"
  // → "Gastroenterology" is the distinctive half) as a subject filter.
  const subject = String(specialty || '')
    .split(',')
    .pop()
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 4)[0];

  // Affiliations are alternatives (any one of them identifies the place), but
  // the subject is an additional requirement — OR-ing them together let every
  // "Jain A" paper about gastroenterology back in, anywhere in the world.
  const clauses = [];
  if (affiliations.length) clauses.push(`(${affiliations.join(' OR ')})`);
  if (subject) clauses.push(`"${subject}"`);
  return clauses.length ? clauses.join(' AND ') : null;
}

/**
 * Publication record for a physician.
 * @returns {Promise<{count:number, recent:Array, searchTerm:string,
 *   narrowed:boolean, sourceUrl:string}|null>}
 */
async function getPublications({
  firstName,
  lastName,
  middleName,
  topic,
  institution,
  city,
  state,
  specialty,
} = {}) {
  const author = authorTerm(firstName, lastName, middleName);
  if (!author) return null;

  const filter = topic ? `(${topic})` : narrowingFilter({ institution, city, state, specialty });
  const term = filter ? `${author} AND ${filter}` : author;
  const search = await getJson(
    buildUrl(`${PUBMED}/esearch.fcgi`, {
      db: 'pubmed',
      term,
      retmax: 3,
      retmode: 'json',
      sort: 'date',
    }),
    { label: 'pubmed' }
  );
  if (!search.ok || !search.body) return null;

  const result = search.body.esearchresult || {};
  const ids = result.idlist || [];
  const count = Number(result.count || 0);
  if (!count) return null;

  let recent = [];
  if (ids.length) {
    const summary = await getJson(
      buildUrl(`${PUBMED}/esummary.fcgi`, { db: 'pubmed', id: ids.join(','), retmode: 'json' }),
      { label: 'pubmed-summary' }
    );
    const map = summary.body?.result || {};
    recent = ids
      .map((id) => map[id])
      .filter(Boolean)
      .map((r) => ({
        title: r.title || null,
        year: String(r.pubdate || '').slice(0, 4) || null,
        journal: r.source || null,
        url: `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`,
      }));
  }

  return {
    count,
    recent,
    searchTerm: term,
    // Without a narrowing clause the count is a surname's output, not a
    // person's — callers should present it with that caveat.
    narrowed: Boolean(filter),
    sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(term)}`,
  };
}

/**
 * Trials where this person is listed as an official.
 * @returns {Promise<{count:number, studies:Array, sourceUrl:string}|null>}
 */
async function getTrials(fullName) {
  const name = String(fullName || '').trim();
  if (name.length < 4) return null;

  const res = await getJson(
    buildUrl(TRIALS, {
      'query.term': name,
      pageSize: 5,
      fields: 'NCTId,BriefTitle,OverallStatus,OverallOfficialName',
    }),
    { label: 'clinicaltrials' }
  );
  if (!res.ok || !res.body) return null;

  // The API matches the term anywhere in a study; keep only studies where the
  // person is actually named as an official, or the hit means nothing.
  const surname = name.split(/\s+/).pop().toLowerCase();
  const studies = (res.body.studies || [])
    .map((s) => {
      const id = s.protocolSection?.identificationModule || {};
      const officials = (s.protocolSection?.contactsLocationsModule?.overallOfficials || [])
        .map((o) => o.name)
        .filter(Boolean);
      return {
        nct: id.nctId || null,
        title: id.briefTitle || null,
        status: s.protocolSection?.statusModule?.overallStatus || null,
        officials,
        url: id.nctId ? `https://clinicaltrials.gov/study/${id.nctId}` : null,
      };
    })
    .filter((s) => s.nct && s.officials.some((o) => o.toLowerCase().includes(surname)));

  if (!studies.length) return null;

  return {
    count: studies.length,
    studies: studies.slice(0, 3),
    sourceUrl: `https://clinicaltrials.gov/search?term=${encodeURIComponent(name)}`,
  };
}

module.exports = {
  getPublications,
  getTrials,
  authorTerm,
  SOURCE_PUBMED: 'NIH PubMed',
  SOURCE_TRIALS: 'ClinicalTrials.gov',
};

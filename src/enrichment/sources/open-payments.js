'use strict';

const { getJson, buildUrl } = require('../http');

/**
 * CMS Open Payments — what medical-device and pharma companies have paid this
 * physician (Sunshine Act disclosures).
 *
 * For a Lumendi rep this is the single most commercially useful thing outside
 * BIS: it names the competitors already in the room. Nicholas Shaheen's 2024
 * record lists Lucid Diagnostics, Exact Sciences, Phathom and Intercept — so
 * the rep walks in knowing who else is courting him, and with what.
 *
 * Free, no key. Verified live 2026-08-18: NPI 1467521757 → 29 payments in 2024,
 * 11 in 2025, same `covered_recipient_npi` column in both yearly datasets.
 */

const DATASTORE = 'https://openpaymentsdata.cms.gov/api/1/datastore/query';

// General (non-research) payments, newest years first. Yearly datasets are
// published separately; two years is enough to show a current relationship
// without doubling the request count for little gain.
const YEARLY_DATASETS = [
  { year: 2025, id: 'fb0b1734-1410-429d-92f6-3f4b35218e5e' },
  { year: 2024, id: 'e6b17c6a-2534-4207-a4a1-6746a14911ff' },
];

const PROFILE_URL = 'https://openpaymentsdata.cms.gov/';

function toAmount(value) {
  const n = Number(String(value || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** One year of payments for an NPI. Empty array on any failure. */
async function paymentsForYear(npi, dataset) {
  const url = buildUrl(`${DATASTORE}/${dataset.id}/0`, {
    limit: 200,
    'conditions[0][property]': 'covered_recipient_npi',
    'conditions[0][value]': npi,
    'conditions[0][operator]': '=',
  });

  const res = await getJson(url, { label: 'open-payments', timeoutMs: 40000 });
  if (!res.ok || !res.body) return [];

  return (res.body.results || []).map((r) => ({
    year: dataset.year,
    payer: r.applicable_manufacturer_or_applicable_gpo_making_payment_name || null,
    amount: toAmount(r.total_amount_of_payment_usdollars),
    nature: r.nature_of_payment_or_transfer_of_value || null,
    product: r.name_of_drug_or_biological_or_device_or_medical_supply_1 || null,
    date: r.date_of_payment || null,
  }));
}

/**
 * Industry payments summary for one physician.
 *
 * @returns {Promise<{totalUsd:number, paymentCount:number, years:number[],
 *   topPayers:Array<{payer:string,amount:number,count:number}>,
 *   natures:string[], products:string[], latestDate:string|null,
 *   sourceUrl:string}|null>} null when there is nothing to report
 */
async function getPayments(npi) {
  const clean = String(npi || '').replace(/\D/g, '');
  if (clean.length !== 10) return null;

  const years = await Promise.all(YEARLY_DATASETS.map((d) => paymentsForYear(clean, d)));
  const rows = years.flat();
  if (!rows.length) return null;

  const byPayer = new Map();
  for (const r of rows) {
    if (!r.payer) continue;
    const entry = byPayer.get(r.payer) || { payer: r.payer, amount: 0, count: 0 };
    entry.amount += r.amount;
    entry.count += 1;
    byPayer.set(r.payer, entry);
  }

  const unique = (values) => [...new Set(values.filter(Boolean))];

  return {
    totalUsd: Math.round(rows.reduce((sum, r) => sum + r.amount, 0)),
    paymentCount: rows.length,
    years: unique(rows.map((r) => r.year)).sort((a, b) => b - a),
    topPayers: [...byPayer.values()].sort((a, b) => b.amount - a.amount).slice(0, 5),
    natures: unique(rows.map((r) => r.nature)).slice(0, 6),
    products: unique(rows.map((r) => r.product)).slice(0, 6),
    // Dates are MM/DD/YYYY strings; compare as instants, not lexically.
    latestDate:
      rows
        .map((r) => r.date)
        .filter(Boolean)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null,
    sourceUrl: PROFILE_URL,
  };
}

/** One-line summary for the brief: "$18,240 from 7 companies (2024-2025)". */
function summarize(payments) {
  if (!payments) return null;
  const money = `$${payments.totalUsd.toLocaleString('en-US')}`;
  const companies = payments.topPayers.length;
  const span = payments.years.length > 1
    ? `${Math.min(...payments.years)}–${Math.max(...payments.years)}`
    : String(payments.years[0]);
  return `${money} across ${payments.paymentCount} payment(s) from ${companies} company/companies (${span})`;
}

module.exports = { getPayments, summarize, SOURCE_NAME: 'CMS Open Payments' };

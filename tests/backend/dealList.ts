// A checklist of deal size for the duplicate check's tests: 2,400 items, as a firm's list for a project-finance deal is,
// made of the documents a deal has and what is asked of each. Some items repeat another in other words, a short name
// for a long one among them ("PPA" for "power purchase agreement"), as a list put together from several older ones does.
const SUBJECTS = ['power purchase agreement', 'EPC contract', 'O&M agreement', 'interconnection agreement', 'land lease', 'easement', 'transmission service agreement', 'turbine supply agreement', 'module supply agreement', 'inverter warranty',
  'long-term service agreement', 'shareholders agreement', 'common terms agreement', 'credit agreement', 'intercreditor agreement', 'hedging agreement', 'security agreement', 'pledge of membership interests', 'consent to assignment', 'direct agreement',
  'independent engineer report', 'environmental impact assessment', 'phase I environmental site assessment', 'title insurance policy', 'ALTA survey', 'zoning approval', 'conditional use permit', 'building permit', 'air permit', 'water rights',
  'construction budget', 'construction schedule', 'base case financial model', 'insurance consultant report', 'builder risk insurance policy', 'property insurance policy', 'business interruption insurance', 'tax equity agreement', 'renewable energy credit agreement', 'capacity contract',
  'gas supply agreement', 'fuel transportation agreement', 'decommissioning plan', 'asset management agreement', 'administrative services agreement', 'accounts agreement', 'debt service reserve account', 'major maintenance reserve', 'letter of credit facility', 'parent guarantee',
  'legal opinion', 'officer certificate', 'formation documents', 'good standing certificate', 'board resolutions', 'FERC market-based rate authorization', 'qualifying facility certification', 'NERC registration', 'local tax abatement agreement', 'community benefits agreement'];
const ASKS = ['An executed copy of the {s} has been provided', 'Every amendment to the {s} has been provided', 'The {s} is in full force and effect', 'No party to the {s} is in default', 'The term of the {s} runs at least to the final maturity date',
  'The {s} may be collaterally assigned to the lenders', 'Termination rights under the {s} are acceptable to the lenders', 'Change of control under the {s} needs no consent, or consent has been obtained', 'Liquidated damages under the {s} are capped at an acceptable level', 'Governing law of the {s} is New York or Delaware',
  'Payment terms of the {s} match the base case financial model', 'Credit support required under the {s} has been posted', 'The counterparty to the {s} is rated investment grade', 'Force majeure provisions of the {s} are market standard', 'The {s} contains no most favored nation clause',
  'Notices delivered under the {s} in the last two years have been provided', 'Disputes under the {s} are listed with their status', 'Indemnities given under the {s} are within market norms', 'The limitation of liability in the {s} is acceptable', 'Conditions precedent under the {s} have been satisfied',
  'Insurance required by the {s} is in place', 'Confidentiality terms of the {s} permit disclosure to lenders', 'The {s} was approved by each party\'s board', 'Exclusivity terms of the {s} are acceptable', 'Pricing escalation in the {s} is fixed or indexed to CPI',
  'Performance guarantees in the {s} are backed by security', 'The {s} counterparty has delivered an estoppel certificate', 'Step-in rights for lenders under the {s} are documented', 'Cure periods in the {s} are at least thirty days', 'The {s} does not restrict distributions',
  'Audit rights under the {s} are reasonable', 'Taxes under the {s} are allocated as the model assumes', 'The {s} has no unusual termination payments', 'Key personnel requirements of the {s} are met', 'Reporting obligations under the {s} are being met',
  'Deliverables due under the {s} have been delivered', 'The {s} survives a foreclosure by the lenders', 'Sanctions and anti-corruption terms of the {s} are adequate', 'Any side letter to the {s} has been provided', 'The {s} was entered into on arm\'s length terms'];
/** what a short name stands for, used both ways in the repeats */
const LONG: Record<string, string> = { 'power purchase agreement': 'PPA', 'EPC contract': 'engineering, procurement and construction contract', 'O&M agreement': 'operation and maintenance agreement', 'long-term service agreement': 'LTSA', 'independent engineer report': 'IE report', 'common terms agreement': 'CTA' };
/** the same ask in other words: the repeats mean what the original means, put another way */
const REPHRASE: [RegExp, string][] = [[/^An executed copy of the (.*) has been provided$/, 'Provide the signed $1'], [/^Every amendment to the (.*) has been provided$/, 'All amendments of the $1 are on file'], [/^No party to the (.*) is in default$/, 'There is no default by any party under the $1'],
  [/^The (.*) may be collaterally assigned to the lenders$/, 'Lenders can take a collateral assignment of the $1'], [/^The counterparty to the (.*) is rated investment grade$/, 'The $1 counterparty holds an investment grade rating'],
  [/^The (.*) is in full force and effect$/, 'Confirm the $1 remains in effect'], [/^Insurance required by the (.*) is in place$/, 'Coverage that the $1 calls for has been bound'], [/^Governing law of the (.*) is New York or Delaware$/, 'The $1 is governed by the laws of New York or Delaware'],
  [/^Disputes under the (.*) are listed with their status$/, 'List any dispute arising under the $1 and where it stands'], [/^Any side letter to the (.*) has been provided$/, 'Side letters relating to the $1 are on file']];

/** 2,400 items; `repeats` holds [original, repeat] places, each repeat asking for the same as its original in other words */
export function dealList(): { items: string[]; repeats: [number, number][] } {
  const items: string[] = []; for (const a of ASKS) for (const s of SUBJECTS) items.push(a.replace('{s}', s));
  const repeats: [number, number][] = []; let k = 0;
  // every 13th item from the 100th on is replaced by a rephrasing of an item before it, a short name swapped for a long one where there is one
  for (let at = 100; at < items.length; at += 13) {
    const from = (at * 7 + k++ * 13) % at; const re = REPHRASE.find(([r]) => r.test(items[from])); if (!re) continue;
    let t = items[from].replace(re[0], re[1]); for (const [l, sh] of Object.entries(LONG)) if (t.includes(l)) { t = t.replace(l, sh); break; } else if (t.includes(sh)) { t = t.replace(sh, l); break; }
    items[at] = t; repeats.push([from, at]);
  }
  return { items, repeats };
}

/**
 * 2,400 items with little wording in common, each of seven words from a vocabulary of 4,000 (the commoner words used more),
 * as made-up words. Every 37th
 * item from the 100th on is a repeat that keeps four of an earlier item's words.
 */
export function variedList(): { items: string[]; repeats: [number, number][] } {
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const vocabulary = Array.from({ length: 4000 }, (_, i) => `w${i.toString(36)}x`.replace(/\d/g, (d) => 'abcdefghij'[+d]));
  const word = () => vocabulary[Math.floor(4000 * rnd() ** 2.2)];
  const items = Array.from({ length: 2400 }, () => Array.from({ length: 7 }, word).join(' ')); const repeats: [number, number][] = [];
  for (let at = 100; at < items.length; at += 37) { const from = Math.floor(rnd() * at); const w = items[from].split(' '); items[at] = [w[0], w[2], w[4], w[6], word(), word(), word()].join(' '); repeats.push([from, at]); }
  return { items, repeats };
}

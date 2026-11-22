// A technology list as a person would paste it from a Word document: a title, a note, numbered sections and items,
// a few items wrapped over two lines, and page footers. Mock-up content only.
export const SECTIONS: [string, string | null, string[]][] = [
  ['Site and real estate', null, [
    'Title report and survey for the whole site, with exceptions reviewed',
    'Leases or easements cover the array, the substation and the gen-tie route',
    'Lease term runs at least five years past the PPA term',
    'Landowner consents to the lender’s collateral assignment',
    'Non-disturbance agreements from every mortgagee of the leased land',
    'Zoning allows a solar facility of this size; no variance outstanding',
    'Crossing agreements for every road, pipeline and rail crossing',
    'Access rights for construction traffic and for operations',
    'No mineral rights reservations that could disturb the array',
    'Decommissioning and site restoration obligations identified and costed',
    'Property tax treatment confirmed, including any PILOT agreement',
    'Title insurance commitment with the endorsements lenders require',
  ]],
  ['Permits and environmental', null, [
    'Conditional use permit issued and no longer open to appeal',
    'Building and electrical permits identified, with the schedule to obtain them',
    'Phase I environmental site assessment less than 180 days old',
    'Wetlands delineation complete; any Section 404 permit in hand',
    'Endangered species review; any incidental take permit obtained',
    'Cultural resources survey with SHPO concurrence',
    'Stormwater pollution prevention plan and NPDES coverage',
    'Glare study where the site is near an airport or a highway',
    'FAA determinations of no hazard for any structure that needs one',
    'Avian and bat surveys where the permits require them',
    'Permit conditions mapped to the construction schedule',
    'No pending or threatened litigation over the permits',
    'Transfer of each permit to the project company confirmed',
    'Noise limits in the permit met by the inverter and transformer layout',
  ]],
  ['Interconnection', null, [
    'Interconnection agreement executed; conditions to energization identified',
    'Network upgrade costs allocated, capped and secured',
    'Queue position and any restudy risk reviewed',
    'Point of interconnection matches the site plan and the gen-tie design',
    'Deliverability status supports the capacity the PPA assumes',
    'Curtailment history at the node and expected curtailment modeled',
    'Interconnection security posted, with the return terms understood',
    'Milestones in the interconnection agreement fit the COD schedule',
    'Affected system studies complete, with their costs allocated',
    'Shared facilities agreement where the gen-tie or substation is shared',
    'Metering and telemetry meet the utility’s requirements',
    'Backfeed power arrangements for commissioning in place',
  ]],
  ['Equipment supply', 'Modules', [
    'Module supply agreement gives a product warranty of at least 10 years',
    'Performance warranty of at least 25 years, with the degradation curve',
    'Module supplier on the lenders’ approved list, or credit support given',
    'Factory audit and pre-shipment inspection rights',
    'Forced labor and customs compliance (UFLPA) documented for the supply chain',
    'Tariff and AD/CVD exposure allocated between buyer and supplier',
  ]],
  ['Equipment supply', 'Inverters', [
    'Inverter supply agreement and long-term service agreement in place',
    'Inverter warranty term and any extended warranty priced',
    'Spare parts held on site or within an agreed response time',
    'Grid code compliance certified for the interconnection',
  ]],
  ['Equipment supply', 'Trackers', [
    'Tracker supply agreement with structural warranty',
    'Stow strategy for high wind and hail reviewed by the independent engineer',
    'Tracker controls and communications design reviewed',
    'Geotechnical report supports the pile design and embedment',
    'Corrosion study supports the steel coating chosen',
    'Supplier’s performance security and liability caps reviewed',
  ]],
  ['EPC and construction', null, [
    'EPC contract is fixed-price, date-certain and turnkey',
    'Delay liquidated damages cover debt service and lost PPA revenue',
    'Performance liquidated damages tied to the capacity test',
    'EPC contractor’s liability cap of at least 100% of the contract price',
    'Performance security: letter of credit or parent guarantee',
    'Construction schedule with float to the PPA’s guaranteed COD',
    'Change order regime and contingency sized by the independent engineer',
    'Subcontractor list and key subcontracts reviewed',
    'Lien waivers collected with each payment',
    'Builder’s risk insurance in place from notice to proceed',
    'Mechanical completion and substantial completion tests defined',
    'Prevailing wage and apprenticeship records kept for the tax credits',
    'Safety program and incident history of the EPC contractor',
    'Warranty period of at least two years after substantial completion',
    'Direct agreement with lenders, with step-in rights',
    'Labor availability and union agreements reviewed',
  ]],
  ['Operations and maintenance', null, [
    'O&M agreement with availability guarantee and liquidated damages',
    'Asset management agreement covering reporting and compliance',
    'O&M budget reviewed by the independent engineer',
    'Major maintenance reserve sized for inverter replacement',
    'Monitoring system (SCADA) and data access for lenders',
    'Vegetation management and module cleaning plan',
    'Spare parts list and storage arrangements',
    'Cybersecurity of the plant controls reviewed',
    'Replacement of the O&M contractor possible on default',
    'Performance reporting matches the financing’s covenants',
  ]],
  ['Energy yield and performance', null, [
    'Independent energy yield assessment at P50 and P99 (1-year and 10-year)',
    'Irradiance data source and length of record reviewed',
    'Losses assumed (soiling, snow, clipping, availability) reviewed',
    'Degradation rate consistent with the module warranty',
    'Bifacial gain assumptions supported by site albedo data',
    'Base case model uses the IE’s P50, not the sponsor’s',
    'Capacity test procedure agreed with the EPC contractor',
    'Curtailment and basis risk reflected in the base case',
    'Battery augmentation plan where storage is co-located',
    'Sensitivities run on the IE’s downside cases',
  ]],
  ['Offtake', null, [
    'PPA executed with an investment-grade offtaker, or credit support given',
    'PPA price, escalator and term match the model',
    'Settlement point and basis risk understood',
    'Guaranteed COD and the cure period before termination',
    'Output guarantee and its liquidated damages',
    'Curtailment compensation for economic and grid curtailment',
    'Change in law and tariff pass-through provisions',
    'Assignment to lenders permitted, with a consent to assignment',
    'Termination payments and the offtaker’s security',
    'Environmental attributes (RECs) conveyed as the model assumes',
    'Hedge or merchant tail assumptions reviewed by the market consultant',
    'Collateral posting obligations of the project under the PPA',
  ]],
  ['Insurance', null, [
    'Insurance consultant’s report on the construction and operating programs',
    'Property insurance covers hail at the site’s exposure',
    'Business interruption cover sized for debt service',
    'Lenders named as additional insured and loss payee',
    'Deductibles within the levels the base case can carry',
    'Delay in start-up cover during construction',
    'Insurers rated A- or better',
    'Non-vitiation clause in favor of the lenders',
  ]],
  ['Tax equity and incentives', null, [
    'Eligibility for the investment or production tax credit confirmed by tax counsel',
    'Prevailing wage and apprenticeship requirements met',
    'Domestic content bonus supported by the supplier certifications',
    'Energy community bonus supported by the site’s location',
    'Beginning of construction established for the credit year',
    'Tax equity partnership flip structure and its cash sweep',
    'Transferability sale terms and the buyer’s indemnity',
    'Recapture risk on a change of ownership reviewed',
    'Depreciation (MACRS) and the basis step-up reviewed',
    'State incentives and any clawback terms',
  ]],
];

// What the model takes as not an item: kept, shown, and offered to bring in
export const NOT_TAKEN = [
  'Proseware Solar — Technical due diligence checklist',
  'Draft for discussion · Confidential',
  'Items marked with an asterisk are conditions precedent to financial close.',
  'Page 2 of 6',
  'Page 3 of 6',
  'Page 4 of 6',
  '*  Independent engineer engaged, with its scope agreed by the lenders',
];
/** the lines left out, in the order they sit in the text */
export const LEFT_OUT = [0, 1, 2, 3, 6, 4, 5].map((i) => NOT_TAKEN[i]);

/** the pasted text, line by line: headings numbered, items lettered, some items wrapped, footers between pages */
export function pastedLines(): string[] {
  const out: string[] = [NOT_TAKEN[0], NOT_TAKEN[1], '', NOT_TAKEN[2], '']; let sec = 0; let lastSec = ''; let n = 0; let page = 2;
  let k = 0;
  for (const [s, sub, items] of SECTIONS) {
    if (s !== lastSec) { sec++; k = 0; out.push('', `${sec}. ${s}`); lastSec = s; }
    if (sub) out.push(`   ${sub}`);
    items.forEach((t) => {
      const tag = `   ${sec}.${++k}`; n++;
      // a long item wraps, as a copy from a Word document often does
      if (t.length > 72) { const cut = t.lastIndexOf(' ', 60); out.push(`${tag}  ${t.slice(0, cut)}`, `        ${t.slice(cut + 1)}`); } else out.push(`${tag}  ${t}`);
      if (n % 30 === 0 && page <= 4) out.push('', `Page ${page++} of 6`, '');
    });
  }
  out.splice(60, 0, NOT_TAKEN[6]);
  return out;
}
export const ITEMS = SECTIONS.flatMap(([s, sub, items]) => items.map((t) => ({ s, sub: sub ?? '', t })));

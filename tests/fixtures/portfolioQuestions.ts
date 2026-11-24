// The consolidated Q&A log for a renewable portfolio. Each asset has requests covering several reporting periods.
export const PORTFOLIO_ASSETS = [
  'Contoso Solar', 'Wingtip Wind', 'Woodgrove Storage', 'Litware Solar', 'Tailspin Wind', 'Adatum Storage',
  'Northwind Solar', 'Trey Wind', 'Coho Solar', 'Relecloud Storage', 'Lucerne Solar', 'Alpine Wind',
];
const ASKS = [
  (asset: string) => `Provide the executed EPC contract for ${asset}, with all amendments and change orders.`,
  (asset: string) =>
    `Confirm whether the interconnection agreement for ${asset} has been assigned to the project company.`,
  (asset: string) =>
    `What is the P50 net capacity factor assumed for ${asset}, and who prepared the energy yield report?`,
  (asset: string) =>
    `Provide the PPA for ${asset}, including the offtaker's credit support and any termination notices.`,
  (asset: string) => `List all permits held for ${asset} and confirm none are subject to appeal.`,
  (asset: string) => `Describe any liquidated damages paid or claimed under the ${asset} construction contract.`,
  (asset: string) => `Provide the title report and survey for the ${asset} site.`,
  (asset: string) => `Has ${asset} experienced any curtailment above 3% in the last 24 months?`,
  (asset: string) => `Provide the O&M agreement for ${asset} and the last 12 monthly performance reports.`,
  (asset: string) => `Confirm the tax equity flip date and current partnership allocations for ${asset}.`,
  (asset: string) => `What insurance claims have been made for ${asset} since COD?`,
  (asset: string) => `Provide the decommissioning plan and bond for ${asset}.`,
  (asset: string) => `Confirm whether any lender consents are needed for the sale of ${asset}.`,
  (asset: string) => `Provide the land lease for ${asset}, with the rent schedule and extension options.`,
  (asset: string) => `Is there any pending or threatened litigation involving ${asset}?`,
  (asset: string) => `Provide the warranty schedule for the major equipment at ${asset}.`,
  (asset: string) => `Describe the environmental studies performed at ${asset} and any open remediation.`,
  (asset: string) => `Provide the operating budget for ${asset} for FY2026 and actuals for FY2024 and FY2025.`,
];
const PERIODS = [
  'FY2024', 'FY2025', 'H1 2026', 'Q3 2026', 'the hold period', 'the construction period', 'the first operating year',
  'the last refinancing', 'the sale process', 'the current fiscal year', 'the budget year',
];

/** Twelve assets, eighteen requests and eleven reporting periods give 2,376 distinct questions. */
export function portfolioQuestions(): string[] {
  const questions: string[] = [];
  for (const period of PERIODS) {
    for (const asset of PORTFOLIO_ASSETS) {
      for (const ask of ASKS) {
        questions.push(ask(asset).replace(/[.?]$/, (punctuation) => ` (for ${period})${punctuation}`));
      }
    }
  }
  return questions;
}

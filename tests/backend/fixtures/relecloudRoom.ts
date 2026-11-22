// A generated but realistic US renewables data room of 1,779 files, as paths only: the core-set scale test's room
// (docs/core-documents-design.md). Material contracts with amendments, exhibits, notices and numbered drafts; financing
// drafts in dated folders with blacklines; another project's precedents; correspondence, Q&A exports and site photos.
const P: string[] = []; const add = (p: string) => P.push(p);
const pad = (n: number) => String(n).padStart(2, '0');
const months: string[] = []; for (let y = 2023; y <= 2025; y++) for (let m = 1; m <= 12; m++) months.push(`${y}-${pad(m)}`);
// 01 Corporate
for (const e of ['Relecloud Holdings LLC', 'Relecloud Project LLC', 'Relecloud Pledgor LLC', 'Relecloud Class B Member LLC']) {
  for (const d of ['Certificate of Formation', 'LLC Agreement', 'Amended and Restated LLC Agreement', 'Good Standing Certificate 2024', 'Good Standing Certificate 2025', 'Incumbency Certificate', 'Officer Certificate', 'W-9'])
    add(`01 Corporate/${e}/${d} - ${e}.pdf`);
  for (let i = 1; i <= 6; i++) add(`01 Corporate/${e}/Board Resolutions/Written Consent of Board ${months[i * 5]}.pdf`);
}
add('01 Corporate/Organizational Chart.pdf');
// 02 Material Contracts
const contract = (dir: string, name: string, short: string, n: { amend?: number; exh?: number; notices?: number; ver?: number } = {}) => {
  add(`02 Material Contracts/${dir}/${name}.pdf`);
  for (let i = 1; i <= (n.amend ?? 2); i++) add(`02 Material Contracts/${dir}/Amendment No ${i} to ${name}.pdf`);
  for (const x of 'ABCDEFGH'.slice(0, n.exh ?? 6)) add(`02 Material Contracts/${dir}/Exhibits/${short} Exhibit ${x}.pdf`);
  for (let i = 1; i <= (n.notices ?? 10); i++) add(`02 Material Contracts/${dir}/Notices/Notice ${pad(i)} ${months[i % 36]}.pdf`);
  add(`02 Material Contracts/${dir}/Consent to Collateral Assignment - ${short}.pdf`);
  add(`02 Material Contracts/${dir}/Estoppel Certificate - ${short}.pdf`);
  if (n.ver) for (let v = 1; v <= n.ver; v++) add(`02 Material Contracts/${dir}/Drafts/${short} v${v}.docx`);
};
contract('PPA', 'Power Purchase Agreement', 'PPA', { amend: 3, exh: 8, notices: 30, ver: 6 });
contract('EPC', 'EPC Contract', 'EPC', { amend: 6, exh: 8, notices: 25 });
for (let i = 1; i <= 80; i++) add(`02 Material Contracts/EPC/Change Orders/Change Order No ${i}.pdf`);
for (const m of months.slice(0, 24)) add(`02 Material Contracts/EPC/Monthly Reports/Monthly Construction Report ${m}.pdf`);
contract('O&M', 'Operation and Maintenance Agreement', 'O&M', { amend: 2, exh: 5, notices: 10 });
for (const m of months) add(`02 Material Contracts/O&M/Monthly Reports/O&M Monthly Report ${m}.pdf`);
contract('Interconnection', 'Large Generator Interconnection Agreement', 'LGIA', { amend: 2, exh: 6, notices: 8 });
for (const s of ['Feasibility Study', 'System Impact Study', 'Facilities Study', 'Interconnection Request']) add(`02 Material Contracts/Interconnection/Studies/${s}.pdf`);
for (let i = 1; i <= 30; i++) add(`02 Material Contracts/Interconnection/Invoices/Invoice ${i}.pdf`);
contract('Module Supply', 'Module Supply Agreement', 'MSA', { amend: 2, exh: 6, notices: 5 });
for (let i = 1; i <= 50; i++) add(`02 Material Contracts/Module Supply/Shipments/Bill of Lading ${i}.pdf`);
contract('Inverter', 'Inverter Supply Agreement', 'ISA', { amend: 1, exh: 4, notices: 3 });
add('02 Material Contracts/Inverter/Inverter Warranty.pdf');
contract('LTSA', 'Long-Term Service Agreement', 'LTSA', { amend: 1, exh: 4, notices: 3 });
for (const [d, n, s] of [['Asset Management', 'Asset Management Agreement', 'AMA'], ['Admin Services', 'Administrative Services Agreement', 'ASA'], ['RECs', 'REC Purchase Agreement', 'REC'], ['Tax Abatement', 'PILOT Agreement', 'PILOT'], ['Community', 'Community Benefits Agreement', 'CBA']])
  contract(d, n, s, { amend: 1, exh: 3, notices: 3 });
// 03 Real Estate
const owners = ['Parcel A', 'Parcel B', 'Parcel C', 'Parcel D', 'Parcel E', 'Parcel F', 'Parcel G', 'Parcel H', 'Parcel I', 'Parcel J'];
for (let i = 1; i <= 110; i++) {
  const o = owners[i % 10];
  add(`03 Real Estate/Leases/Parcel ${i}/Solar Lease Agreement - Parcel ${i} (${o}).pdf`);
  add(`03 Real Estate/Leases/Parcel ${i}/Memorandum of Lease - Parcel ${i}.pdf`);
  add(`03 Real Estate/Leases/Parcel ${i}/Title Commitment - Parcel ${i}.pdf`);
}
for (let i = 1; i <= 60; i++) add(`03 Real Estate/Easements/Transmission Easement ${i} (${owners[i % 10]}).pdf`);
for (let i = 1; i <= 20; i++) add(`03 Real Estate/Survey/ALTA Survey Sheet ${i}.pdf`);
add('03 Real Estate/Title/Title Insurance Policy (Pro Forma).pdf'); add('03 Real Estate/Title/Title Report Summary.pdf');
// 04 Permits
const permits = ['Building Permit', 'Grading Permit', 'Electrical Permit', 'Road Use Permit', 'Driveway Permit', 'Stormwater Permit', 'Crossing Permit'];
for (let i = 1; i <= 150; i++) add(`04 Permits/Local/${permits[i % 7]} ${i}.pdf`);
for (const p of ['Conditional Use Permit', 'Zoning Approval', 'Air Permit', 'Section 404 Permit', 'FAA Determination of No Hazard', 'SWPPP', 'Water Rights Certificate', 'Decommissioning Plan'])
  add(`04 Permits/Major/${p}.pdf`);
for (const p of ['FERC MBR Order', 'QF Self-Certification Form 556', 'NERC Registration', 'EWG Notice']) add(`04 Permits/Regulatory/${p}.pdf`);
// 05 Financing: drafts in dated folders, blacklines, precedents
const fin = ['Credit Agreement', 'Common Terms Agreement', 'Intercreditor Agreement', 'Security Agreement', 'Pledge Agreement', 'Depositary Agreement', 'Equity Contribution Agreement', 'ISDA Schedule', 'Fee Letter', 'Term Sheet', 'Tax Equity LLC Agreement', 'Guaranty'];
for (const d of ['2025-01-15', '2025-02-20', '2025-03-30', '2025-05-02']) for (const f of fin) { add(`05 Financing/Drafts/${d}/${f}.docx`); add(`05 Financing/Drafts/${d}/${f} (blackline).pdf`); }
for (const f of fin) add(`05 Financing/Precedents/Project Coho ${f}.pdf`);
add('05 Financing/Credit Agreement redline against Project Coho.pdf');
// 06 Reports
for (const r of ['Independent Engineer Report', 'Insurance Consultant Report', 'Market Consultant Report', 'Phase I Environmental Site Assessment', 'Environmental Impact Assessment', 'Energy Yield Assessment', 'Model Audit Report', 'Legal Due Diligence Report', 'Tax Due Diligence Report', 'Appraisal'])
  add(`06 Reports/${r}.pdf`);
for (const s of ['Wetlands Delineation', 'Cultural Resources Survey', 'Avian Study', 'Bat Study', 'Glare Study', 'Noise Study', 'Visual Impact Study', 'Threatened Species Survey', 'Phase II ESA', 'Floodplain Study', 'Traffic Study', 'Drainage Study'])
  add(`06 Reports/Environmental Studies/${s}.pdf`);
for (let i = 1; i <= 12; i++) add(`06 Reports/Geotechnical/Geotechnical Report Boring ${i}.pdf`);
// 07 Financial Model: versions in one folder
for (let v = 1; v <= 14; v++) add(`07 Financial Model/Base Case Financial Model v${v}.xlsx`);
add('07 Financial Model/Model Assumptions Book.pdf'); add('07 Financial Model/Construction Budget.xlsx'); add('07 Financial Model/Construction Schedule.pdf');
// 08 Insurance
for (const p of ["Builder's Risk Insurance Policy", 'Property Insurance Policy', 'Business Interruption Insurance Policy', 'General Liability Policy', 'Umbrella Policy']) add(`08 Insurance/Policies/${p}.pdf`);
for (let i = 1; i <= 40; i++) add(`08 Insurance/Certificates/Certificate of Insurance ${i}.pdf`);
// 09 Financials
for (const m of months) add(`09 Financials/Monthly Operating Report ${m}.pdf`);
for (const y of [2022, 2023, 2024]) { add(`09 Financials/Audited Financial Statements ${y}.pdf`); add(`09 Financials/Annual Budget ${y}.xlsx`); }
// 10 Tax
for (let i = 1; i <= 40; i++) add(`10 Tax/Property Tax/Property Tax Bill ${i}.pdf`);
add('10 Tax/Tax Opinion.pdf'); add('10 Tax/ITC Eligibility Memo.pdf'); add('10 Tax/Cost Segregation Report.pdf');
// 11 Legal
for (const l of ['Legal Opinion - Borrower Counsel', 'Legal Opinion - Local Counsel', 'Litigation Summary', 'Sanctions and Anti-Corruption Certificate']) add(`11 Legal/${l}.pdf`);
for (let i = 1; i <= 10; i++) add(`11 Legal/Litigation/Complaint ${i}.pdf`);
// 12 Policies (HR / compliance)
for (const p of ['Anti-Bribery Policy', 'Sanctions Policy', 'Code of Conduct', 'Health and Safety Policy', 'Environmental Policy', 'Insurance Procedures', 'Travel Policy', 'IT Security Policy', 'Whistleblower Policy', 'Data Privacy Policy'])
  add(`12 Compliance/${p}.pdf`);
// 13 Correspondence
const topics = ['interconnection delay', 'PPA price adjustment', 'EPC schedule', 'module delivery', 'lease payment', 'permit renewal', 'insurance claim', 'tax assessment', 'lender consent', 'default notice'];
for (let i = 1; i <= 250; i++) add(`13 Correspondence/${months[i % 36]}/Letter re ${topics[i % 10]} ${i}.pdf`);
// 14 Q&A and 15 Photos
for (let i = 1; i <= 20; i++) add(`14 Q&A/Q&A Log Export ${i}.xlsx`);
for (let i = 1; i <= 120; i++) add(`15 Site Photos/IMG_${String(i).padStart(4, '0')}.jpg`);
export const paths = P.map((p) => `Relecloud VDR/${p}`);

// A realistic solar-plus-storage project-finance data room, by path, for prototyping part 2 (complete families).
const out: string[] = [];
const add = (...p: string[]) => out.push(...p);
const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const months = (y0: number, m0: number, n: number) => Array.from({ length: n }, (_, i) => { const m = m0 - 1 + i; return { y: y0 + Math.floor(m / 12), m: (m % 12) + 1 }; });
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 01 Corporate
add('01 Corporate/Certificate of Formation - Wingtip Solar LLC.pdf', '01 Corporate/LLC Agreement of Wingtip Solar LLC (executed).pdf',
  '01 Corporate/First Amendment to LLC Agreement.pdf', '01 Corporate/Second Amendment to LLC Agreement.pdf', '01 Corporate/LLC Agreement - Exhibit A - Members and Units.pdf',
  '01 Corporate/Organizational Chart.pdf', '01 Corporate/Incumbency Certificate.pdf', '01 Corporate/Officer Certificate.pdf');
for (const s of ['Delaware', 'Texas', 'California']) add(`01 Corporate/Good Standing/Certificate of Good Standing - ${s}.pdf`);
for (const { y, m } of months(2023, 1, 36)) add(`01 Corporate/Board Minutes/Board Minutes ${y}-${String(m).padStart(2, '0')}-15.pdf`);
for (const n of ['Written Consent of Members - Financing', 'Written Consent of Members - Tax Equity', 'Board Resolutions - EPC Award']) add(`01 Corporate/Resolutions/${n}.pdf`);
for (let i = 1; i <= 14; i++) add(`01 Corporate/KYC/KYC Questionnaire - Investor ${i}.pdf`);

// 02 Offtake
add('02 Offtake/PPA/Power Purchase Agreement (executed).pdf', '02 Offtake/PPA/First Amendment to Power Purchase Agreement.pdf', '02 Offtake/PPA/PPA Amendment No. 2.pdf',
  '02 Offtake/PPA/Side Letter re PPA - Curtailment.pdf', '02 Offtake/PPA/PPA Redline v6 to v5.pdf');
for (const [i, t] of ['Site Description', 'Facility Description', 'Contract Price', 'Milestones', 'Form of Letter of Credit', 'Metering', 'Insurance Requirements', 'Form of Consent to Assignment'].entries()) add(`02 Offtake/PPA/Exhibits/Exhibit ${L[i]} - ${t}.pdf`);
for (const d of ['2024-09-10', '2024-11-02', '2025-01-20']) add(`02 Offtake/PPA/Drafts/${d}/Power Purchase Agreement.docx`);
add('02 Offtake/REC/REC Purchase Agreement.pdf', '02 Offtake/REC/REC Purchase Agreement - Schedule 1 - Pricing.pdf', '02 Offtake/REC/REC Purchase Agreement - Schedule 2 - Delivery.pdf');
add('02 Offtake/Hedge/ISDA Master Agreement.pdf', '02 Offtake/Hedge/Schedule to the ISDA Master Agreement.pdf', '02 Offtake/Hedge/Credit Support Annex.pdf');
for (let i = 1; i <= 12; i++) add(`02 Offtake/Hedge/Confirmations/Confirmation - Trade ${1000 + i}.pdf`);
add('02 Offtake/Market Study - ERCOT West.pdf', '02 Offtake/Offtake Term Sheet.pdf');

// 03 Construction
add('03 Construction/EPC/EPC Contract (execution version).pdf', '03 Construction/EPC/EPC Contract - First Amendment.pdf', '03 Construction/EPC/EPC Contract - Second Amendment.pdf',
  '03 Construction/EPC/Parent Company Guarantee - EPC Contractor.pdf', '03 Construction/EPC/Construction Schedule.pdf', '03 Construction/EPC/Payment Schedule.xlsx');
const EPCS = ['Scope of Work', 'Technical Specifications', 'Contract Price', 'Payment Schedule', 'Milestone Schedule', 'Performance Guarantees', 'Liquidated Damages', 'Testing and Commissioning', 'Key Personnel', 'Subcontractors', 'Insurance', 'Form of Performance Bond', 'Form of Lien Waiver', 'Permits', 'Site Conditions', 'Interconnection Interface', 'Spare Parts', 'Training', 'Warranties', 'Drawings List', 'Quality Plan', 'HSE Plan'];
EPCS.forEach((t, i) => { add(`03 Construction/EPC/Schedules/Schedule ${i + 1} - ${t}.pdf`); });
for (let i = 0; i < 13; i++) add(`03 Construction/EPC/Exhibits/EPC Exhibit ${L[i]}.pdf`);
for (let i = 1; i <= 48; i++) add(`03 Construction/EPC/Change Orders/Change Order No. ${pad(i)}.pdf`);
for (const { y, m } of months(2024, 3, 20)) add(`03 Construction/Monthly Construction Reports/${y}-${String(m).padStart(2, '0')}/Monthly Construction Report.pdf`);
add('03 Construction/Module Supply/Module Supply Agreement.pdf', '03 Construction/Module Supply/Module Supply Agreement v3.docx', '03 Construction/Module Supply/Module Supply Agreement v4.docx');
for (let i = 1; i <= 6; i++) add(`03 Construction/Module Supply/Annex ${i} - ${['Specifications', 'Delivery Schedule', 'Price', 'Warranty', 'Factory Testing', 'Form of Guarantee'][i - 1]}.pdf`);
for (let i = 1; i <= 60; i++) add(`03 Construction/Module Supply/Flash Test Reports/Flash Test Report - Batch ${pad(i, 2)}.pdf`);
add('03 Construction/BESS/Battery Supply Agreement.pdf', '03 Construction/BESS/Long-Term Service Agreement - BESS.pdf');
for (let i = 0; i < 6; i++) add(`03 Construction/BESS/Battery Supply Agreement - Appendix ${L[i]}.pdf`);
add('03 Construction/Notices to Proceed/Limited Notice to Proceed No. 1.pdf', '03 Construction/Notices to Proceed/Limited Notice to Proceed No. 2.pdf', '03 Construction/Notices to Proceed/Full Notice to Proceed.pdf');
for (let i = 1; i <= 2; i++) add(`03 Construction/Phase ${i} BOP Contract.pdf`);
add('03 Construction/Interconnection/Large Generator Interconnection Agreement.pdf', '03 Construction/Interconnection/System Impact Study.pdf', '03 Construction/Interconnection/Facilities Study.pdf');
for (let i = 0; i < 7; i++) add(`03 Construction/Interconnection/LGIA Appendix ${L[i]}.pdf`);
for (let i = 1; i <= 24; i++) add(`03 Construction/Daily Logs/Week ${i}/Site Log.pdf`);

// 04 Real Estate
for (let i = 1; i <= 120; i++) add(`04 Real Estate/Leases/Lease Agreement - Parcel ${pad(i)}.pdf`, `04 Real Estate/Memoranda/Memorandum of Lease - Parcel ${pad(i)}.pdf`, `04 Real Estate/Title/Title Commitment - Parcel ${pad(i)}.pdf`);
for (let i = 1; i <= 15; i++) add(`04 Real Estate/Leases/Amendment to Lease - Parcel ${pad(i)}.pdf`);
for (let i = 1; i <= 40; i++) add(`04 Real Estate/Survey/ALTA Survey Sheet ${i}.pdf`);
for (let i = 1; i <= 18; i++) add(`04 Real Estate/Easements/Easement Agreement - Tract ${i}.pdf`);
add('04 Real Estate/Phase I Environmental Site Assessment.pdf', '04 Real Estate/Title Summary.xlsx', '04 Real Estate/Real Estate Memo.docx');

// 05 Permits
add('05 Permits/Conditional Use Permit.pdf', '05 Permits/Stormwater Pollution Prevention Plan.pdf', '05 Permits/Wetlands Delineation Report.pdf', '05 Permits/Permit Matrix.xlsx');
for (let i = 1; i <= 30; i++) add(`05 Permits/Building Permits/Building Permit - Inverter Pad ${i}.pdf`);

// 06 Financing
add('06 Financing/Credit Agreement/Credit Agreement (conformed).pdf', '06 Financing/Credit Agreement/Amendment No. 1 to Credit Agreement.pdf', '06 Financing/Credit Agreement/Amendment No. 2 to Credit Agreement.pdf',
  '06 Financing/Credit Agreement/Amended and Restated Credit Agreement.pdf', '06 Financing/Credit Agreement/Fee Letter.pdf');
for (let i = 0; i < 18; i++) add(`06 Financing/Credit Agreement/Exhibits/Exhibit ${L[i]} - Form of ${['Note', 'Notice of Borrowing', 'Compliance Certificate', 'Assignment and Assumption', 'Drawdown Certificate', 'Solvency Certificate', 'Legal Opinion', 'Joinder', 'Officer Certificate', 'Interest Election', 'Prepayment Notice', 'LC Request', 'Construction Budget', 'Tax Certificate', 'Perfection Certificate', 'Intercompany Note', 'Guarantee', 'Consent'][i]}.pdf`);
for (const s of ['1.1(a) Commitments', '1.1(b) Project Documents', '3.1 Conditions Precedent', '5.8 Litigation', '5.12 Real Property', '6.9 Insurance']) add(`06 Financing/Credit Agreement/Schedules/Schedule ${s}.pdf`);
add('06 Financing/Security/Security Agreement.pdf', '06 Financing/Security/Pledge Agreement.pdf', '06 Financing/Security/Depositary Agreement.pdf', '06 Financing/Security/Mortgage - Texas.pdf');
for (const c of ['EPC Contract', 'PPA', 'O&M Agreement', 'Module Supply Agreement']) add(`06 Financing/Direct Agreements/Consent and Agreement - ${c}.pdf`);
add('06 Financing/Intercreditor Agreement.pdf', '06 Financing/Tax Equity/Equity Capital Contribution Agreement.pdf', '06 Financing/Tax Equity/Amended and Restated LLC Agreement - TE Partnership.pdf',
  '06 Financing/Tax Equity/ECCA Schedule 1 - Conditions Precedent.pdf', '06 Financing/Tax Equity/Guaranty - Sponsor.pdf');
for (const o of ['Borrower Counsel', 'Local Counsel Texas', 'Regulatory Counsel', 'Tax Counsel']) add(`06 Financing/Opinions/Legal Opinion - ${o}.pdf`);
for (let i = 1; i <= 18; i++) add(`06 Financing/Borrowings/Notice of Borrowing No. ${i}.pdf`);
add('06 Financing/Funds Flow Memo.xlsx', '06 Financing/Closing Checklist.docx');

// 07 Operations
add('07 Operations/O&M Agreement.pdf', '07 Operations/O&M Agreement - Schedule A - Services.pdf', '07 Operations/O&M Agreement - Schedule B - Fees.pdf', '07 Operations/Asset Management Agreement.pdf');
for (const { y, m } of months(2025, 1, 12)) add(`07 Operations/Monthly Operating Reports/Monthly Operating Report - ${MON[m - 1]} ${y}.pdf`);
for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) add(`07 Operations/Availability Report ${q} 2025.pdf`);

// 08 Insurance
add('08 Insurance/Builders Risk Policy.pdf', '08 Insurance/Operational All Risk Policy.pdf', '08 Insurance/General Liability Policy.pdf', '08 Insurance/Insurance Consultant Report.pdf');
for (const y of [2023, 2024, 2025]) add(`08 Insurance/Certificates/Certificate of Insurance ${y}.pdf`);

// 09 Technical
add('09 Technical/Independent Engineer Report.pdf', '09 Technical/Energy Yield Assessment v1.pdf', '09 Technical/Energy Yield Assessment v2.pdf', '09 Technical/Energy Yield Assessment v3.pdf', '09 Technical/Geotechnical Report.pdf');
for (let i = 1; i <= 24; i++) add(`09 Technical/IE Monitoring/IE Construction Monitoring Report No. ${i}.pdf`);
for (let i = 1; i <= 12; i++) add(`09 Technical/Drawings/Single Line Diagram Sheet ${i}.pdf`);

// 10 Financial
for (let v = 12; v <= 18; v++) add(`10 Financial/Financial Model v${v}.xlsx`);
for (const y of [2021, 2022, 2023, 2024]) add(`10 Financial/Audited Financial Statements ${y}.pdf`);
for (const y of [2022, 2023, 2024, 2025]) add(`10 Financial/Tax Returns/Federal Tax Return ${y}.pdf`);
add('10 Financial/Construction Budget.xlsx', '10 Financial/Model Audit Report.pdf');

// 11 Precedents, 12 Q&A
add(
  '11 Precedents/Adatum Wind PPA.pdf',
  '11 Precedents/Adatum Wind PPA - Exhibit A.pdf',
  '11 Precedents/Precedent EPC Contract.pdf',
);
add('12 Q&A/Q&A Tracker.xlsx', '12 Q&A/Due Diligence Request List.xlsx');

// filler that real rooms carry: photos and site correspondence, by date
for (const { y, m } of months(2024, 1, 24)) for (let d = 1; d <= 20; d++) add(`13 Correspondence/${y}/${MON[m - 1]}/Letter ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}.pdf`);
export const ROOM = out;

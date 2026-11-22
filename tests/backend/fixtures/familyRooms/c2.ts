const a: string[] = [];
// two agreements in one folder, unnamed schedules
a.push('Project Docs/Operations/O&M Agreement.pdf','Project Docs/Operations/Asset Management Agreement.pdf','Project Docs/Operations/Schedule 1.pdf','Project Docs/Operations/Schedule 2.pdf','Project Docs/Operations/Schedule 3.pdf');
// Schedules folder at root, far from agreement
for (let i=1;i<=12;i++) a.push(`Disclosure Schedules/Schedule ${i}.pdf`);
a.push('Finance/Loan Docs/Credit Agreement.pdf');
// deep nesting: 3 down
for (let i=1;i<=5;i++) a.push(`Construction/EPC/Contract Documents/Schedules/Part 2/Schedule ${i} - Spec.pdf`);
a.push('Construction/EPC/EPC Contract.pdf');
// schedules in counterparty folder
a.push('Turbines/Turbine Supply Agreement - Fabrikam.pdf');
for (let i = 1; i <= 4; i++) a.push(`Turbines/Fabrikam/Schedule ${i}.pdf`);
// WTG reports
for (let i=1;i<=45;i++) a.push(`Technical/Commissioning/WTG ${String(i).padStart(2,'0')} Commissioning Report.pdf`);
for (let i=1;i<=45;i++) a.push(`Technical/Substantial Completion/WTG${String(i).padStart(2,'0')} - Substantial Completion Certificate.pdf`);
// distinct docs that look like series
a.push('Corporate/Director Resignation - J Roe.pdf');
a.push('Finance/Hedging/Interest Rate Swap Confirmation 1.pdf','Finance/Hedging/Interest Rate Swap Confirmation 2.pdf','Finance/Hedging/Interest Rate Swap Confirmation 3.pdf');
a.push('Offtake/Phase 1 PPA.pdf','Offtake/Phase 2 PPA.pdf','Offtake/Phase 3 PPA.pdf');
a.push('Finance/Security/Pledge Agreement - HoldCo 1.pdf','Finance/Security/Pledge Agreement - HoldCo 2.pdf','Finance/Security/Pledge Agreement - HoldCo 3.pdf');
a.push('Finance/Fee Letter 1.pdf','Finance/Fee Letter 2.pdf','Finance/Fee Letter 3.pdf');
a.push('Grid/Interconnection Agreement 2023.pdf','Grid/Interconnection Agreement 2024.pdf','Grid/Interconnection Agreement 2025.pdf');
a.push('Tax/Tax Equity Term Sheet 2023-01-05.pdf','Tax/Tax Equity Term Sheet 2023-02-09.pdf','Tax/Tax Equity Term Sheet 2023-03-11.pdf');
a.push('Reports/Independent Engineer Report Phase 1.pdf','Reports/Independent Engineer Report Phase 2.pdf','Reports/Independent Engineer Report Phase 3.pdf');
a.push('Corp/Certificate of Incorporation - ProjectCo 1 Inc.pdf','Corp/Certificate of Incorporation - ProjectCo 2 Inc.pdf','Corp/Certificate of Incorporation - ProjectCo 3 Inc.pdf');
a.push('Land/Option Agreement 1.pdf','Land/Title Commitment 12345.pdf','Land/Title Commitment 67890.pdf','Land/Title Commitment 11111.pdf');
a.push('Finance/Letter of Credit No. 1.pdf','Finance/Letter of Credit No. 2.pdf','Finance/Letter of Credit No. 3.pdf');
a.push('Finance/Direct Agreement 1.pdf');
export const ROOM = a;

const a: string[] = [
 'Contracts/EPC Contract.pdf','Contracts/O&M Agreement.pdf','Contracts/Interconnection Agreement.pdf','Contracts/Site Lease.pdf','Contracts/Exhibit A.pdf','Contracts/Schedule 1.pdf',
 'Financing/Fee Letter.pdf','Financing/Intercreditor Agreement.pdf','Financing/Account Control Agreement.pdf','Financing/Depositary Agreement.pdf',
 'Financing/Credit Agreement/Credit Agreement.pdf','Financing/Disclosure Schedules/Schedule 3.05.pdf',
 'Real Estate/Estoppels/Estoppel Certificate - Landowner 1.pdf','Real Estate/Estoppels/Estoppel Certificate - Landowner 2.pdf','Real Estate/Estoppels/Estoppel Certificate - Landowner 3.pdf',
 'Consents/Consent to Assignment - Offtaker 1.pdf','Consents/Consent to Assignment - Offtaker 2.pdf','Consents/Consent to Assignment - Offtaker 3.pdf',
 'Tax Equity/Investor Consent 1.pdf','Tax Equity/Investor Consent 2.pdf','Tax Equity/Investor Consent 3.pdf',
 'NTP/Notice to Proceed 1.pdf','NTP/Notice to Proceed 2.pdf','NTP/Notice to Proceed 3.pdf',
 'Opinions/Opinion of Counsel 1.pdf','Insurance/Certificate of Insurance 2023.pdf','Insurance/Certificate of Insurance 2024.pdf','Insurance/Certificate of Insurance 2025.pdf',
 'Interconnection/Queue Position Q123.pdf','Interconnection/Queue Position Q456.pdf','Interconnection/Queue Position Q789.pdf',
 'Construction/Construction Agreement.pdf',
];
for (let i=1;i<=60;i++) a.push(`Construction/Lien Waivers/Conditional Lien Waiver No. ${i}.pdf`);
for (let i=1;i<=36;i++) a.push(`Construction/Monthly Reports/Monthly Report No. ${i} - Appendix A.pdf`);
for (let i=1;i<=24;i++) a.push(`Construction/Pay Apps/Pay Application ${i} - Attachment 1.pdf`);
export const ROOM = a;

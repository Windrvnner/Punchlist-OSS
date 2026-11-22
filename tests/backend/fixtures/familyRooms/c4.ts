const a: string[] = [];
a.push('Wingtip VDR/Credit Agreement.pdf','Wingtip VDR/Contribution Agreement.pdf','Wingtip VDR/Project Overview.pdf');
for (let i=1;i<=40;i++) a.push(`Wingtip VDR/Schedules/Schedule ${i} - ${['Insurance','Permits','Real Property','Litigation','Environmental'][i%5]} ${i}.pdf`);
for (let i=1;i<=30;i++) a.push(`Wingtip VDR/Exhibits/Exhibit 10.${i}.pdf`);
a.push('Wingtip VDR/03 Construction/EPC/EPC Contract.pdf','Wingtip VDR/03 Construction/Phase 1 BOP Contract.pdf','Wingtip VDR/03 Construction/Phase 2 BOP Contract.pdf');
for (const x of 'ABCDE') a.push(`Wingtip VDR/03 Construction/EPC Exhibits/Exhibit ${x}.pdf`);
// operating reports that carry a relation word
for (let i=1;i<=6;i++) a.push(`Wingtip VDR/07 Ops/O&M Agreement.pdf`.replace('O&M Agreement', i===1?'O&M Agreement':'x'+i));
for (let i=1;i<=12;i++) a.push(`Wingtip VDR/07 Ops/Monthly Report - Appendix ${i}.pdf`);
for (let i=1;i<=12;i++) a.push(`Wingtip VDR/07 Ops/Invoice ${i} - Schedule of Fees.pdf`);
export const ROOM = a;

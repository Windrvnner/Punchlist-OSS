const n: string[] = [];
const pats = ['Schedule One','Ex. A','Ex A - Site Plan','Att. 1','Amdt No. 1','Amend No 1','PCO-01','CO #12','CO-012','Sch3','Exh_A','SCHEDULE_3_PRICE','Exhibit A-1','Annex A-1','Part 2 of Schedule 3','Supp. 1','Supplemental Agreement 1','Letter Agreement No. 1','Change Order Request 3','Schedule 3 (Price)', 'Amendment Agreement 2'];
for (const p of pats) n.push(`X/${p}.pdf`);
// triples to test series
for (const b of ['Ex. ', 'Amdt No. ', 'PCO-0', 'CO #', 'Sch', 'Exhibit A-', 'Supplemental Agreement ', 'Letter Agreement No. ', 'Change Order Request ', 'Schedule ', 'PCO ']) for (let i=1;i<=3;i++) n.push(`Y/${b}${i}.pdf`);
export const ROOM = ['X/Turbine Supply Agreement.pdf', ...n];

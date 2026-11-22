const M=['January','February','March','April','May','June','July','August','September','October','November','December'];
export const ROOM = [
 'Construction/EPC Contract.pdf',
 ...M.map(m=>`Construction/Reports/EPC Monthly Progress Report - ${m} 2025.pdf`),
 'Construction/Reports/Exhibit A - Progress Photos.pdf',
 ...M.map(m=>`Operations/O&M Monthly Report - ${m} 2025.pdf`),
 'Operations/O&M Agreement.pdf',
 'Operations/Schedule 3 - Availability Guarantee.pdf',
 ...['Q1','Q2','Q3','Q4'].map(q=>`Offtake/PPA Quarterly Settlement Statement ${q} 2025.pdf`),
];

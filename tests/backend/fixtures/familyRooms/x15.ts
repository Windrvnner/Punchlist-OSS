export const ROOM = [
 ...['January','February','March'].flatMap(m=>[`Operations/Wind Farm 1/Monthly Operating Report - ${m} 2025.pdf`,`Operations/Wind Farm 2/Monthly Operating Report - ${m} 2025.pdf`]),
 'Operations/Wind Farm 2/Monthly Operating Report - April 2025.pdf',
 ...['Fund I','Fund II','Fund III'].map(f=>`Investors/${f}/Capital Account Statement.pdf`),
];

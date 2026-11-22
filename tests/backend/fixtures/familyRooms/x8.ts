const R:string[]=[];
for(let i=1;i<=1500;i++) R.push(`Data Room/Construction/Daily Reports/EPC Daily Report - ${String(1+(i%28)).padStart(2,'0')}-${String(1+(i%12)).padStart(2,'0')}-${2020+Math.floor(i/336)} #${i}.pdf`);
for(let i=1;i<=1500;i++) R.push(`Data Room/Construction/Daily Reports/Attachment ${i} - Site Photos.pdf`);
export const ROOM=R;

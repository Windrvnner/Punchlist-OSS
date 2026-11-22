const R:string[]=[]; const deep='Data Room/'+Array.from({length:12},(_,i)=>`Level ${i} Folder With A Long Descriptive Name Project Relecloud Solar Holdings LLC`).join('/');
for(let i=1;i<=1000;i++) R.push(`${deep}/Agreements/Services Agreement - Vendor ${i} Holdings LLC.pdf`);
for(let i=1;i<=1000;i++) R.push(`${deep}/Agreements/Sub ${i%50}/Exhibit ${i} - Pricing Vendor ${i+7} Holdings.pdf`);
export const ROOM=R;

const a: string[] = [];
for (let i=1;i<=600;i++) a.push(`Real Estate/All/Lease Agreement - Parcel ${i}.pdf`);
for (let i=1;i<=600;i++) a.push(`Real Estate/All/Exhibit A to Lease Agreement - Parcel ${i}.pdf`);
for (let i=1;i<=800;i++) a.push(`Real Estate/All/Amendment No. ${i%3+1} - Parcel ${i}.pdf`);
export const ROOM = a;

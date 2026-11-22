const a: string[] = ['Credit Agreement.pdf'];
for (let i=1;i<=1500;i++) a.push(`Real Estate/Leases/Lease Agreement - Parcel ${i}.pdf`);
for (let i=1;i<=500;i++) a.push(`Disclosure Schedules/Schedule ${Math.floor(i/10)}.${String(i%10).padStart(2,'0')}.pdf`);
export const ROOM = a;

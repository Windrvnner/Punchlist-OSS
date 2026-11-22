import { ROOM as R } from './room';
const a: string[] = [...R.map(p=>'A/'+p), ...R.map(p=>'B/'+p), ...R.map(p=>'C/'+p), ...R.slice(0,700).map(p=>'D/'+p)];
export const ROOM = a;

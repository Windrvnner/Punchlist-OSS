import { ROOM as R } from './room';
const a: string[] = [...R.map(p=>'A/'+p), ...R.map(p=>'B/'+p)];
export const ROOM = a;

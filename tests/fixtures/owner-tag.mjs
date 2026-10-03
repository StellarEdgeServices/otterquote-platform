// gh-2344: the REAL Auth.ownerTag from js/auth.js (extracted, not re-implemented), so tests seed
// cs_auth_role_email with exactly the value the production helper stores (a one-way tag, never the address).
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const authSrc = fs.readFileSync(path.join(root, 'js/auth.js'), 'utf8');
const m = authSrc.match(/  ownerTag\(email\) \{[\s\S]*?\n  \},\n/);
if (!m) throw new Error('js/auth.js does not define Auth.ownerTag');
const Auth = vm.runInNewContext('({' + m[0].replace(/,\s*$/, '') + '})');
export const ownerTag = (email) => Auth.ownerTag(email);
export const authOwnerTagSource = m[0];

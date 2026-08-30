import { hashAdminPassword } from '../src/lib/adminAuth.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
if (password.length < 8) {
  console.error('Admin password must contain at least 8 characters.');
  process.exit(1);
}
console.log(await hashAdminPassword(password));

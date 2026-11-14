// Creates a self-signed certificate in ./certs so phones on your network can use the camera.
// Browsers only allow camera access on HTTPS (or localhost). Requires `openssl` on PATH.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs');
mkdirSync(dir, { recursive: true });

const ips = ['127.0.0.1'];
for (const list of Object.values(networkInterfaces())) {
  for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
}
const san = ['DNS:localhost', ...ips.map((ip) => `IP:${ip}`)].join(',');
const conf = path.join(dir, 'openssl.cnf');
writeFileSync(conf, `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = live5 local
[ext]
subjectAltName = ${san}
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
`);

execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
  '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-config', conf,
], { stdio: 'inherit' });

console.log(`\nCertificate written to ${dir}`);
console.log(`Valid for: ${san.replaceAll('DNS:', '').replaceAll('IP:', '')}`);
console.log('Run `npm start` again; it will serve HTTPS. Phones will warn once — choose to continue.');

// PWP-03: signed.pdf - an approval-signature PDF (adbe.pkcs7.detached, SHA-256) signed with a
// THROWAWAY self-signed certificate created at run time in the OS temp dir and deleted afterwards.
// No key or certificate is written to the repository. Needs `openssl` on PATH.
//   node scripts/pdf-fixtures/make-signed.mjs [--out <dir>]
// Not byte-deterministic (CMS signing time). The result is expected to open in pdf.js with a
// signature field and no error; the certificate is untrusted by design.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rawPdf, stream } from './make-synthetic.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const latin1 = (s) => Buffer.from(s, 'latin1');
const PLACEHOLDER = 8192; // hex chars reserved for the CMS blob

export function makeSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsmd-pdfsig-'));
  try {
    const key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem'), data = path.join(dir, 'd.bin'), sig = path.join(dir, 's.der');
    const env = { ...process.env, MSYS_NO_PATHCONV: '1' }; // keep Git-Bash from rewriting the -subj value
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-subj', '/CN=Fixture Signer/O=VSMD Fixtures/C=NZ'], { stdio: 'pipe', env });
    const content = latin1('BT /F1 18 Tf 56 760 Td (Signed document - approval signature) Tj ET\nBT /F1 11 Tf 56 730 Td (The quick brown fox jumps over the lazy dog.) Tj ET');
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] /SigFlags 3 >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>',
      stream('', content),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 3 0 R /V 7 0 R >>',
      `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (Fixture Signer) /Reason (Fixture) /Location (Auckland) /M (D:20261121000000Z) /ByteRange [0 /********** /********** /**********] /Contents <${'0'.repeat(PLACEHOLDER)}> >>`,
    ];
    let pdf = rawPdf(objs, '/Info << /Title (signed) >> /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>] ');
    let s = pdf.toString('latin1');
    const cStart = s.indexOf('/Contents <' + '0'.repeat(32)) + '/Contents '.length;
    const cEnd = cStart + PLACEHOLDER + 2;
    const br = `[0 ${cStart} ${cEnd} ${pdf.length - cEnd}]`;
    const brOld = '[0 /********** /********** /**********]';
    s = s.replace(brOld, br.padEnd(brOld.length, ' '));
    pdf = latin1(s);
    fs.writeFileSync(data, Buffer.concat([pdf.subarray(0, cStart), pdf.subarray(cEnd)]));
    execFileSync('openssl', ['cms', '-sign', '-binary', '-in', data, '-signer', cert, '-inkey', key, '-outform', 'DER', '-out', sig, '-md', 'sha256'], { stdio: 'pipe', env });
    const der = fs.readFileSync(sig).toString('hex').toUpperCase();
    if (der.length > PLACEHOLDER) throw new Error('signature larger than the placeholder');
    pdf.write(der.padEnd(PLACEHOLDER, '0'), cStart + 1, 'latin1');
    return pdf;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const out = oi >= 0 ? path.resolve(args[oi + 1]) : path.join(here, '..', '..', 'tests', 'fixtures', 'pdf');
  fs.mkdirSync(out, { recursive: true });
  const bytes = makeSigned();
  fs.writeFileSync(path.join(out, 'signed.pdf'), bytes);
  console.log('signed.pdf'.padEnd(22), String(bytes.length).padStart(9));
}

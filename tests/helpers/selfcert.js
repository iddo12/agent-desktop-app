// Test-only: a SHORT-LIVED ordinary TLS server certificate for "localhost" / 127.0.0.1, made in memory at test time.
// No key or certificate is ever written to the repository. Pure Node (crypto): an EC P-256 key, a minimal X.509 v3
// certificate (CA:FALSE, SAN DNS:localhost + IP:127.0.0.1, extKeyUsage serverAuth), self-signed with ECDSA-SHA256,
// valid from 1 hour ago for `days` (default 1).
"use strict";
const crypto = require("crypto");

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...x) => tlv(0x30, Buffer.concat(x));
const set = (...x) => tlv(0x31, Buffer.concat(x));
function oid(s) {
  const p = s.split(".").map(Number), out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) { const b = [v & 0x7f]; let n = v >> 7; while (n) { b.unshift((n & 0x7f) | 0x80); n >>= 7; } out.push(...b); }
  return tlv(0x06, Buffer.from(out));
}
function int(buf) { if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]); return tlv(0x02, buf); }
const utc = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const name = (cn) => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []), tlv(0x04, value));

function makeCert(opts) {
  const o = opts || {};
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"));                                  // ecdsa-with-SHA256
  const now = Date.now(), from = new Date(now - 3600e3), to = new Date(now + (o.days || 1) * 86400e3);
  const san = seq(tlv(0x82, Buffer.from("localhost")), tlv(0x87, Buffer.from([127, 0, 0, 1])));
  const exts = tlv(0xa3, seq(
    ext("2.5.29.19", true, seq()),                                                 // basicConstraints: CA:FALSE (empty sequence)
    ext("2.5.29.17", false, san),                                                  // subjectAltName
    ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),                        // extKeyUsage: serverAuth
  ));
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),                                              // v3
    int(crypto.randomBytes(12)),
    sigAlg, name("localhost"), seq(utc(from), utc(to)), name("localhost"),
    publicKey.export({ type: "spki", format: "der" }),
    exts,
  );
  const sig = crypto.sign("sha256", tbs, privateKey);                              // DER-encoded ECDSA signature
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const cert = "-----BEGIN CERTIFICATE-----\n" + der.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n") + "-----END CERTIFICATE-----\n";
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }), cert };
}
module.exports = { makeCert };

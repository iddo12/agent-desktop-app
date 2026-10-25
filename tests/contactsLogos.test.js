// logos.js: private addresses refused, images judged by their bytes, icon links picked, cache + miss marker, at most 3 fetches at once.
"use strict";
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const L = require("../src/contacts/logos");

for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) assert.ok(L.privateAddr(a), a + " must be refused");
for (const a of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.ok(!L.privateAddr(a), a + " is public");

assert.strictEqual(L.cleanHost("WWW.Aperture.com"), "aperture.com");
for (const bad of ["127.0.0.1", "localhost", "a b.com", "http://x.com", "x.com/path", "", null, "-x.com"]) assert.strictEqual(L.cleanHost(bad), null, String(bad));

assert.strictEqual(L.siteOf("shop.aperture.com"), "aperture.com"); assert.strictEqual(L.siteOf("www.firm.co.uk"), "firm.co.uk"); assert.notStrictEqual(L.siteOf("cdn.evil.net"), L.siteOf("aperture.com"));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
assert.strictEqual(L.sniff(png), "image/png");
assert.strictEqual(L.sniff(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>")), null, "svg refused");
assert.strictEqual(L.sniff(Buffer.from("<html>not an image</html>")), null);

const links = L.iconLinks('<link rel="icon" href="/f.png"><link rel="apple-touch-icon" href="a.png"><link rel="icon" href="x.svg"><link rel="stylesheet" href="s.css"><link rel="icon" href="data:image/png;base64,AA">', "https://aperture.com/shop/");
assert.deepStrictEqual(links, ["https://aperture.com/shop/a.png", "https://aperture.com/f.png"], "apple-touch-icon first; svg, data:, stylesheets dropped");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logos-"));
  let calls = 0, active = 0, peak = 0;
  const fetchIcon = async (host) => { calls++; active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return host === "nologo.com" ? null : png; };
  const lg = L.createLogos(path.join(dir, "logos"), { fetchIcon });
  const hosts = ["a.com", "b.com", "c.com", "d.com", "e.com", "nologo.com"];
  const res = await Promise.all(hosts.map((h) => lg.get(h)));
  assert.ok(res.slice(0, 5).every((u) => /^data:image\/png;base64,/.test(u)), "data URLs");
  assert.strictEqual(res[5], null); assert.strictEqual(calls, 6); assert.ok(peak <= 3, "at most 3 at once, saw " + peak);
  // second round: everything from disk, including the remembered miss
  const lg2 = L.createLogos(path.join(dir, "logos"), { fetchIcon }); const again = await Promise.all(hosts.map((h) => lg2.get(h)));
  assert.strictEqual(calls, 6, "nothing fetched twice"); assert.deepStrictEqual(again, res);
  // same host asked twice at once = one fetch
  const lg3 = L.createLogos(path.join(dir, "l3"), { fetchIcon }); await Promise.all([lg3.get("z.com"), lg3.get("www.z.com")]); assert.strictEqual(calls, 7);
  // junk host never fetches; a fetcher that throws gives null
  assert.strictEqual(await lg3.get("127.0.0.1"), null); assert.strictEqual(calls, 7);
  const lg4 = L.createLogos(path.join(dir, "l4"), { fetchIcon: async () => { throw new Error("x"); } }); assert.strictEqual(await lg4.get("boom.com"), null);
  // a cached non-image file is ignored
  fs.writeFileSync(path.join(dir, "logos", "evil.com.img"), "<html>");
  const lg5 = L.createLogos(path.join(dir, "logos"), { fetchIcon: async () => png }); assert.ok(/^data:image\/png/.test(await lg5.get("evil.com")), "bad cache entry is replaced by a fresh fetch");
  // the lookup guard blocks a private answer
  await new Promise((ok) => L.safeLookup("localhost", {}, (err) => { assert.ok(err && /blocked/.test(err.message), "localhost refused"); ok(); }));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("contactsLogos tests passed");
})().catch((e) => { console.error(e); process.exit(1); });

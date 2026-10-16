// Foreground-window probe for the load governor (v1.127.0): which program is in front, and is any "heavy" program running at all?
// One PowerShell call (hidden, 8 s timeout, never overlapping - the governor guards that). The compiled foreground lookup (Add-Type)
// only runs when a heavy program is actually running, so an idle PC pays for a plain process listing only. Windows only: elsewhere
// the probe answers { foreground: null } and the normal working cap applies. Heavy names are sanitised: nothing but a-z 0-9 space . _ ( ) + -.

"use strict";

const { execFile } = require("child_process");

function safeNames(list) {
  return (Array.isArray(list) ? list : []).map((x) => String(x || "").toLowerCase().replace(/\.exe$/, "").trim()).filter((x) => x && /^[a-z0-9 ._()+-]+$/.test(x)).slice(0, 30);
}

// The script. Names reach PowerShell through the environment variable AD_GOV_HEAVY (";"-separated), never inside the script text.
function buildScript() {
  return [
    "$ErrorActionPreference='Stop'",
    "$names=@($env:AD_GOV_HEAVY -split ';' | Where-Object { $_ })",
    "$run=@(Get-Process | Where-Object { $n=$_.ProcessName.ToLower(); $hit=$false; foreach($h in $names){ if($n.Contains($h)){ $hit=$true } }; $hit })",
    "if($run.Count -eq 0){ 'none|0'; exit }",
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class AdGovFg{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}'",
    "$p=[uint32]0; [void][AdGovFg]::GetWindowThreadProcessId([AdGovFg]::GetForegroundWindow(),[ref]$p)",
    "$f=''; try{ $f=(Get-Process -Id $p).ProcessName }catch{}",
    "($f + '|1')",
  ].join("\n");
}

// "Adobe Premiere Pro|1" -> { foreground: "Adobe Premiere Pro", heavyRunning: true };  "none|0" -> { foreground: null, heavyRunning: false }
function parseOutput(text) {
  const line = String(text || "").trim().split(/\r?\n/).pop() || "";
  const m = /^(.*)\|([01])$/.exec(line.trim());
  if (!m) return null;
  const name = m[1] && m[1] !== "none" ? m[1] : null;
  return { foreground: name, heavyRunning: m[2] === "1" };
}

function probe(heavyApps, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const names = safeNames(heavyApps);
    if ((o.platform || process.platform) !== "win32" || !names.length) return resolve({ foreground: null, heavyRunning: false });
    const enc = Buffer.from(buildScript(), "utf16le").toString("base64");
    const run = o.execFile || execFile;
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc], { windowsHide: true, timeout: 8000, env: Object.assign({}, process.env, { AD_GOV_HEAVY: names.join(";") }) }, (err, out) => {
      if (err) return reject(err);
      const r = parseOutput(out);
      if (!r) return reject(new Error("unreadable probe output"));
      resolve(r);
    });
  });
}

// v1.127.0 (review): a RESIDENT helper. Starting PowerShell and compiling the user32 type (csc.exe) on every probe cost 1-2 s of CPU exactly when a
// heavy app runs. The helper is started on the first probe, compiles the type once (only when a heavy program is really running), then answers
// one line per request ("names" -> "foreground|1" or "none|0") in a few ms. A request that takes over 8 s kills the helper (next probe starts a fresh one).
function buildLoopScript() {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "$loaded=$false",
    "while($true){",
    "  $line=[Console]::In.ReadLine(); if($null -eq $line){ break }",
    "  $names=@($line -split ';' | Where-Object { $_ })",
    "  $run=@(Get-Process | Where-Object { $n=$_.ProcessName.ToLower(); $hit=$false; foreach($h in $names){ if($n.Contains($h)){ $hit=$true } }; $hit })",
    "  if($run.Count -eq 0){ [Console]::Out.WriteLine('none|0'); [Console]::Out.Flush(); continue }",
    "  if(-not $loaded){ Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class AdGovFg{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}'; $loaded=$true }",
    "  $p=[uint32]0; [void][AdGovFg]::GetWindowThreadProcessId([AdGovFg]::GetForegroundWindow(),[ref]$p)",
    "  $f=''; try{ $f=(Get-Process -Id $p).ProcessName }catch{}",
    "  [Console]::Out.WriteLine($f + '|1'); [Console]::Out.Flush()",
    "}",
  ].join("\n");
}

function createPersistentProbe(opts) {
  const o = opts || {};
  const spawnFn = o.spawn || require("child_process").spawn;
  const platform = o.platform || process.platform;
  const timeoutMs = o.timeoutMs || 8000;
  let child = null, buf = "", pending = null;

  function kill() { const c = child; child = null; buf = ""; try { if (c) { c.stdin.end(); c.kill(); } } catch (e) { /* gone */ } }
  function fail(err) { const p = pending; pending = null; if (p) { clearTimeout(p.timer); p.reject(err); } }
  function ensure() {
    if (child) return child;
    const enc = Buffer.from(buildLoopScript(), "utf16le").toString("base64");
    const c = spawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    child = c; buf = "";
    c.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const p = pending; if (!p) continue;
        const r = parseOutput(line);
        pending = null; clearTimeout(p.timer);
        if (r) p.resolve(r); else p.reject(new Error("unreadable probe output"));
      }
    });
    c.on("exit", () => { if (child === c) { child = null; buf = ""; } fail(new Error("probe helper exited")); });
    c.on("error", (e) => { if (child === c) child = null; fail(e); });
    return c;
  }
  function probe(heavyApps) {
    return new Promise((resolve, reject) => {
      const names = safeNames(heavyApps);
      if (platform !== "win32" || !names.length) return resolve({ foreground: null, heavyRunning: false });
      if (pending) return reject(new Error("probe busy"));
      try {
        const c = ensure();
        const timer = setTimeout(() => { fail(new Error("probe timed out")); kill(); }, timeoutMs);
        pending = { resolve, reject, timer };
        c.stdin.write(names.join(";") + "\n");
      } catch (e) { fail(e); kill(); reject(e); }
    });
  }
  return { probe, close: kill };
}

module.exports = { createPersistentProbe, buildLoopScript, probe, parseOutput, buildScript, safeNames };

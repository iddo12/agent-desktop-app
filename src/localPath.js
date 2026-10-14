// v1.92.0 (review S2): is this a plain local drive-letter path that is safe to hand to fs?
// Registry entries are written by agents, so a link can be anything. A UNC path (\\host\share, //host/share) or a
// Win32 device path (\\?\..., \\.\...) makes fs.realpathSync / existsSync / statSync reach out over SMB: measured
// ~48 s of frozen main process for an unreachable host, and Windows sends the user's NTLM credentials to it.
// Callers check this BEFORE any fs call on a registry-supplied path.
function isPlainLocalPath(p) {
  if (typeof p !== "string" || !p || p.length > 1000) return false;
  if (/^[\\/]{2}/.test(p)) return false; // UNC and device paths (\\host, //host, \\?\, \\.\)
  if (!/^[A-Za-z]:[\\/]/.test(p)) return false; // must be absolute, drive-letter
  if (p.indexOf(":", 2) !== -1) return false; // alternate data streams / device syntax
  if (/[\0<>"|?*]/.test(p)) return false;
  return true;
}

module.exports = { isPlainLocalPath };

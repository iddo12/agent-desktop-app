// v1.136.1-pre: the Task List's "always continue to the next task, even after a handoff" switch, read from the files tasks.py writes
// (shared_tools/tasks/tasks.py): per agent <ws>/shared_reports/tasks/<agent folder name>.json -> settings.autoContinue, and global
// <ws>/shared_reports/task_list_settings.json -> autoContinue. Either one on = true. Default off. Pure and Electron-free; all I/O is injected.
// The workspace root is derived from the task tool's own path (<ws>/shared_tools/tasks/tasks.py), nothing is hard-coded.
// Fails CLOSED: any missing / unreadable / corrupt file or an unusable tasksTool path means false, and nothing here ever throws.
(function (root) {
  "use strict";
  const nodeFs = typeof require === "function" ? require("fs") : null;
  const TTL_MS = 15 * 1000;
  const cache = new Map(); // file -> { at, v }

  function sepOf(p) { return String(p).indexOf("\\") !== -1 ? "\\" : "/"; }
  function split(p) { return String(p).split(/[\\/]+/); }
  // <ws>/shared_tools/tasks/tasks.py -> <ws> (three levels up); null when the path is too short to have a workspace
  function workspaceOf(tasksTool) {
    if (!tasksTool || typeof tasksTool !== "string") return null;
    const parts = split(tasksTool);
    if (parts.length < 5) return null; // drive/root + ws + shared_tools + tasks + tasks.py at the very least
    return parts.slice(0, parts.length - 3).join(sepOf(tasksTool));
  }
  // the agent's FOLDER name (tasks.py names stores by it); accepts a full path with either slash style and trailing slashes
  function folderName(agent) {
    if (!agent || typeof agent !== "string") return null;
    const parts = split(agent).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }
  function readJson(fsImpl, file, now) {
    const hit = cache.get(file);
    if (hit && now - hit.at < TTL_MS && now >= hit.at) return hit.v;
    let v = null;
    try {
      let txt = fsImpl.readFileSync(file, "utf8");
      if (typeof txt !== "string") txt = String(txt);
      if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
      const d = JSON.parse(txt);
      v = d && typeof d === "object" && !Array.isArray(d) ? d : null;
    } catch (e) { v = null; }
    cache.set(file, { at: now, v });
    return v;
  }
  // opts: { tasksTool, agentName (folder name or full agent path), fsImpl, now (clock, ms) }
  function autoContinueFor(opts) {
    try {
      const o = opts || {};
      const ws = workspaceOf(o.tasksTool), name = folderName(o.agentName);
      if (!ws || !name) return false;
      const fsImpl = o.fsImpl || nodeFs;
      if (!fsImpl) return false;
      const now = typeof o.now === "function" ? o.now() : Date.now();
      const sep = sepOf(o.tasksTool);
      const glob = readJson(fsImpl, ws + sep + "shared_reports" + sep + "task_list_settings.json", now);
      if (glob && glob.autoContinue === true) return true;
      const store = readJson(fsImpl, ws + sep + "shared_reports" + sep + "tasks" + sep + name + ".json", now);
      return !!(store && store.settings && typeof store.settings === "object" && store.settings.autoContinue === true);
    } catch (e) { return false; }
  }
  function clearCache() { cache.clear(); }

  const api = { autoContinueFor, workspaceOf, folderName, clearCache, TTL_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TaskAutoContinue = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

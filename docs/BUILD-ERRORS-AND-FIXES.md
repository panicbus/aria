# ARIA — Build Errors and Fixes Log

This document summarizes the errors encountered during setup and the changes made so future builds (and AI assistants like Claude) take the current setup into account.

---

## 1. Initial Error: better-sqlite3 Native Build (Node 25)

**Symptom:**
```
npm error You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'
npm error gyp ERR! build error — Error: `make` failed with exit code 69
```

**Cause:** Node 25 was in use. `better-sqlite3` had no prebuilt binaries for Node 25, so it tried to compile from source. The build failed because the Xcode license had not been accepted (required for `node-gyp`/compiler on macOS).

**Fix attempted:** User accepted Xcode license (`sudo xcodebuild -license`).

---

## 2. Second Error: better-sqlite3 C++20 / V8 API (Node 25)

**Symptom:**
```
error: "C++20 or later required."
error: a non-type template parameter cannot have type 'ExternalPointerTagRange' (aka 'TagRange<ExternalPointerTag>') before C++20
error: unknown type name 'requires'
... (V8/Node 25 headers require C++20; better-sqlite3 was building with an older standard)
```

**Cause:** After accepting the license, the native addon compiled with an older C++ standard. Node 25’s V8 headers require C++20 and use APIs that don’t exist in C++17.

**Fix attempted:** Tried `CXXFLAGS="-std=c++20" npm install`. Build got further but then failed on **V8 API incompatibility**: `better-sqlite3` uses APIs removed/renamed in Node 25 (e.g. `CopyablePersistentTraits`, `AccessorGetterCallback`). **Conclusion: better-sqlite3 does not support Node 25.**

**Fix applied:** Switched to **Node 22** (LTS) so the project could use a supported Node version with better-sqlite3.

---

## 3. Third Error: better-sqlite3 libtool on Node 22

**Symptom:**
```
prebuild-install warn install No prebuilt binaries found (target=22.22.1 runtime=node arch=x64 libc= platform=darwin)
...
error: libtool: file: Release/obj.target/sqlite3/gen/sqlite3/sqlite3.o is not an object file (not allowed in a library)
make: *** [Release/sqlite3.a] Error 1
```

**Cause:** On Node 22.22.1 there were no prebuilt binaries, so `better-sqlite3` compiled from source. The build failed at the `libtool` step: `sqlite3.o` was rejected as “not an object file” (often due to a bad/corrupt or wrong-architecture object file, or toolchain quirk on macOS).

**Fix attempted:** Clean reinstall: removed `node_modules`, `package-lock.json`, and `~/Library/Caches/node-gyp/22.22.1`, then `npm install`. The same libtool error persisted.

**Fix applied:** **Replaced `better-sqlite3` with `sql.js`** so the project no longer depends on any native addon or node-gyp.

---

## 4. Fourth Error: Incomplete / Corrupt node_modules (yargs, rxjs)

**Symptom:**
```
Error: Cannot find module './build/index.cjs' — Require stack: .../yargs/index.cjs, .../concurrently/...
Error: Cannot find module '.../node_modules/rxjs/dist/cjs/index.js'
```

**Cause:** `node_modules` was in a bad state (e.g. interrupted installs, partial `rm -rf`). Packages like `yargs` and `rxjs` were missing built artifacts.

**Fix applied:** Full clean reinstall: remove `node_modules` and `package-lock.json`, then `npm install`. Using `npx rimraf node_modules` can avoid “Directory not empty” issues if `rm -rf node_modules` has trouble.

---

## 5. Fifth Error: Missing react and react-dom

**Symptom:**
```
[plugin:vite:import-analysis] Failed to resolve import "react/jsx-dev-runtime" from "src/main.tsx"
```

**Cause:** Only `@types/react` and `@types/react-dom` were in the project; the actual **`react`** and **`react-dom`** packages were not listed in `package.json`. Vite’s JSX transform needs `react` (which provides `react/jsx-dev-runtime`).

**Fix applied:** Added **`react`** and **`react-dom`** to `dependencies` in `package.json`.

---

## Summary of Package / Code Changes for Future Builds

### package.json

- **Removed:** `better-sqlite3`, `@types/better-sqlite3`
- **Added (dependencies):** `sql.js` (replaces better-sqlite3), `react`, `react-dom`
- **Engines:** Set to `"node": ">=18.0.0"` (no longer tied to Node 20/22 for native addons)

### Server (server/index.ts)

- **Database:** Switched from **better-sqlite3** to **sql.js** (pure JS/WASM, no native build).
  - Async startup: `initSqlJs()` then load `aria.db` from disk (or create new DB), run schema, then start Express.
  - Helpers: `execAll(sql)` for SELECTs (returns array of objects), `run(sql, params)` for INSERT/UPDATE/DELETE (returns `lastInsertRowid`), `saveDb()` to persist DB to `aria.db` after writes.
  - Same tables and behavior; only the DB driver and persistence pattern changed.

### README

- Removed the “Node 20/22 required” section (no longer needed).
- Noted that SQLite is now via **sql.js** (local file `aria.db`, no native build).

### Recommended setup for a clean machine

1. **Node:** Any current LTS (18 or 20 or 22) is fine; no need to avoid Node 25 for this project anymore.
2. **Install:**
   ```bash
   cd /path/to/aria
   rm -rf node_modules package-lock.json   # if doing a clean install
   npm install
   ```
3. **Run:**
   ```bash
   npm run dev
   ```

Future builds should assume: **sql.js** for SQLite (not better-sqlite3), **react** and **react-dom** as runtime dependencies, and **Node >= 18** with no special Node version or Xcode/node-gyp requirements for this project.

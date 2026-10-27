# Attribution & Third-Party Notices

`chroma-ae-mcp` borrows ideas, architectural patterns, and measured ExtendScript behaviors from two open-source reference implementations under the MIT License. Whole files have not been copied; specific mechanisms and discoveries have been adapted with attribution.

---

## 1. Engine-Room-Games/after-effects-mcp

### Ideas and Architecture Borrowed:
- **Measured AE 2026 & ExtendScript Behavioral Discoveries** (`reference/engine-room/docs/fragile-areas-ae.md`, `fragile-areas-bridge.md`):
  - *Single-Call Undo Groups*: An undo group opened in one `evalScript` and closed in another is discarded by After Effects, creating individual undo steps for every write. All mutations must begin and end in the same evalScript call.
  - *Read-Back Staleness*: Reading properties in the same script as a write returns stale cached values. Read-backs must be executed in a separate `evalScript` call.
  - *ExtendScript Chained Ternary Bug*: ExtendScript parses chained ternaries left-associatively (`a ? b : c ? d : e` evaluates as `((a ? b : c) ? d : e)`), silently returning incorrect values. Linter enforcement against chained ternaries.
  - *`saveFrameToPng` Asynchronous Caching*: `saveFrameToPng` returns before bytes are flushed to disk and can silently return stale image buffers from previous renders.
  - *`app.executeCommand` CEP No-Op*: `app.executeCommand` fails silently through CEP due to lack of focus; DOM methods must be used instead.
  - *`$.evalFile` Scope*: Evaluates into the caller's scope rather than the global scope.
- **Undo Group Counter and Wrapper** (`packages/jsx/core.jsx`):
  - `withUndo` pattern tracking a nesting counter so every mutation group cleanly closes even if exceptions occur.
- **Error Line Mapping** (`packages/jsx/raw.jsx`):
  - Measuring wrapped preamble length to accurately map ExtendScript error line numbers back to user-submitted code.
- **State Snapshots & Receipts** (`packages/jsx/snapshot.jsx`):
  - Taking before/after state diffs across mutations to return structured before/after receipts.
- **Bridge Client & Error Separation** (`packages/mcp-server/src/bridge/writeQueue.ts`, `httpClient.ts`):
  - Single-writer serialization queue for single-threaded ExtendScript.
  - Distinct categorization and recovery paths for `timeout`, `unreachable`, `queued`, and `auth` errors.
  - Loopback authentication: Generating a 32-byte hex token in `%LOCALAPPDATA%` / `~/Library/Application Support` with restricted file permissions and rejecting browser-origin requests.

### MIT License Notice:

```
MIT License

Copyright (c) 2026 Engine Room

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. JUNKDOGE-JOE/after-effects-mcp

### Ideas and Architecture Borrowed:
- **Never Abort In-Flight evalScript** (`plugin/host/jsx-bridge.js`):
  - Killing or timing out an in-flight `evalScript` wedges the ExtendScript bridge, preventing subsequent scripts from running until AE is restarted. The queue must block until AE finishes execution.
- **Drain-Sentinel Timeout Architecture** (`plugin/host/jsx-bridge.js`):
  - Using lightweight sentinel calls (`1+1`) to verify when the ExtendScript bridge has drained and is safe to accept new requests after slow or hanging evaluations.

### MIT License Notice:

```
MIT License

Copyright (c) 2026 ae-mcp contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

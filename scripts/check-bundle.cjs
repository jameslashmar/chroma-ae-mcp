// Runs the panel MCP bundle end to end against a fake AE. CI runs it under
// Node 17.7.2, the version AE 26 CEP panels use.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { createPanelMcp } = require(path.resolve(__dirname, '../panel/client/mcp-bundle.cjs'));
const seen = [];
const mcp = createPanelMcp({
  evalScript: async (script, label) => { seen.push(script); return { ok: true, result: { id: 1, name: 'Fake', numLayers: 0, layers: [] }, durationMs: 1 }; },
  dataDir: require('os').tmpdir(), log: () => {},
});
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => mcp.handleHttp(req, res, b)); }).listen(7798, '127.0.0.1', async () => {
  const post = (body, extra) => new Promise((ok) => { const r = http.request({ host: '127.0.0.1', port: 7798, method: 'POST', path: '/mcp', headers: Object.assign({ 'content-type': 'application/json' }, extra || {}) }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => ok([res.statusCode, d])); }); r.end(JSON.stringify(body)); });
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } } });
  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const call = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ae_get_comp', arguments: { comp_id: 1 } } });
  const legacyOk = init[0] === 200 && note[0] === 202 && JSON.parse(list[1]).result.tools.length >= 12 && call[0] === 200 && seen[0] === '__chromaAe.getComp({"comp_id":1})';
  console.log(legacyOk ? 'PASS' : 'FAIL', process.version, 'init', init[0], JSON.parse(init[1]).result.protocolVersion, '| notif', note[0], JSON.stringify(note[1]), '| tools', JSON.parse(list[1]).result.tools.length, '| call', call[0], JSON.parse(call[1]).result.content[0].text.slice(0, 40).replace(/\s+/g, ' '), '| script', seen[0]);

  // Revision 2026-07-28: no initialize, version and client in _meta, method and name mirrored in headers.
  const checks = [];
  const check = (name, cond) => { checks.push([name, !!cond]); };
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'check-bundle', version: '0' } };
  let n = 100;
  const modern = async (method, params, name) => {
    const body = { jsonrpc: '2.0', id: ++n, method, params: Object.assign({}, params, { _meta: meta }) };
    const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method };
    if (name !== undefined) headers['mcp-name'] = name;
    const r = await post(body, headers);
    return { status: r[0], json: JSON.parse(r[1]) };
  };
  let modernDetail = '';
  try {
    const disc = await modern('server/discover', {});
    check('discover 200', disc.status === 200);
    check('discover shape', disc.json.result.resultType === 'complete' && disc.json.result.supportedVersions[0] === '2026-07-28' && disc.json.result.capabilities.extensions['io.modelcontextprotocol/skills'] && disc.json.result._meta['io.modelcontextprotocol/serverInfo'].name === 'chroma-ae-mcp' && typeof disc.json.result.ttlMs === 'number');
    const skills = await modern('skills/list', {});
    const entries = skills.json.result && skills.json.result.skills;
    check('skills/list', skills.status === 200 && Array.isArray(entries) && entries.length > 0);
    const first = entries && entries[0];
    const got = await modern('skills/get', { uri: first.uri }, first.uri);
    check('skills/get', got.status === 200 && got.json.result.skill && got.json.result.skill.uri === first.uri);
    const read = await modern('resources/read', { uri: first.uri }, first.uri);
    const text = read.json.result.contents[0].text;
    const bytes = Buffer.from(text, 'utf8');
    const digest = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
    const listed = first.resources.filter((r) => r.uri === first.uri)[0];
    check('skill file digest', read.status === 200 && listed && listed.digest === digest && listed.size === bytes.length);
    const tcall = await modern('tools/call', { name: 'ae_get_comp', arguments: { comp_id: 1 } }, 'ae_get_comp');
    check('modern tools/call', tcall.status === 200 && tcall.json.result.resultType === 'complete' && seen[seen.length - 1] === '__chromaAe.getComp({"comp_id":1})');
    const noHeaders = await post({ jsonrpc: '2.0', id: 900, method: 'tools/list', params: { _meta: meta } });
    check('modern without headers is 400', noHeaders[0] === 400 && JSON.parse(noHeaders[1]).error.code === -32020);
    const ping = await modern('ping', {});
    check('modern ping is 404', ping.status === 404);
    modernDetail = checks.map((c) => c[0] + (c[1] ? ' ok' : ' FAIL')).join(', ');
  } catch (e) {
    check('modern round trip threw: ' + (e && e.message), false);
    modernDetail = String(e && e.message);
  }
  const modernOk = checks.length > 0 && checks.every((c) => c[1]);
  console.log(modernOk ? 'PASS' : 'FAIL', 'modern 2026-07-28 |', modernDetail);
  const ok = legacyOk && modernOk;
  srv.close();
  process.exitCode = ok ? 0 : 1;
});

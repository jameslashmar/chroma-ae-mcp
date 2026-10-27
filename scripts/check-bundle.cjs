// Runs the panel MCP bundle end to end against a fake AE. CI runs it under
// Node 17.7.2, the version AE 26 CEP panels use.
const http = require('http');
const path = require('path');
const { createPanelMcp } = require(path.resolve(__dirname, '../panel/client/mcp-bundle.cjs'));
const seen = [];
const mcp = createPanelMcp({
  evalScript: async (script, label) => { seen.push(script); return { ok: true, result: { id: 1, name: 'Fake', numLayers: 0, layers: [] }, durationMs: 1 }; },
  dataDir: require('os').tmpdir(), log: () => {},
});
const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => mcp.handleHttp(req, res, b)); }).listen(7798, '127.0.0.1', async () => {
  const post = (body) => new Promise((ok) => { const r = http.request({ host: '127.0.0.1', port: 7798, method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => ok([res.statusCode, d])); }); r.end(JSON.stringify(body)); });
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } } });
  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const call = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ae_get_comp', arguments: { comp_id: 1 } } });
  const ok = init[0] === 200 && note[0] === 202 && JSON.parse(list[1]).result.tools.length >= 12 && call[0] === 200 && seen[0] === '__chromaAe.getComp({"comp_id":1})';
  console.log(ok ? 'PASS' : 'FAIL', process.version, 'init', init[0], JSON.parse(init[1]).result.protocolVersion, '| notif', note[0], JSON.stringify(note[1]), '| tools', JSON.parse(list[1]).result.tools.length, '| call', call[0], JSON.parse(call[1]).result.content[0].text.slice(0, 40).replace(/\s+/g, ' '), '| script', seen[0]);
  srv.close();
  process.exitCode = ok ? 0 : 1;
});

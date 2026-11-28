# Skills over MCP

The MCP serves five Agent Skills as MCP skills, using the official Skills extension (`io.modelcontextprotocol/skills`, SEP-2640). A client that supports the extension lists them, loads them and reads their files. Claude Code does this (in public beta, on the setups listed below), so each skill shows up as a slash command.

This needs MCP revision 2026-07-28 or later. Clients on the older revisions do not see the skills (see below).

## What is served

| Skill | Folder | What it covers |
|---|---|---|
| `chroma-motion-director` | `server/guidance/motion-director/` | Motion direction from brief to delivery: timing, easing, choreography, type, sound and review (9 files) |
| `captions` | `server/guidance/captions/` | Captions and subtitles to a published standard: chunking, timing, line breaks, QA and export (9 files) |
| `ae-extendscript` | `server/guidance/ae-extendscript/` | Writing ExtendScript for `ae_run_jsx` and saved skills: ES3 rules, undo groups, read-back, the safety lint |
| `ae-live-session` | `server/guidance/ae-live-session/` | Working in After Effects beside a person editing live: inspect first, checkpoints, idempotency keys, busy and Stop, popups, renders, saving |
| `ae-fonts` | `server/guidance/ae-fonts/` | The `ae_fonts` tool, missing-font substitution, and the "Unknown BIB Error. cannot access font" and "ATM Parse Error" warnings |

The skill text is compiled into the server (`server/src/guidance/content.generated.ts`). Nothing is read from disk at run time, so a new panel version brings new skill text with no change on the client.

The first two skills were already served as MCP prompts and resources. The three `ae-*` skills are served only as MCP skills.

## How Claude Code uses them

- Claude Code 2.1.331 or later is needed. Skills over MCP are in public beta.
- The server must be on revision 2026-07-28 or later, over HTTP or stdio.
- With the server registered as `chroma-ae` (the panel's **Copy setup command** does that), the skills appear as `/chroma-ae:chroma-motion-director`, `/chroma-ae:captions`, `/chroma-ae:ae-extendscript`, `/chroma-ae:ae-live-session` and `/chroma-ae:ae-fonts`.
- Type `/` or run `/skills` to see them. Claude can also load a skill on its own when the task matches the skill's description.
- In auto mode Claude Code loads skills without a prompt. In manual mode it asks. "Allow this version" lasts until the skill's files change.
- A server can offer at most 100 skills.
- Claude Code's own conditions apply (its MCP docs, "Where MCP skills are supported"): a recent model (a Fable model, or Claude Opus 4.8, Sonnet 5, Haiku 5.5 or later) and a direct connection to Anthropic with feature-flag fetching on. MCP skills do not work in `claude -p`, the Agent SDK, GitHub Actions, cloud sessions or `claude remote-control` server mode. On a Team or Enterprise plan signed in with `/login` they are off until the organisation turns them on; with an API key or a Console login they are still rolling out.
- Skills that Anthropic scans (some connectors) are limited to 100 KB per text file and 400 KB per skill. This server's largest skill, `chroma-motion-director`, is about 49 KB in all.
- If skills are missing, run `claude --debug=mcp`, or open the server's `/mcp` page and check the Protocol row.
- Do not force Claude Code to the old protocol. Setting `MCP_SDK_GENERATION=v1` or `MCP_PROTOCOL_NEGOTIATION=legacy` turns skills off.

## Clients without MCP skills

| Client | What it gets |
|---|---|
| Claude Desktop chat (Chat and Cowork) | The MCP prompts and resources only |
| Servers from `claude_desktop_config.json` in the Desktop app | The MCP prompts and resources only |
| Cursor and Codex, through the stdio relay | The MCP prompts and resources, unless the client speaks 2026-07-28 and implements the extension |

The prompts (`motion_director`, `motion_review`, `captions`) and resources (`chroma-ae://guidance/motion-director/...`, `chroma-ae://guidance/captions/...`) work as before. The three `ae-*` skills are not available to these clients.

## The protocol in brief

Under 2026-07-28 there is no `initialize`. Each request carries the protocol version and the client's capabilities in `_meta`. The HTTP endpoint (`http://127.0.0.1:7790/mcp`) and the stdio relay both serve this.

1. **`server/discover`** lists the supported versions (2026-07-28, 2025-06-18, 2025-03-26 and 2024-11-05), the capabilities (tools, prompts, resources and `extensions: { "io.modelcontextprotocol/skills": {} }`) and the server information. Every result carries `resultType: "complete"` and the server information in `_meta`.
2. **`skills/list`** returns each skill's SKILL.md frontmatter, unchanged, and a manifest of every file with a `sha256:` digest and a byte size.
3. **`skills/get`** returns one skill and its manifest.
4. **`resources/read`** on `skill://<skill-name>/<path>` returns each file. There is no `resources/directory/read`.
5. **`resources/list`** under 2026-07-28 lists the skill files (`skill://...`; each `SKILL.md` is named and described from its frontmatter) instead of the `chroma-ae://guidance/...` resources, so the same text is not listed twice. The older revisions keep the guidance resources, and `resources/read` still answers `chroma-ae://guidance/...` under 2026-07-28 too.

Caching:

- Cacheable results carry `ttlMs` (300000, five minutes) and `cacheScope`. `private` applies to `server/discover` and `tools/list`, which depend on the `X-Chroma-Toolset` header. `public` applies to the rest.
- Digests let a client check whether a cached file is still current.

Errors:

- Resource not found is -32602.
- An unsupported version is -32022, with the supported list.
- A bad or missing `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` header is HTTP 400 with -32020.
- A method that revision does not have (`initialize`, `ping`, `logging/setLevel`) is HTTP 404 with -32601.
- A 2026-07-28 request inside a JSON-RPC batch is refused (HTTP 400, -32600): that revision has no batches.

There are no sessions. The toolset still comes from the `X-Chroma-Toolset` header: `core` by default, `full` on request.

**Offline.** The stdio relay passes 2026-07-28 requests to the panel with the headers it checks. While After Effects is closed it answers `server/discover`, the list calls, `skills/list`, `skills/get` and skill-file reads from its own caches in the data dir: `relay-skills-cache.json` (the skill entries and every file they list, fetched the first time the panel answers `skills/list`) and `relay-resources-modern-cache.json` (the 2026-07-28 `resources/list`), beside the caches it already kept. Offline answers carry `ttlMs` 0.

**Questions and cancellation.** A 2026-07-28 client never gets elicitation requests, because that revision has no server-initiated requests. `ae_ask_user` and popups ask in the panel instead. Closing the connection cancels a 2026-07-28 `tools/call` at its next safe point. An eval already sent to After Effects always finishes.

## Adding or changing a skill

1. Put the skill in `server/guidance/<name>/SKILL.md`, with the folder named after the skill. A skill is served under its frontmatter `name` whatever the folder is called (`motion-director/` is served as `chroma-motion-director`), and names must be unique. Put longer material in `references/*.md`. Only `.md` files are shipped; other files in the folder are ignored.
2. Write the frontmatter as portable YAML:
   - `name`: lowercase letters, digits and single hyphens, at most 64 characters.
   - `description`: at most 1024 characters, saying when to load the skill. Quote it in double quotes.
   - `metadata` (optional): a map of quoted strings.
   - Quote any value a strict YAML parser would read as something else: a value with `: ` in it, `true`, `yes`, `null`, numbers, dates such as `2026-11-28`, or versions such as `1.0.0`.
3. Write relative references against the skill root, the folder that holds SKILL.md. Use `references/spec.md`, not `spec.md`, even from inside `references/`.
4. From the repo root, run `node scripts/sync-guidance.mjs`. It validates names, descriptions, the 512-file limit and the 16 MiB limit, then regenerates `server/src/guidance/content.generated.ts`. It records each file's text, SHA-256 and size.
5. Two skills are copied from outside the repo, `chroma-motion-director` (from `CHROMA_MOTION_SKILL_DIR`) and `captions` (from `CHROMA_CAPTIONS_SKILL_DIR`). To keep the committed copies, point those variables at a folder that does not exist.
6. When copying upstream, the sync script quotes any frontmatter value that is not portable and logs it.
7. Run the tests and bundle the panel:

```
cd server && npm test && npm run bundle
```

Commit `panel/client/mcp-bundle.cjs` with the skill change.

The tests are `server/test/guidance.test.ts` (the compiled copy matches the source), `server/test/mcp-skills-data.test.ts` (digests, sizes, frontmatter, names and relative references) and `server/test/mcp-modern.test.ts` (the 2026-07-28 rules).

Skills update with the server. In manual mode, Claude Code asks again after a skill's files change, because "Allow this version" lasts only until then.

# Proactive mode

## Goal
The assistant speaks up on its own at key moments (even levels, new zones, dungeons, profession milestones, talents) with a short, actionable tip. Each trigger is a switch in the **desktop app window** (next to "web search"), default OFF (master switch + per-trigger).

## Architecture
- **Addon (Lua) detects + asks**: events fire in-game, addon builds a question and sends it through the existing `Core:Ask` pipeline (voice/strip). Sent with `extra.proactive = {kind, key}` and a `silent` option (no `ui:Show()`, no focus steal).
- **App (JS) owns settings**: new `cfg.proactive` (config.js DEFAULTS), toggled via controller.js/server.js/ui.html like `webSearch`. Published to the game in the inbox `extra` (`inbox.proactive = {...}`), so the addon reads it in `Core:ApplyInbox` and caches in `ns.db.proactive`. Addon fires nothing until it has received settings (no wasted sends when off).
- **App also guards**: `handleRequest` drops requests with `proactive.kind` that is disabled (settings race safety).
- **Answers** land in a dedicated chat "Proactive tips" (created on demand, not the player's open chat), shown via existing `Notify` card + unread dot. History from the player's other chats is not sent.

## Triggers (first version)
| kind | When | Question sent (en/es in Locale.lua) |
|---|---|---|
| `level` | `PLAYER_LEVEL_UP`, new level is even (and ≥2; optional "every 5/10 only" choice) | "We've hit level N. What are the crucial things to do at this level? Class quest, important class ability to learn, a new dungeon to learn, or an item that significantly boosts attributes." |
| `zone` | `ZONE_CHANGED_NEW_AREA` into a zone not seen before by this character AND level within zone's level range (min-?..max+?) AND not just passing through | "We've entered ZONE at level N. What are important quests to pick up? Like ones that give an upgraded item." |
| `dungeon` | `PLAYER_ENTERING_WORLD` / `ZONE_CHANGED_NEW_AREA` with `IsInInstance()` party/raid, first time per instance | "We entered DUNGEON at level N. Boss tips, notable drops for my class, quests tied to it." |
| `profession` | `SKILL_LINES_CHANGED`: a profession crosses a milestone (75/150/225/300…), or new profession learned | "My PROFESSION hit X. What should I craft/train/farm next?" |
| `talents` | `CHARACTER_POINTS_CHANGED` with unspent points (talent or trainer spells available at level up) | "I have N unspent talent points / new trainer skills. What do you recommend for my class/spec?" |

Zone level range: addon needs data. Use the built-in guide (`knowledge-builtin/wow-forever.md`) — app side can decide: addon sends zone + level; app/AI judges; but to avoid waste the addon gates locally using `C_Map`/a small static zone-range table (`ZoneLevels.lua`, ~100 zones, Forever-specific; unknown zones → fall back to "min level ≤ char level ≤ min+ ~10 via map level API if available, else skip"). Decision for impl: static table, unknown zone → skip.

## Anti-spam / safety rules
- Per-character de-dupe store `ns.db.chars[key].proactive.seen` (`level:10`, `zone:The Barrens`, `dungeon:…`) so reloads/relogs never repeat.
- Not in combat, not dead, not on taxi, not in loading screen: queue and flush when clear (after ~3 s settle).
- Global cooldown (default 3 min) between proactive asks; queue max 3, drop oldest; level-up has priority.
- Skip if `Core.working` / `Uplink.busy` → retry later; never interrupt a player's own question.
- Not when app isn't running (Live status says no app) — don't queue stale tips.
- Level up while max level / above trivial: skip levels >= max level.
- Optional "quiet in instances/BGs" for non-dungeon triggers.

## Prompt side (companion/src/prompt.js)
When `req.proactive` is present, append a short system block: reply ≤ ~120 words, bulleted, 3–5 items max, name the quest/NPC/zone/coordinates when known, say "I'm not sure" rather than invent, use character JSON (class, quests done, gear) to personalise, skip things already done, stay in persona.

## Todos
1. config-proactive — DEFAULTS `proactive` (enabled, level, zone, dungeon, profession, talents, cooldownMin), migrate/validate in config.js.
2. app-ui — switches in ui.html (master + per trigger), controller/server endpoints, i18n en/es strings.
3. publish-settings — include `proactive` in inbox extra (watcher/controller publish on change and each answer); test in roundtrip/companion tests.
4. app-guard-prompt — drop disabled kinds in `handleRequest`; proactive prompt block in prompt.js; tests (prompt.test/send.test).
5. addon-settings — read `inbox.proactive` in Core:ApplyInbox into `ns.db.proactive`; `Core:Ask(..., {silent=true})` skipping `ns.UI:Show()`; dedicated "Proactive tips" chat in Chats.lua.
6. addon-proactive-module — new `Proactive.lua` (add to .toc): event handlers, de-dupe, queue, cooldown, safety gates, question builders; `ZoneLevels.lua` table.
7. locale — en/es question texts and chat title in Locale.lua.
8. slash-and-docs — `/ai proactive` status/toggle-off locally (kill switch), README section + FAQ, CHANGELOG/version bump if present.
9. tests — Node tests for config/inbox/prompt/guard; Lua gating logic kept pure (testable with `lua` if available) else manual in-game checklist.

## Open decisions (defaults chosen unless you say otherwise)
- Default OFF; level trigger = every even level; cooldown 3 min; tips go to a separate chat.

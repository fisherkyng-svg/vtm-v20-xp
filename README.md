# VtM V20 XP Tracker (`vtm-v20-xp`) v0.2.0

Award, spend, and audit experience for the **Vampire: The Masquerade V20** Foundry system (`vtm-v20` ≥ 1.1.5, Foundry v13–14).

## Install

1. In Foundry Setup, go to **Add-on Modules → Install Module** and paste this into **Manifest URL**:
   `https://github.com/fisherkyng-svg/vtm-v20-xp/releases/latest/download/module.json`
2. Launch the world, then go to **Game Settings → Manage Modules** and enable **VtM V20 XP Tracker**.

## How it works

| Who | What |
|---|---|
| **Storyteller** | **Award XP** from the Actors sidebar header (party-wide) or from the sheet's Experience block (one character). Negative amounts correct mistakes. |
| **Player** | **Spend** from the sheet. The dialog lists every trait with its V20 cost, and greys out anything unaffordable or over its cap. |
| **Everyone** | **Ledger** shows every award and purchase, plus an audit against the baseline. |

### Finalizing a character

After character creation, **lock the sheet** with the system's padlock icon, or click **Ledger → Finalize**. That snapshot becomes the baseline. From then on:

- Players can't type in Unspent or Total.
- Players can't click dots, edit Discipline, Path, Background, or Merit ratings, or drag in or delete those item types. Weapons, gear, and pools such as blood, willpower spent, and health still work normally.
- The only ways to raise a trait are **Spend XP** or the Storyteller.

If you unlock a sheet, edit it, and lock it again, the module asks whether to accept your edits as the new baseline.

### Costs (V20)

| Trait | Cost |
|---|---|
| Attribute | current × 4 |
| Ability | new 3 · current × 2 |
| Discipline | new 10 · clan current × 5 · out-of-clan current × 7 · Caitiff/Pander current × 6 |
| Secondary path | new 7 · current × 4 (can't exceed the primary path) |
| Virtue | current × 2 |
| Humanity / Path | current × 2 |
| Willpower | current × 1 |
| Ritual | **No XP.** Learned in play from a teacher or tome; the Storyteller adds the item. |

- **Trait caps** come from the system's generation table, so a 7th generation character can go to 6.
- **In-clan** status uses world Clan items first, then the system's built-in list. A Baali world Clan item listing Daimoinon makes Daimoinon in-clan.
- **Primary path** rises automatically when you buy Thaumaturgy or Necromancy. The auto-pick is the highest-rated path in that category.
- **Overrides:** the Storyteller can override in-clan status per Discipline (for example, the Additional Discipline merit) and choose the primary path under **Ledger → Storyteller: cost overrides**.
- **Catalog:** new Disciplines and Paths come from world Items plus the system compendiums. World items take precedence.
- **Rituals** are Storyteller-granted. Players can't add them to a locked sheet, and the audit ignores them, so a granted ritual never shows as drift. Buying the first dot of Thaumaturgy posts a reminder to add the primary path and the free Level One ritual.

### Elder Disciplines (needs VtM V20 Powers)

This feature is off by default. Turn on **Players can buy Elder Discipline levels** in the module settings.

- **Dot 6+.** Each purchase includes **one power of the new level**, chosen from the Storyteller's Elder Power library (world items). The Spend list shows one entry per available power, e.g. *Dominate 5 → 6 + Mass Mesmerize · 25 XP*. If the library has no power at that level, the dot is blocked.
- **Extra powers.** Additional powers at a level already reached appear under **New Elder Powers**, at the same cost as buying that dot again. For in-clan Dominate at level 6, that's 25 XP.
- **Generation.** Generation caps still apply. Dot 6 needs 7th generation or lower.
- **Locked sheets.** Players can't drag Elder powers onto locked sheets.
- **Audit and undo.** The audit tracks Elder powers. Undo removes the power along with the dot.

### Undo

**Ledger → Undo last** (Storyteller only) reverses the most recent award or purchase. It refunds XP, restores the old rating, and deletes the item if the purchase created one.

## Limits

- **Guards run in the player's browser.** Foundry gives modules no server-side hooks, so a player who disables the module or uses the console can get past them. The audit is the backstop: it flags any change that isn't in the ledger.
- **Not covered:** Backgrounds and Merits/Flaws can't be bought with XP. The Storyteller adds them.
- **No auto primary path or starting ritual:** the Storyteller adds them when a character first learns Thaumaturgy (path + one Level One ritual) or Necromancy (path). The chat card reminds you.
- **Fragile sheet buttons:** the sheet buttons attach to the system's `.exp-fields` block. If a system update renames it, the buttons disappear but nothing breaks. Use the macro API below in the meantime.

## Macro API

```js
const xp = game.modules.get('vtm-v20-xp').api;
xp.openAward();                         // GM: party award dialog
xp.openSpend(actor);                    // spend dialog for an actor
xp.openLedger(actor);                   // ledger + audit
xp.award([actor], 3, 'Session 5');      // GM: award directly
xp.audit(actor);                        // { drift: [...] }
```

## Development

`scripts/logic.mjs` is pure rules logic. To run the unit tests and the mock-Foundry integration tests:

```
node --test test/logic.test.mjs test/integration.test.mjs
```

## Releasing

Bump `version` in `module.json` and push to `main`. The Release workflow runs the tests, tags `v<version>`, stamps the manifest and download URLs, and publishes `module.json` plus `vtm-v20-xp.zip`. Pushing the same version twice does nothing. Foundry picks up new versions under **Manage Modules → Check for Updates**.

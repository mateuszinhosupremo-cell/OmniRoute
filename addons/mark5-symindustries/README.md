# Mark V — Sym Industries v2.0 (Minecraft Bedrock)

Addon da armadura Mark V (Homem de Ferro) com maleta e montagem cinematográfica, agora com HUD
tecnológico, sistema de energia, voo, scanners e mira teleguiada.

**Instalar:** abra `dist/Mark5_SymIndustries_v2.mcaddon` no Minecraft (Bedrock 1.26+) e ative os
dois pacotes (Comportamento + Recursos) no mundo.

## Controles

| Ação | Como |
| --- | --- |
| Vestir a armadura | Use a **Maleta Mark V** (agachado + usar = colocar no chão e pisar nela) |
| Painel de controle | Use o **Reator Arc** (visor, HUD, voo, scanner, mira, diagnóstico, desmontar) |
| Abrir/fechar visor | Agachado + usar o Reator Arc (gasta 1% de energia; sem energia = manual) |
| Voar / pousar | Toque duplo no **pular** |
| Subir / descer em voo | Segurar pular / agachar |
| Turbo (voo deitado) | Correr para frente durante o voo |
| Scanner de área | Olhar para cima + toque duplo no **agachar** |
| Mira teleguiada | Ative no painel; mire num alvo até travar |
| Tirar a armadura | Olhar para baixo + toque duplo no agachar (no chão) ou pelo painel |

## Energia

A energia do reator recarrega sempre (com a armadura vestida ou guardada). HUD, LEDs (olhos,
reator do peito, braços e pernas), voo, scanner, mira e servos do visor consomem energia. Sem
energia os LEDs apagam com som de desligamento, o HUD desliga, o voo para e a proteção cai; com
15% a armadura reinicia sozinha.

## Para desenvolvedores

- `pack/` — código-fonte dos pacotes (BP + RP). `tools/package.sh` gera o `.mcaddon`.
- `SPEC.md` — especificação completa; `tools/hud_protocol.json` — protocolo de dados do HUD.
- Mísseis futuros: use a API exportada por `pack/Mark5_BP/scripts/suit/targeting.js`
  (`getLockedTarget`, `onTargetLocked`, `onTargetLost`) ou os script events
  `sym:mk5_target_locked` / `sym:mk5_target_lost` / `sym:mk5_lock_query`.
- Testes: `sh tests/typecheck/run.sh` (requer `npm i` em `tests/typecheck`),
  `node --test tests/script_pure.test.mjs`,
  `node --import ./tests/script_mock/register.mjs --test tests/script_smoke.test.mjs`,
  `node --test tests/hud_ui_decode.test.mjs`, `python3 tests/suit_validate.py`,
  `python3 tests/fx_assets_test.py`, `python3 tools/check_refs.py pack`.
